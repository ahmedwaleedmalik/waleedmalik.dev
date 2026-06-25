---
title: "Self-hosted LLM-as-a-Service: virtual keys, budgets, and a coding assistant on your own GPUs"
description: "Field notes from a self-hosted LLM inference platform on Kubernetes: the tenant edge"
pubDate: 2026-06-23
canonical: "https://waleedmalik.dev/blog/self-hosted-llmaas"
tags: ["kubernetes", "llm-infra", "litellm"]
draft: false
---

There's a step everyone building on open models skips, and it's the one that turns "I serve a model"
into "I offer a service." Serving is solved: vLLM behind an OpenAI-compatible API is an afternoon's
work. What's not solved, and barely documented, is the layer above. *Who* is allowed to call it,
*how much* have they spent, and *what happens* when they hit their cap. That's the difference between
a chat box and a platform, and it's where this post lives.

This is the product story from building a self-hosted LLM inference platform: turning the stack into
something you can hand other people keys to. The GPU substrate and routing details matter, but this
is the layer where a model server becomes a service.

The concrete goal: a coding assistant, IDE chat *and* autocomplete, running on my own GPUs, metered
per developer, on a single ~$0.33/hr spot L4. Not a frontier model; a real one you'd actually use.
I could not find a public Kubernetes reference that combined these pieces in one runnable stack. So I
built the version I wanted to read. Three things bit, and all three are things the tutorials get
wrong or omit.

## The layering nobody states plainly

The first mistake is upstream of any code: thinking you need to *pick* an AI gateway. You don't. Two
different gateways do two different jobs, and a real LLMaaS stacks both.

- **LiteLLM is a control plane for economics.** It answers: which tenant is this, which model alias
  do they want, which upstream provider serves it, and how many dollars did that cost? Virtual keys,
  per-key budgets, TPM/RPM limits, a spend ledger. It does *not* know or care which of your N
  identical GPU pods is least loaded.
- **Gateway API Inference Extension (GIE) is a data plane for inference-aware routing.** It answers:
  of the N identical vLLM replicas behind this pool, which one has KV-cache headroom and the
  shortest queue *right now*? It does not know what a "tenant" or a "budget" is.

Most "AI gateway" write-ups present these as competitors and pick one. They're different layers. You
want LiteLLM facing your tenants and GIE behind it facing your GPU pods, the dollar question and the
which-pod question answered independently. (In this lab the coder models are single-replica, so GIE
sits idle behind them for now; the point is the boundary is in the right place for when they aren't.)

![Two gateways, two questions. LiteLLM owns economics (which tenant, how many dollars); GIE owns inference-aware routing (which of N identical pods). The boundary is the design.](/assets/llmaas-two-layers.svg)

A reasonable objection: why LiteLLM and not the CNCF-native **Envoy AI Gateway**, especially now
that [Envoy AI Gateway 1.0 is GA](https://aigateway.envoyproxy.io/release-notes/v1.0/)? Because the
tenancy model I need first is not just route-level multi-tenancy or token quota. It is a
tenant-facing API-key product: [virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys),
model allowlists, per-key dollar budgets, budget windows, and a spend ledger operators can hand to
humans. LiteLLM already has that workflow.

Envoy AI Gateway is still the better Kubernetes-native data-plane bet: stable CRDs, provider
normalization, MCP routing, quota-aware routing, and GIE integration. I expect it to matter more over
time. But for this first public iteration, LiteLLM owns the customer-facing economics layer and the
gateway behind it owns routing. The question is not "which AI gateway wins?" It is "which layer is
answering which question?"

## The FIM trap: the endpoint that silently corrupts your completions

A coding assistant is two models, not one. Chat (the sidebar) is an instruct model over
`/v1/chat/completions`. Autocomplete is **fill-in-the-middle (FIM)**, and FIM is where toy demos
break, quietly, because the failure looks like "the model is just bad at completion."

FIM works by feeding the model the code *before* and *after* the cursor, wrapped in special control
tokens, and asking it to produce the middle. For Qwen2.5-Coder that's:

```
<|fim_prefix|>def add(a, b):
    return <|fim_suffix|>
<|fim_middle|>
```

The trap: **you must send this to `/v1/completions`, never `/v1/chat/completions`.** The chat
endpoint runs `apply_chat_template` over your input, which wraps it in the model's chat scaffolding
(`<|im_start|>user...`) and mangles the FIM tokens into garbage. You get a 200 and plausible-looking
text, so nothing errors. The completions are just subtly wrong, and you waste an afternoon blaming
the model. Two more sharp edges: the FIM tokens **differ per model family** (Qwen's are not
DeepSeek's), and you want the **base** model, not the instruct one, because instruct-tuning teaches
the model to chat, which interferes with raw infilling.

Validated on the served 1.5B base model, raw `/v1/completions`:

```
prompt:     <|fim_prefix|>def add(a, b):\n    return <|fim_suffix|>\n<|fim_middle|>
completion: a + b
```

Correct middle, no chat scaffolding. The serving topology that falls out: the IDE talks to Tabby (the
completion server), Tabby calls the gateway as a `vllm/completion` backend, and the gateway routes to
the FIM model. So the virtual key meters Tabby to vLLM, exactly where the cost is.

## Metering that's real, from the ledger

Here's the part that makes it a *service*. Each client gets a virtual key, scoped to the models it's
allowed to touch and capped with a dollar budget:

```bash
curl -X POST $LITELLM/key/generate -H "Authorization: Bearer $MASTER" \
  -d '{"key_alias":"open-webui","models":["coder-chat","coder-fim","embeddings"],
       "max_budget":5.0,"budget_duration":"30d"}'
```

The chat front-end gets one key (chat + FIM + embeddings); the autocomplete server gets a narrower
one (FIM + embeddings only). The model list each key sees is enforced server-side: ask the gateway
for `/models` with the chat key and you get exactly its three aliases, no more. After a HumanEval run
plus smoke traffic, the spend ledger reads back per key:

```
open-webui  spend $0.003970 / budget $5.00   models [coder-chat, coder-fim, embeddings]
tabby       spend $0.000035 / budget $5.00   models [coder-fim, embeddings]
```

Those dollar figures only exist because each self-hosted model has an explicit `input_cost_per_token`
/ `output_cost_per_token` in the config. This is the non-obvious bit: a self-hosted model has **no
default price**, so if you skip it, every call costs $0 and your budgets never bind. Set the price to
your GPU amortization, and then budgets and the 429-on-overage actually work.

For dashboards, LiteLLM can expose useful [Prometheus metrics](https://docs.litellm.ai/docs/proxy/prometheus):
spend, tokens, virtual-key budgets, team budgets, and rate-limit state. I still prefer the database
ledger for the spend dashboard. LiteLLM already writes every request to its Postgres
`LiteLLM_SpendLogs` table. Point a **read-only Grafana datasource** at that table (here, a
CloudNativePG cluster) and you get durable spend-by-key, spend-over-time, and tokens-per-model
without depending on metric cardinality or scrape retention. The thing that makes it "as-a-service"
instead of "a chat box" is sitting in the database you already run.

![Spend by virtual key, read straight from the LiteLLM SpendLogs table in Postgres via a read-only Grafana datasource. Per-key dollar spend against budget, backed by the durable request ledger.](/assets/litellm-spend-budgets.png)

## The agentic tier: it works, and two things bite

A third model handles agentic coding: tool-calling, multi-step edits (Cline, opencode). I ran one
through a budgeted key: a coding agent that, given "what does `add()` return?", **autonomously called
`list_files`, then `read_file("utils.py")`, then answered correctly.** A real two-step tool loop,
metered. That works. Two things bit on the way, and both are the kind nobody writes down.

**First, the host RAM, not the GPU, caps your model size.** I wanted the 32B-4bit tier (the size
where tool-calling gets genuinely reliable). It OOM-killed on load, five crash-loops, and the reason
isn't VRAM. vLLM stages the 18 GB of weights *through host RAM*, and the L4 node was a
`g2-standard-4` with only 16 GB. The GPU had room; the host didn't. The fix is a bigger-RAM host
(`g2-standard-8`), not a bigger GPU, a distinction that's invisible until you hit it. I dropped to a
**14B-AWQ** (~9 GB), which loads clean and still does multi-step tool use.

**Second, small-model tool-calling is unreliable in a way that looks like it's working.** With
`--enable-auto-tool-choice --tool-call-parser hermes`, the 14B on `tool_choice:auto` emitted its tool
call as **free-form text**: `<tools>{...}</tools>` one run, a fenced JSON block the next, never the
`<tool_call>` tag the hermes parser actually scans for. So vLLM returned *empty* `tool_calls` and the
"call" sailed through as a plain assistant message. You get a 200 and reasonable-looking text; the
agent loop just never fires. Flip to `tool_choice:"required"` and vLLM's guided decoding forces a
correctly-structured call every time, which proves the model *can* and that the gap is serialization,
not capability. The production-clean fix is mounting the proper Qwen2.5 tool chat-template so `auto`
emits the right tag. This is the FIM trap's cousin: the endpoint returns success while silently doing
the wrong thing.

**One GPU, one model.** The single L4 means I validate chat, FIM, and agent *serially*: each claims
the whole GPU (memory, not compute, so time-slicing doesn't rescue co-residency). Running them
concurrently is more GPUs or a bigger card, not a config flag. That's an honest lab constraint, not a
design limit.

## Honest cost and limits

One L4: ~$0.71/hr on-demand, ~$0.33/hr spot. Single-stream throughput ~30 to 40 tok/s. The AWQ/GPTQ
Marlin kernels are worth about 11x over the naive quantized path; without them a 7B is unpleasant on
an L4, and with them the 16k-context chat model fits with room for the KV cache. It is not a frontier
model and it will not feel like one. But it's *yours*, it's metered, and the whole thing idles at $0
because the GPU Deployments scale to zero when no one's coding.

The pass@1 on a HumanEval subset came back at 18/20 (90%), in line with the model's published score:
a cheap gate that proves the deployment didn't silently degrade the weights (wrong quantization,
truncated context, a botched chat template). Worth wiring in. It's the difference between "it returns
200" and "it returns *correct* code."

## The punchline

The artifact I wanted to read, a LiteLLM-on-Kubernetes coding/LLMaaS stack with virtual keys,
per-key dollar budgets, and a spend dashboard, fronting a real coder model with working FIM, now
exists. The lessons aren't about any one tool. They're about the boundaries everyone blurs:
economics and inference-routing are different gateway jobs; chat and completion are different
endpoints and one corrupts your FIM; and the metering that makes it a service is sitting in a
Postgres table you already run.

That's the whole arc. Own the hardware without fighting the platform, scale it on the signals that
actually mean something, then put a tenant edge on top so it's a service and not a demo. Three layers,
each with one trap nobody documents, all of it on a GPU that costs less than lunch and idles at zero.
