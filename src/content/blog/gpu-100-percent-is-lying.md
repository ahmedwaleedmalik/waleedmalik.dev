---
title: "Your GPU says 100%. It's lying to you."
description: "Field notes from a self-hosted LLM inference platform on Kubernetes: the signals that scale it"
pubDate: 2026-06-24
canonical: "https://waleedmalik.dev/blog/gpu-100-percent-is-lying"
tags: ["kubernetes", "gpu", "inference", "llm-infra"]
draft: false
---

The first time I load-tested vLLM on a single L4, I did the obvious thing: opened the GPU
utilization graph, watched it climb to 100%, and reached for the autoscaler. That's the reflex
every web engineer brings to GPUs. It's also wrong, and it's wrong in a way that quietly wastes
money and tail latency on a lot of inference deployments.

This is the serving-intelligence field note from building a self-hosted LLM inference platform. It is
about the two signals everyone reaches for to scale LLM serving (GPU utilization and a plain load
balancer), why both are blind to what actually matters, and the numbers from my own cluster that show
it.

## The signal that lies

Here are the resource peaks from a real benchmark run. One L4, `Qwen2.5-0.5B-Instruct` on vLLM
v0.23.0, a closed-loop concurrency sweep, GPU and KV-cache read from the same Prometheus the
dashboards use:

| signal | peak |
|---|---|
| GPU utilization (`DCGM_FI_DEV_GPU_UTIL`) | **100%** |
| KV-cache usage (`vllm:kv_cache_usage_perc`) | **1.1%** |
| Requests running / waiting (`vllm:num_requests_*`) | 31 / **0** |

Look at those three numbers together. The GPU reads 100% utilized. The KV cache, the memory pool
that actually holds in-flight requests, sits at barely 1%. And nothing is queued: zero requests
waiting. Three signals, one story, and the loudest one is the least useful.

GPU utilization, as DCGM reports it, means "a kernel was running during the sample window." Under
vLLM's continuous batching and PagedAttention, there is almost always a kernel running, so the
number pins near 100% the moment you put any load on it and then stops moving. It can't distinguish
"comfortably busy" from "drowning." If you autoscale on it, you scale up at the first request and
never scale down, or you set a threshold below 100% that the workload simply never reports. Either
way the signal isn't carrying information.

The signal that *does* carry information is queue depth: `vllm:num_requests_waiting`. It's zero when
the engine is keeping up and climbs the instant it isn't. That's the saturation signal. Everything
downstream (autoscaling, capacity planning, when to add a GPU) should hang off queue depth, not
utilization.

![The vLLM serving dashboard: TTFT/ITL/E2E percentiles, prompt vs generation throughput, running vs waiting requests, KV-cache usage, and GPU util from DCGM, side by side. The point of the layout is that you read saturation off the queue, not off the GPU bar.](/assets/vllm-serving-metrics.png)

One trap worth flagging, because it bit me and it's invisible: vLLM's V1 engine **renamed its
metrics.** `gpu_cache_usage_perc` became `kv_cache_usage_perc`; `time_per_output_token_seconds`
became `inter_token_latency_seconds`. If your dashboards or your autoscaler triggers are pinned to
the old names, they don't error. They silently read zero. Treat a major engine version bump as a
metrics-contract change and diff `/metrics` before you trust a single panel.

## What actually bottlenecks (and why "just add pods" can't fix it)

So if the GPU is at 100% and nothing is queued, what gives out first as you pile on load? Here's the
concurrency sweep, latencies in milliseconds, 256-token prompt and 128-token output per request:

| concurrency | req/s | out tok/s | TTFT p50 | TTFT p95 | ITL p50 | ITL p95 | E2E p50 |
|---|---|---|---|---|---|---|---|
| 1  | 1.3  | 168  | 27.0  | 115.5 | 5.1 | 6.1  | 679  |
| 8  | 10.2 | 1312 | 60.9  | 88.4  | 5.5 | 7.4  | 772  |
| 16 | 17.8 | 2277 | 103.8 | 135.7 | 6.0 | 8.9  | 880  |
| 32 | 29.5 | 3773 | 135.3 | 191.8 | 7.1 | 12.0 | 1082 |

Three things fall out of this, and they're more interesting than the headline throughput number.

**Time to first token degrades first.** As concurrency goes 1 to 32, TTFT p50 grows about 5x (27 to
135 ms). Prefill is the compute-heavy phase, and as requests compete for prefill slots they queue at
the front. TTFT is the first SLI to watch under load, and it's the one your users feel as "the
assistant is slow to start talking."

**Decode stays cheap and flat.** Inter-token latency holds around 5 to 6 ms until concurrency 16 and
only reaches 12 ms p95 at 32. Continuous batching keeps per-token decode efficient. On this model,
decode is never the constraint.

**Throughput scales near-linearly right up to saturation,** then stops buying you anything but
latency. Output rises 168 to 3773 tok/s (about 22x) from concurrency 1 to 32, tracking GPU
utilization toward 100%. Past that point, more concurrency trades latency for throughput and nothing
else.

Now the part that matters for how you scale. This workload is **compute-bound, not memory-bound.**
The GPU pins at 100% while the KV cache never crosses 1% and nothing queues. For a 0.5B model the KV
footprint per request is tiny, so on one L4 you run out of *compute* long before *memory*. And here's
the consequence people miss: **adding replicas would not help on a single GPU.** The GPU is already
the bottleneck. Horizontal scaling is the answer to "more requests than one GPU can serve," not to
"this GPU is working hard." You can't add pods to fix a within-GPU limit.

The flip side is the honest caveat: these shapes are specific to this model and this card. Put a 7B
or 70B model on here and the story inverts. KV per token gets large, the cache fills, and the first
bottleneck shifts from compute to memory bandwidth, which makes TTFT far costlier and changes what
"add capacity" even means. There is no universal answer to "what bottlenecks LLM serving." There's
only *your* shape, measured. The same harness re-run on a bigger model is the next data point, and
the point of the harness is that you can get that data point instead of guessing.

## The load balancer is blind too

Say you've measured your shape, you're genuinely out of single-GPU headroom, and you add replicas.
Now a second wrong signal shows up: the load balancer.

A plain HTTP load balancer distributes by connection count or round-robin. For stateless web
services that's fine. For LLM inference it's blind to the only things that predict tail latency:
which replica has KV-cache headroom, and which one has a queue building. Round-robin will cheerfully
send a request to a saturated replica while an idle one sits next to it, because connection count
says they're equal.

![Round-robin versus inference-aware routing. Same three replicas; only the Endpoint Picker reads KV-cache and queue depth, so traffic follows headroom instead of a rotation.](/assets/routing-roundrobin-vs-epp.svg)

The fix is inference-aware routing. I'm using the [Gateway API Inference Extension](https://gateway-api-inference-extension.sigs.k8s.io/) (GIE): an
`InferencePool` of identical replicas with an Endpoint Picker (EPP) that scores every replica per
request on live metrics (KV-cache occupancy, queue depth) and sends the request to the one with
actual headroom. It's a small, purpose-built piece of the data plane whose entire job is to *not* be
blind.

Does it behave differently from round-robin? In the small fan-out checks, yes. On a three-replica
pool, a burst of 12 requests distributed 3 / 2 / 7, not 4 / 4 / 4. On a two-GPU rig (two RTX 3090s,
one vLLM replica each), an EPP burst landed +5 on one pod and +7 on the other. That is not a
full latency benchmark. It is the narrower proof I need before trusting the path at all: requests
go through the gateway, EPP can see the serving endpoints, and traffic is not blindly pinned to one
pod.

The larger proof still owed is an A/B run under skew: round-robin versus EPP, one replica already
hot, same workload, compare tail latency. I would not publish a "GIE cut p95 by X%" claim from the
data I have. The honest claim is smaller and still useful: if your platform is going to route across
LLM replicas, the routing layer needs access to queue and cache state. A plain Service does not have
that contract. GIE does.

## Does serving actually scale out?

Routing intelligently is worth nothing if the second GPU doesn't buy throughput. So I also ran a
separate capacity frontier on the two-3090 rig, two vLLM replicas, the same model. Important
provenance: this run used the raw Kubernetes Service path, so it proves multi-replica serving
capacity, not an EPP-vs-round-robin win.

| concurrency | req/s | out tok/s | lat p95 | TTFT p95 | errors |
|---|---|---|---|---|---|
| 1  | 2.3  | 252  | 481  | 67  | 0 |
| 16 | 31.1 | 3063 | 618  | 83  | 0 |
| 32 | 51.6 | 5421 | 692  | 112 | 0 |
| 64 | 81.1 | 8871 | 956  | 197 | 0 |

Aggregate peak around 81 req/s and 8,871 output tok/s, and the per-pod counters came back 1,460
versus 1,523 over the run: roughly 50/50 across both cards, zero errors across about 3,000 requests.
Two GPUs, near-linear scaling to saturation, balanced. That's the result you want before spending
time on smarter routing: the extra card is actually useful, and the server path can keep both
replicas busy.

I'll be straight about one thing here, because hiding it would undercut the whole "measure, don't
guess" argument. My pinned canonical benchmark tool (GuideLLM v0.5.0) **could not complete a single
request** on the multi-GPU rig: every mode returned zero completions, vLLM received nothing, even
though the validation GET passed. I produced this frontier with a small stdlib streaming harness
instead and flagged the GuideLLM incompatibility as a real bug to chase. A benchmark you can't
reproduce on every substrate isn't a benchmark yet. Reporting the number the tool that worked gave
me, and naming the tool that didn't, is the honest version.

So the routing story and the capacity story land in different buckets:

| Question | What I proved |
|---|---|
| Can EPP route real traffic to vLLM replicas? | Yes, with small fan-out checks through the gateway. |
| Does a second GPU buy serving capacity? | Yes, with a 2x3090 frontier through the raw Service path. |
| Does EPP beat round-robin on p95 under skew? | Not yet. That needs a dedicated A/B benchmark. |

## It all hangs off the right signal

Tie the thread back together. The platform autoscales serving replicas with KEDA, and the scaler
listens to `vllm:num_requests_waiting` (queue depth), not GPU utilization, with a per-replica
threshold around five. Scale-out is gated on the signal that actually means "I'm falling behind."
The router underneath that listens to KV-cache and queue depth, not connection count. Top to bottom,
every scaling decision is wired to a signal that can see the inference state, because the obvious
ones can't:

- GPU utilization pins at 100% and stops carrying information. Queue depth is the saturation signal.
- The first bottleneck (compute vs memory) depends on your model and GPU, so measure your shape;
  don't inherit someone else's curve. Adding pods can't fix a within-GPU limit.
- A plain load balancer is blind to KV-cache and queue depth. Inference-aware routing exists
  precisely to route on the state that predicts tail latency.

None of this is exotic. It's three off-the-shelf signals read correctly instead of the two obvious
ones read wrong. The reason it's worth a whole post is that the wrong two are the ones every dashboard
shows you first.

Companion product story: the layer above all of this, where serving a model turns into offering a
service. Virtual keys, per-tenant budgets, and a coding assistant on your own GPUs, including the
endpoint that returns 200 while silently corrupting your output.
