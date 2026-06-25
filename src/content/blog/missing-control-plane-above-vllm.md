---
title: "The Missing Control Plane Above vLLM"
description: "Serving a model is a workload. Operating it as a service is a platform."
pubDate: 2026-06-26
canonical: "https://waleedmalik.dev/blog/missing-control-plane-above-vllm"
tags: ["kubernetes", "llm-infra", "platform-engineering"]
presentation: feature
draft: false
---

There is a point in every self-hosted LLM project where the demo starts to look finished.

The model answers. The endpoint speaks OpenAI. The GPU is alive. Grafana has a few panels. Someone
types a prompt, gets tokens back, and the room relaxes a little.

That is the dangerous moment.

Because vLLM running in a pod is not the platform. It is the engine. A very good engine, but still
only the part that turns requests into tokens. The platform begins around it, in the layer that
answers the questions the model server does not even know exist.

Who is allowed to call this? Which model aliases can they see? What happens when they hit a budget?
Which replica should get this request? Is the GPU actually overloaded, or just busy? Where did the
secret come from? Can this stack move to another cloud without pretending GPUs are portable in a way
they are not?

Those are not afterthoughts. Those are the control plane.

I learned this while building [**Kubernetes LLM Inference Platform**](https://github.com/ahmedwaleedmalik/k8s-llm-inference-platform),
a GitOps-managed LLM inference platform on Kubernetes, now open source: vLLM and KServe for serving,
LiteLLM for the tenant edge, Gateway API Inference Extension for routing, Kueue and KEDA for
scheduling and autoscaling, External Secrets for secret delivery, Prometheus/Grafana/DCGM for
observability, and OpenTofu underneath for the cloud substrate.

The interesting part was not wiring those names together. The interesting part was deciding where
each responsibility stops.

![The platform as a stack of ownership boundaries: each layer answers a different question; tenant edge (keys, budgets, guardrails), inference-aware routing, serving, GPU scheduling, and the cloud substrate, all reconciled by GitOps on Kubernetes.](/assets/inference-stack.svg)

This is a claim about the shape of the platform: which boundaries have to exist before a model endpoint becomes something
other people can use without inheriting your mental state.

## Two Gateways, Two Questions

The first trap is thinking "AI gateway" is one layer.

It is not. At least not if you want the system to behave like a service rather than a demo.

LiteLLM and Gateway API Inference Extension look like they live in the same neighborhood, but they
answer different questions:

- **LiteLLM asks the business question:** who is this, what key are they using, which model alias do
  they want, what are they allowed to spend, and what should be written to the ledger?
- **GIE asks the serving question:** of the replicas that can serve this model, which one has the
  healthiest queue and cache state right now?

Those should not be collapsed.

LiteLLM belongs at the tenant edge. It is where virtual keys, per-key budgets, model allowlists, rate
limits, and spend records live. It turns a raw model endpoint into something you can safely hand to
another person.

GIE belongs behind that, facing the serving pool. It should not care who the tenant is. It should
care which replica has headroom.

![LiteLLM and GIE split the two gateway jobs: tenant economics at the edge, inference-aware endpoint selection behind it.](/assets/llm-inference-two-layers.svg)

That boundary matters because it prevents architectural mush. If a developer has a $5 monthly key,
that is not a Kubernetes scheduling concept. If one vLLM pod has a longer queue than another, that
is not a billing concept.

The platform needs both answers. It just should not ask the same component to invent both.

## The GPU Graph Lies Before It Helps

The second trap is believing the first dashboard you open.

During [a benchmark](https://ai.wmx.dev/benchmarks) on one L4 running `Qwen2.5-0.5B-Instruct` on
vLLM, the GPU graph went to 100 percent. That sounds like saturation. It is also not enough information to make a scaling decision.

The rest of the run looked like this:

| Signal | Peak |
| --- | ---: |
| GPU utilization (`DCGM_FI_DEV_GPU_UTIL`) | **100%** |
| KV-cache usage (`vllm:kv_cache_usage_perc`) | **1.1%** |
| Requests running / waiting (`vllm:num_requests_*`) | 31 / **0** |

Read those together. The GPU was busy. The KV cache was basically empty. Nothing was waiting.

That is not the same thing as "the service is drowning." It means this small model kept the GPU
active while the engine still kept up with demand. If I had scaled on GPU utilization, I would have
scaled on noise.

The useful signal was queue depth: `vllm:num_requests_waiting`.

That is the moment the system says, "I am falling behind." It is the signal KEDA should care about.
It is also the signal an inference-aware router should consider when spreading traffic across
replicas. GPU utilization tells you work is happening. Queue depth tells you work is not keeping up.

This is not a universal law that GPU utilization is useless. It is a narrower and more useful claim:
for this vLLM workload, under continuous batching, raw GPU utilization stopped carrying enough
information to drive autoscaling. The platform had to scale on the serving signal, not the hardware
vibe.

That distinction is where a platform becomes more than a deployment.

## Portability Lives Below The Pretty Diagram

"Cloud-independent" is another phrase that can get sloppy fast.

The in-cluster platform can be portable. The GPU substrate is where that claim gets tested.

On GKE, I started with the instinct many Kubernetes people have: install the NVIDIA GPU Operator and
own the GPU stack from inside the cluster. It felt more portable. Same operator everywhere, same
manifests everywhere.

In practice, it fought the platform.

GKE already manages the driver, device plugin, container runtime integration, and DCGM exporter. The
driver path could look alive while the runtime integration still failed in the place that mattered:
GPU pods could not actually schedule and run correctly. Owning that layer from inside Kubernetes was
not portability. It was ignoring the substrate boundary.

The better split was blunt:

- OpenTofu owns the substrate: cluster, node pools, IAM, Workload Identity, Artifact Registry, GPU
  node configuration.
- Argo CD owns the in-cluster platform: controllers, gateways, serving workloads, dashboards,
  External Secrets, feature-gated apps.

![The GPU stack is a substrate responsibility on managed Kubernetes; the portable platform starts above that boundary.](/assets/gpu-stack-line.svg)

That makes the portability claim smaller, but true. The platform is
[cloud-independent above the substrate](https://ai.wmx.dev/architecture). Moving clouds means re-solving GPU drivers, storage classes, load balancing, and the
secret trust root. It should not mean rewriting the tenant edge, serving layer, routing layer, or
observability model.

The second-cloud proof reinforced that. On Hetzner, there is no managed GKE GPU stack to consume, so
the NVIDIA GPU Operator becomes the right substrate path. Same platform idea, different substrate
answer.

That is the part worth saying plainly: portability is not pretending the substrate does not exist.
Portability is making the substrate the only thing that has to change.

## The Service Is The Ledger

The moment another person uses your model, "it returns tokens" stops being the bar.

A service needs an accounting surface.

For this stack, that surface is LiteLLM: virtual keys, model allowlists, per-key budgets, budget
windows, rate limits, and spend logs. The model server does not need to know any of this. The user
does.

A key for a chat front-end can see `coder-chat`, `coder-fim`, and `embeddings`. A key for an
autocomplete server can see only `coder-fim` and `embeddings`. Both can have dollar budgets. Both
write spend records.

The non-obvious bit: self-hosted models have no default price. If you do not set
`input_cost_per_token` and `output_cost_per_token`, every call costs zero and the budget system is
theater. Once pricing is explicit, the platform can answer the question a service must answer:
"who spent what?"

I like the database ledger for this more than metrics alone. Metrics are great for operations.
Ledgers are great for money. LiteLLM already writes request spend into Postgres, so Grafana can read
that table through a read-only datasource and show spend by key, model, and budget window.

That dashboard is not decoration. It is the difference between "we have a model endpoint" and "we
can hand someone a key and know what happens next."

## Secrets Are Not Plumbing

Secrets are where platform demos quietly become bad examples.

This platform has secret material everywhere: LiteLLM master keys, generated virtual keys, database
credentials, OAuth values, DNS tokens, registry credentials, and provider tokens. The rule is simple:
secret values do not enter git, and they do not enter IaC state.

Git stores the contract. External Secrets materializes runtime Kubernetes Secrets from the selected
backend. On GKE that backend is GCP Secret Manager through Workload Identity. Off GKE, the backend
can change, but the in-cluster contract stays stable.

That is not the sexiest part of the system. It is also exactly the kind of line a platform has to
draw early, because retrofitting secret hygiene after people depend on the stack is miserable.

## Complexity Has To Earn Its Keep

The same rule applies to serving layers.

Raw vLLM is the right starting point when you want control and a small blast radius. It is just a
Deployment, Service, PVC, probes, and routing. You own the lifecycle because the lifecycle is still
simple.

KServe starts to earn its keep when the lifecycle itself becomes the problem: stable per-model URLs,
declarative revisions, canaries, scale-to-zero, and one CRD contract across many models.

llm-d is later again. It belongs near the point where serving architecture changes: disaggregated
prefill/decode, larger models, more GPUs, and more serious routing pressure.

The easy mistake is to adopt the fanciest serving abstraction first and call that maturity. It is
usually just prepaid complexity.

The platform decision is not "which tool is most powerful?" It is "which responsibility has become
real enough to deserve a control plane?"

## What the Control Plane Owns

After building this, I would describe the platform less by its component list and more by the
questions it can answer:

| Question | Platform responsibility |
| --- | --- |
| Who is calling? | Virtual keys, SSO, model allowlists |
| What can they spend? | Budgets, token pricing, spend ledger |
| What content is allowed? | Tenant-edge guardrails: PII masking, prompt-injection blocking |
| Where should this request go? | Inference-aware routing, queue/cache signals |
| When should capacity change? | Queue-depth autoscaling, not raw GPU utilization |
| Which layer owns the GPU stack? | Substrate-specific IaC, not generic in-cluster wishful thinking |
| How do secrets arrive? | External secret contract, no values in git or IaC state |
| What is actually happening? | vLLM metrics, DCGM, Prometheus, Grafana, cost views |
| Which serving layer is worth it? | Raw vLLM first, KServe/llm-d when lifecycle or scale requires them |

That is the missing control plane above vLLM.

Not a dashboard. Not a wrapper. Not a pile of YAML around a model server.

A set of explicit ownership boundaries.

The model server should be excellent at serving tokens. The platform around it should be excellent
at everything that makes those tokens safe, observable, routable, budgeted, and operable by someone
other than the person who built the first demo.

Serving a model is a workload.

Operating it as a service is a platform.

---

**The missing control plane is open source.**

[Kubernetes LLM Inference Platform](https://github.com/ahmedwaleedmalik/k8s-llm-inference-platform) is
the stack these boundaries come from; fork it, render `config.yaml` into git, and serve an
authenticated, OpenAI-compatible endpoint on GPU.

[GitHub](https://github.com/ahmedwaleedmalik/k8s-llm-inference-platform) · [Documentation](https://ai.wmx.dev) · [Benchmarks](https://ai.wmx.dev/benchmarks)
