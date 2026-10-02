---
title: "A Million Agents Shouldn’t Mean a Million Kubernetes Pods"
description: "Why agent infrastructure may need a new execution layer between Kubernetes and the sandbox."
pubDate: 2026-10-02
canonical: "https://waleedmalik.dev/blog/a-million-agents"
tags: ["kubernetes", "ai-agents", "sandboxes", "platform-engineering"]
presentation: feature
category: "Agent infrastructure"
draft: false
---

I tend to be skeptical whenever someone says Kubernetes “wasn’t designed for” a new kind of workload. Kubernetes has been stretched into enough shapes over the years that the answer is usually: yes, it can probably do it, if you’re willing to engineer around the limits.

AI agents are making me think a little differently.

The obvious architecture for running agents is straightforward. Give each agent an isolated environment, represent that environment as a Pod, and let Kubernetes handle scheduling, placement, recovery and capacity.

That works, and for many systems it will continue to work perfectly well.

But an agent has a strange lifecycle compared with most services we run on Kubernetes. It might execute for ten seconds, wait for a model response, run a tool, sit idle while a human reviews something, wake up again, run some tests, and then disappear.

At small scale, none of this is particularly interesting. At hundreds of thousands or millions of execution environments, it starts to change the shape of the infrastructure problem.

There are two separate questions hiding inside it.

First, **what isolation boundary should we give an agent that can execute arbitrary code?**

Second, **does every logical agent really need to participate directly in the Kubernetes control plane?**

I think the second question may turn out to be the more important one.

## gVisor, microVMs, and the problem of arbitrary workloads

gVisor is an impressive approach to sandboxing untrusted code.

Rather than allowing sandboxed applications to interact directly with the host Linux kernel, gVisor implements much of the Linux system interface inside its own userspace kernel. The application still sees something that looks like Linux, while the host kernel is exposed to a much smaller set of interactions.

For many workloads, that's a very useful trade.

The interesting part for agents is compatibility.

When we deploy a normal application, we mostly know what that application is going to do. With agents, we increasingly hand over some of that decision-making to the model.

The agent might install a package we didn't anticipate, start PostgreSQL, use Docker, mount a filesystem, run a development server, manipulate cgroups, or depend on a particular kernel feature.

That's where the distinction starts to matter.

gVisor supports a large amount of the Linux API, but it doesn't attempt to reproduce every part of Linux perfectly. Its own documentation lists gaps around things such as block-device filesystems, parts of `io_uring`, custom devices, nested KVM, some networking functionality and resource enforcement between processes inside the same sandbox.

That's not really a criticism of gVisor. It's a consequence of the architecture: if you build an alternative implementation of the kernel interface, compatibility is something you have to keep implementing.

A microVM draws the boundary somewhere else. Instead of recreating the Linux interface, it gives the workload its own Linux kernel and isolates that environment using hardware virtualization.

That makes the basic trade-off roughly this:

```text
gVisor

application
    ↓
userspace kernel
    ↓
host kernel


microVM

application
    ↓
guest Linux kernel
    ↓
virtual hardware
    ↓
host
```

For an agent running unpredictable software, the second model has an obvious attraction: the environment behaves like a Linux machine because it actually has a Linux kernel.

This doesn't mean “microVMs are secure and gVisor isn't.” That's not a useful comparison. gVisor deliberately minimizes exposure to the host kernel and has lower overhead for many workloads. A microVM gives you a different isolation boundary and much broader compatibility with software that expects a normal machine.

Modal's recent VM Sandbox release is a good example of where this leads in practice. Their existing Sandboxes use gVisor, and gVisor remains the default. But they've added a VM runtime for workloads that run into the boundaries of userspace isolation: Docker, FUSE, local databases, system-level tooling and less common kernel functionality.

That feels like the right model to me.

**The sandbox implementation should be a workload decision, not the architecture of the entire platform.**

Google's Agent Substrate takes a similar approach and supports both gVisor and Cloud Hypervisor microVMs.

## Replacing the sandbox doesn't solve the control-plane problem

Suppose we decide microVMs are exactly what our agents need.

We still haven't solved the harder scaling problem.

If every agent maps directly to a Kubernetes Pod, then creating an execution environment means going through machinery roughly like this:

```text
API server
    ↓
persistent state
    ↓
scheduler
    ↓
node
    ↓
runtime
    ↓
sandbox
```

That's a sensible model for Kubernetes. Workloads are declarative objects with durable state, controllers observe them, schedulers place them, nodes report status, and the system continuously reconciles reality with the desired state.

It's one of the reasons Kubernetes works so well.

The question is whether every short-lived agent activation needs all of that machinery.

Modal ran into a version of this problem while rebuilding its sandbox infrastructure. Their target was millions of concurrent sandboxes and bursts of tens of thousands of sandbox creations per second.

What I find interesting isn't really the benchmark. It's what they changed architecturally.

Their previous system, like many schedulers, depended on central coordination and durable state during sandbox creation. At very high creation rates, operations proportional to the number of sandboxes or workers kept surfacing as bottlenecks.

In the new system, scheduling is horizontally distributed. Schedulers operate on cached worker state, choose a worker and talk directly to it. Durable metadata is still recorded, but it doesn't have to sit in the critical path of every sandbox creation.

Modal describes the resulting scheduler as looking more like load balancing than traditional container scheduling. They demonstrated one million sandbox creations in under a minute.

That's the part worth paying attention to.

Once workload churn becomes high enough, the properties you want from an execution scheduler start to look quite different from the properties you want from an infrastructure orchestrator.

## Kubernetes may belong one layer lower

Google's Agent Substrate makes this separation even more explicit.

The idea isn't to replace Kubernetes. It uses Kubernetes underneath.

What changes is which lifecycle Kubernetes is responsible for.

Kubernetes manages the machines, worker Pods, autoscaling, failures and general health of the fleet. A separate agent execution layer handles the much higher-frequency operations: placing agents, suspending them, restoring their state and dispatching them onto available workers.

Conceptually:

```text
                    Agent layer

       Agent      Agent      Agent      Agent
         │          │          │          │
         └──────────┴─────┬────┴──────────┘
                          │
                   Agent scheduler
                          │
              ┌───────────┴───────────┐
              │                       │
       execution workers       snapshots / state


                Infrastructure layer

                     Kubernetes
                         │
             ┌───────────┼───────────┐
             │           │           │
          worker      worker      worker
```

An idle agent doesn't need to keep consuming the same CPU and memory that it needed while executing. Its state can be suspended, capacity can be used elsewhere, and the environment can be resumed when the next turn arrives.

Google reports sub-500 ms resume operations and more than 500 suspend/resume activations per second for Agent Substrate. More interestingly, Google explicitly describes the architecture as bypassing bottlenecks in the standard Kubernetes control plane.

That distinction matters.

You're no longer asking Kubernetes to observe every pause and resume of every agent. You're asking Kubernetes to keep a healthy pool of execution capacity available.

The agent runtime handles the churn.

I think that's a much cleaner boundary.

## Maybe “start time” isn't the metric we should obsess over

There's one more consequence of this architecture that I find interesting.

We spend a lot of time benchmarking sandbox startup:

> How quickly can I create a container or boot a microVM?

That still matters. But an agent spends a significant amount of its life doing nothing: waiting for model inference, external tools, another agent, or a person.

If that's the workload, I'd also want to know:

How many dormant agents can I keep cheaply? How quickly can I restore one? How many environments can the system resume at once? How large is the state I have to persist? Can I move that state between machines? What happens to the filesystem and external resources when I do?

Those start to sound as much like storage and distributed-systems problems as compute problems.

For a traditional application platform, the natural thing to schedule is a running process.

For an agent platform, the thing we're scheduling may increasingly be **resumable execution state that periodically needs compute**.

That's a subtle difference, but I think it changes the architecture.

Kubernetes isn't going away. In fact, I suspect it remains a very good foundation for these systems because node management, autoscaling, failure recovery and capacity orchestration are problems we don't need to solve again.

But the agent itself may belong one level above it.

Let Kubernetes manage the fleet. Let an agent-native execution layer deal with high-frequency scheduling, suspension and state. Then choose gVisor, a microVM, or another isolation mechanism based on what the workload actually needs.

**A million agents shouldn't have to mean a million Kubernetes Pods.**

---

### Further reading

- [Google Cloud — *Agent Substrate brings high-density, scalable, trusted infrastructure to GKE*](https://cloud.google.com/blog/products/containers-kubernetes/agent-substrate-available-on-gke)
- [Modal — *Scaling to 1 million concurrent sandboxes in seconds*](https://modal.com/blog/scaling-to-1-million-concurrent-sandboxes-in-seconds)
- [Modal — *VM Sandboxes: Full computers for agents*](https://modal.com/blog/vm-sandboxes-agent-computers)
- [gVisor — *Application Compatibility*](https://gvisor.dev/docs/user_guide/compatibility/)
- [gVisor — *Security Model*](https://gvisor.dev/docs/architecture_guide/security/)
- [Firecracker — *Specification*](https://github.com/firecracker-microvm/firecracker/blob/main/SPECIFICATION.md)

