---
title: "A Million Agents Shouldn’t Mean a Million Kubernetes Pods"
description: "Separate agent state from execution capacity: where Kubernetes, sandbox runtimes, and suspend/resume fit."
pubDate: 2026-10-02
canonical: "https://waleedmalik.dev/blog/a-million-agents/"
tags: ["kubernetes", "ai-agents", "sandboxes", "platform-engineering"]
socialImage: "/assets/a-million-agents-og.png"
presentation: feature
category: "Agent infrastructure"
draft: false
---

I tend to be skeptical when someone says Kubernetes “wasn't designed for” a new workload. Usually, the question is how much engineering it takes to make the workload fit.

Agents that execute code raise a more specific question: should every persistent agent environment be a Kubernetes Pod?

One Pod per environment is a reasonable starting point. It gives you familiar scheduling, resource limits, networking and recovery. But a coding agent might run tests for ten seconds, wait for inference, then sit untouched until someone returns the next morning. Keeping that environment alive retains memory and a Pod object; shutting it down means saving enough state to reconstruct it later.

Waiting inside a running Pod does **not** create Pod churn. Churn appears when the platform creates and deletes Pods for each activation. Those are different costs, and changing the sandbox runtime doesn't remove either one.

## gVisor, microVMs, and arbitrary workloads

gVisor implements the Linux system interface in a userspace kernel, reducing the application's direct exposure to the host kernel. A microVM puts a guest Linux kernel behind a hardware virtualization boundary. Both are useful approaches to isolating untrusted code; they differ in compatibility, resource cost and operational requirements.

![gVisor places a userspace kernel between the application and host kernel. A microVM runs a guest Linux kernel above virtual hardware.](/assets/agent-isolation.svg)

Using [gVisor as Docker's runtime](https://gvisor.dev/docs/user_guide/quick_start/docker/) and running a Docker daemon **inside** a gVisor sandbox are different setups. The latter matters when an agent is expected to launch its own Docker stack entirely within the sandbox.

gVisor documents [support for nested Docker](https://gvisor.dev/docs/tutorials/docker-in-gvisor/), but it requires specific runtime flags, disabling Docker-managed iptables and additional network configuration. Docker 29 also needs storage adjustments, such as a `tmpfs` mount at `/var/lib/docker` or disabling the containerd image store. Basic Docker commands working doesn't guarantee that an arbitrary Docker stack will behave as it does on a normal Linux host.

gVisor also has a [FUSE implementation](https://gvisor.dev/docs/user_guide/fuse/). Upstream support and what a particular sandbox provider makes available need to be evaluated separately.

Beyond Docker, gVisor's [compatibility documentation](https://gvisor.dev/docs/user_guide/compatibility/) describes restrictions around block-device filesystems, partial `io_uring` support, custom devices, nested KVM and enforcing resource limits between processes inside one sandbox. An agent that chooses its own tools can encounter these edges in ways a fixed application doesn't.

Modal's [current Sandbox guide recommends its VM runtime for running Docker](https://modal.com/docs/guide/sandboxes#running-docker-in-a-sandbox). Its [October 1, 2026 release](https://modal.com/blog/vm-sandboxes-agent-computers) made Cloud Hypervisor-based VM Sandboxes generally available while retaining gVisor as the default. Legora describes removing networking and FUSE workarounds from its Docker-based environment after switching. That makes the compatibility argument concrete: a full Linux environment can remove operational friction even when upstream gVisor technically supports nested Docker. It doesn't establish a failure of gVisor's isolation boundary.

A guest kernel broadens what software can do, but brings its own memory, patching and virtualization costs. I'd choose the boundary against the actual workload and threat model. Neither approach makes network access or credentials safe automatically; those controls are outside this article's scope.

## Replacing the sandbox doesn't solve the control-plane problem

A microVM still has to be placed somewhere. If every activation creates a Pod, it still goes through Kubernetes object persistence, scheduling, workload startup on a node and status updates.

Consider a deliberately hypothetical fleet: one million agents, each waking once every five minutes, averages roughly **3,333 activations per second**. If every activation requires a new Pod, that's 3,333 Pod creations per second before cleanup or bursts. If those agents reuse running Pods, the calculation says nothing about Pod creation rates. The remaining question is how much idle capacity and state the platform retains.

Modal encountered a related coordination problem in its own platform. **Modal does not run on Kubernetes.** Its [July 2026 scheduler write-up](https://modal.com/blog/scaling-to-1-million-concurrent-sandboxes-in-seconds) describes an unsharded Postgres instance and strong coordination on the sandbox creation path. Its Kubernetes comparison points to repeated etcd writes over a Pod's lifetime and node liveness traffic as examples of work that grows with the fleet.

The redesign distributes scheduling, uses cached worker availability and lets workers accept or reject placement directly. Durable metadata moves off the synchronous creation path. Modal reported creating one million concurrent sandboxes in under a minute; “created” meant assigned to a worker that had begun startup, not necessarily ready to run a command. The post described the system as opt-in beta at publication.

My takeaway is about the scheduling boundary: keeping every execution transition synchronously coordinated through a central store can become expensive, whatever orchestrator sits underneath it.

## Kubernetes may belong one layer lower

Google's Agent Substrate applies that separation on top of Kubernetes.

This needs distinguishing from **GKE Agent Sandbox**, the Pod-based approach. Agent Sandbox already offers mechanisms such as warm pools and Pod snapshots; it isn't simply a cold Pod on every request. Google [describes both approaches](https://cloud.google.com/blog/products/containers-kubernetes/bringing-you-agent-sandbox-on-gke-and-agent-substrate), which serve different lifecycle requirements.

The [Agent Substrate documentation](https://docs.cloud.google.com/kubernetes-engine/ai-ml/about-agent-substrate) explicitly describes bypassing standard Kubernetes control-plane bottlenecks. Kubernetes has no native Pod hibernation, and a fleet of idle Pods still consumes object capacity and control-plane memory. Substrate instead separates saved agent state from the workers that execute it.

On a request, it restores the target agent's snapshot onto an available warm worker. When the agent becomes idle, it saves memory and local files and releases the worker for reuse. Kubernetes manages the worker Pods and underlying fleet; the execution layer manages activation and suspension.

![Agent runtime places and resumes sessions on a shared worker pool, saving idle sessions as snapshots. Kubernetes manages worker Pods, fleet capacity and recovery below that layer.](/assets/agent-execution-layers.svg)

Google's [September announcement](https://cloud.google.com/blog/products/containers-kubernetes/agent-substrate-available-on-gke) describes gVisor and Cloud Hypervisor options, sub-500 ms resumes and more than 500 suspend/resume activations per second. It also claims over 1,000 dormant agents per host. These are vendor-reported results, and resume latency is not directly comparable with Modal's creation benchmark.

**Kubernetes manages infrastructure. The agent runtime manages churn.**

That is the division I'd aim for when idle state and activation rates justify a separate runtime. At smaller scale, ordinary Pods may remain easier to operate. The extra layer introduces another scheduler, a snapshot store and failure modes the platform team now owns. As of October 2, GKE's documentation also limits production support for Agent Substrate to an allowlist; general access covers evaluation and non-production use.

## Start time is only part of the cost

For a platform built around long-lived sessions, I'd measure dormant-state cost alongside startup latency: retained RAM, snapshot size, storage operations, restore bandwidth and tail latency during a burst. Suspending an environment trades compute residency for storage and recovery work. Frequent snapshotting may be a poor bargain for a busy agent.

The operational questions matter just as much. What happens if a worker dies while saving state? Can a snapshot restore after a runtime upgrade or on another machine type? How does a resumed process handle an expired credential, a broken database connection or an external request whose outcome is uncertain? Restoring memory cannot roll back the outside world.

These are the questions I'd want answered before adopting this model in production. A fast demo establishes one useful property; it doesn't settle recovery semantics or operating cost.

For this class of agent, the unit being scheduled can be **resumable execution state that periodically needs compute**. Kubernetes remains a useful foundation for maintaining that compute fleet. The sandbox supplies the isolation boundary. An execution layer can connect the two without requiring every dormant session to retain its own Pod.

**A million agents shouldn't have to mean a million Kubernetes Pods.**
