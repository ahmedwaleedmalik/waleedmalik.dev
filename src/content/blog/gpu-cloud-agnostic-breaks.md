---
title: "The GPU layer is where 'cloud-agnostic' quietly breaks"
description: "Field notes from a self-hosted LLM inference platform on Kubernetes: the substrate"
pubDate: 2026-06-25
canonical: "https://waleedmalik.dev/blog/gpu-cloud-agnostic-breaks"
tags: ["kubernetes", "gpu", "llm-infra"]
draft: false
---

I've been building a self-hosted LLM inference platform on Kubernetes: vLLM behind an
OpenAI-compatible API, inference-aware routing, real benchmarks, the whole serving stack, all
delivered through GitOps so anyone with a conformant cluster can fork it and run it. This is the
substrate field note from that build. It starts where every GPU-on-Kubernetes project starts and
where a surprising number of them stall: getting a pod to actually see a GPU.

The happy-path docs make this look like three commands. In practice the GPU layer is the one place
where "cloud-agnostic" runs head-first into a fact nobody puts on the slide: **someone already owns
your node's operating system.** If that someone is a managed Kubernetes provider, you have a choice
to make that the tutorials skip right past.

This is the story of making that choice the hard way, and the principle that fell out of it: on
managed Kubernetes, consume the managed GPU stack. Don't re-run it.

![Where the portability line sits: the GPU stack is the provider's territory; your portable platform manifests live one layer up.](/assets/gpu-stack-line.svg)

## The setup, and the tempting wrong turn

The platform runs on GKE, but nothing above the cluster is GKE-specific. Argo CD reconciles an
app-of-apps from Git, secrets come from External Secrets plus Workload Identity, observability is a
self-managed kube-prometheus-stack. The design goal: the *platform* (every serving and routing
manifest) is portable, and only the thin cluster-provisioning layer is provider-specific.

For the GPU stack, the portable, vendor-neutral tool is the **NVIDIA GPU Operator**. It owns the
whole stack declaratively (kernel driver, container toolkit, device plugin, DCGM telemetry) and
it's identical on EKS, AKS, bare metal, or the box under your desk. "Own the driver, run it
anywhere" is a genuinely good instinct, and it's where I started: GPU Operator with
`driver.enabled=true` on Ubuntu nodes, GKE's own GPU driver disabled so the operator had full
control.

That instinct is correct, just not on a managed node OS. Here's how it came apart.

## Blocker 1: the driver works, but validation watches the wrong door

The driver itself came up fine. `nvidia-smi` inside the driver pod showed the L4, the driver
version, 23 GB of memory, all healthy. But every dependent component (device plugin, DCGM, the
operator validator) sat in `Init`, and the GPU never became schedulable.

The container-toolkit pod was stuck in its `driver-validation` init step, looping forever:

```
level=info  msg="Attempting to validate a driver container installation"
level=warning msg="failed to validate the driver, retrying after 5 seconds"
```

The driver demonstrably worked, so why couldn't the validator find it? The init container's
environment had the answer:

```
DRIVER_INSTALL_DIR=/home/kubernetes/bin/nvidia
```

That's GKE's *managed-driver* path. But with `driver.enabled=true` the operator installs its driver
to the chart default, `/run/nvidia/driver`. I had carried over a GKE-oriented override
(`hostPaths.driverInstallDir`) meant for the *opposite* mode, where GKE installs the driver and the
operator just consumes it. The validator was staring at an empty directory.

Dropping that one override fixed validation. Which only revealed the real wall.

## Blocker 2: the toolkit can't talk to GKE's containerd

With validation passing, the toolkit ran `nvidia-ctk runtime configure` to register an `nvidia`
runtime in containerd, the runtime every GPU pod needs. It reported success. And yet every pod with
`runtimeClassName: nvidia` failed to start:

```
FailedCreatePodSandBox ... no runtime for "nvidia" is configured
```

The toolkit writes its runtime config as a drop-in to `/etc/containerd/conf.d/99-nvidia.toml` and
sends containerd a SIGHUP. That's the standard mechanism, and it doesn't work on GKE, because **GKE
doesn't keep its containerd config at the standard path and doesn't import that drop-in directory.**
There is no `/etc/containerd/config.toml` to extend. The runtime registration silently goes
nowhere, so the device plugin, DCGM, and validator (all of which run *with* `runtimeClassName:
nvidia`) can never create a sandbox, and the GPU is never advertised. Pods requesting
`nvidia.com/gpu` sit `Pending` with `Insufficient nvidia.com/gpu`, pointing at a node that has a
perfectly good, fully installed GPU.

This is a known, open friction point ([gpu-operator#1679]). It's not a bug I was going to fix from a
values file. And switching to `driver.enabled=false` does *not* help: the operator's toolkit still
runs and still can't configure GKE's containerd. The conflict was never about the driver. It's that
**two systems both want to own the node's container runtime configuration,** and on a managed node
OS, the provider wins.

## The decision: stop fighting the platform

The pivot was to use the **GKE-managed GPU stack**: GKE installs the driver, configures containerd,
and runs the device plugin (`gpu-driver-version=default` on a COS image). No operator fighting for
the runtime. A pod requesting `nvidia.com/gpu` schedules, GKE provisions the node, and `nvidia-smi`
runs, on a clean node, end to end, in under two minutes.

It's worth being honest about what this trades away. Owning the driver via the GPU Operator is a
stronger portability story and, frankly, a more interesting one to operate. So why give it up?

Because **portability lives at a different layer than I'd been defending.** A reusable platform
splits cleanly in two:

| Layer | Portable? |
|---|---|
| Platform manifests: serving, routing, scheduling, observability, GitOps | **Yes**, runs on any conformant cluster |
| Cluster and GPU provisioning: control plane, node pools, driver, device plugin | **No**, inherently cloud/distro-specific |

Every reusable platform repo draws the line right there: bring your own conformant cluster with GPU
nodes, here's one reference recipe for provisioning them. The GPU Operator is the right tool when
you own the node OS: kubeadm, k3s, kubeone, bare metal. On a managed provider that already owns the
OS *and* ships a managed GPU stack, re-running that stack isn't portability. It's a fight you pay
for in debugging hours. So the self-managed path didn't get deleted; it got moved to the
environment where it isn't fighting anything, as a separate portability exercise on a generic
cluster.

The reversal is recorded as an architecture decision record, with the two failure modes captured in
a runbook. The "I tried X, it fought the platform here, so I switched to Y, and here's exactly why"
trail is more useful to the next person than a clean repo that pretends the first path never
happened.

## The encore: the platform was already running my exporter

There's a coda that makes the same point twice. With GPUs working, I wanted DCGM metrics in my own
Prometheus, so I reached for the portable answer again: the NVIDIA `dcgm-exporter` Helm chart, with
a GKE overlay to mount the host driver libraries (`/home/kubernetes/bin/nvidia`), set
`LD_LIBRARY_PATH`, and run privileged for device access.

It crashed on startup, every time. Exit 1, no useful log (the image is distroless). The cause, once
found, was almost funny: **GKE already runs a `dcgm-exporter` on every GPU node,** with an embedded
DCGM engine. Two embedded engines can't co-attach to the same GPU. My "portable" exporter was
losing a fight with one I didn't know was there.

The fix was the same principle in miniature. Don't run a second one. Scrape the one that's already
there. A small `PodMonitor` pointed at GKE's exporter, and our Prometheus immediately had the full
`DCGM_FI_DEV_*` set: utilization, framebuffer memory, temperature, power, and the DCP profiling
metrics, already labelled with pod-to-GPU attribution. Verified live: `46°C` on an idle L4.

![The DCGM dashboard, fed by GKE's own node exporter via a PodMonitor: per-GPU utilization, framebuffer memory, temperature, and power, with pod attribution.](/assets/gpu-dcgm-metrics.png)

The portable own-exporter, like the GPU Operator, belongs on a cluster where nothing else is already
doing the job.

## The takeaway

The lesson isn't "managed Kubernetes is better" or "self-managed is better." It's about knowing
which layer you're standing on.

- **The cluster and the GPU stack are the provider's territory on managed Kubernetes.** Driver,
  containerd, device plugin, node-level DCGM: consume what the provider gives you. Trying to own
  these from inside the cluster means fighting the node OS, and the node OS wins.
- **Your portability lives one layer up,** in the serving, routing, and observability manifests that
  run on any conformant cluster. Defend it there, not in the GPU driver.
- **Write down the path you didn't take.** The dead ends (the validation loop, the containerd
  drop-in that goes nowhere, the duplicate exporter) are the parts nobody documents and everybody
  hits.

The GPU foundation is now boring in the best way: a node scales from zero on demand, installs its
driver, advertises the GPU, runs the workload, exports telemetry to Grafana, and scales back to
zero. Boring is the goal. Boring is what you build serving on top of.

Companion field note: the serving layer, and the two signals everyone trusts to scale it that are
both wrong.

---

[gpu-operator#1679]: https://github.com/NVIDIA/gpu-operator/issues/1679
