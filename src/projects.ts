export type Project = {
  name: string;
  role: string;
  blurb: string;
  href: string;
  stars?: string;
};

export const PROJECTS: Project[] = [
  {
    name: "Kubernetes LLM Inference Platform",
    role: "Author",
    blurb:
      "Self-hosted LLM and inference platform layered with real developer/team AI workflows: GPU substrate, vLLM/KServe, GIE routing, LiteLLM budgets, observability, and developer AI workflows.",
    href: "/projects/kubernetes-llm-inference-platform",
  },
  {
    name: "KubeLB",
    role: "Project lead",
    blurb:
      "Centralized L4/L7 load balancing for multi-cluster Kubernetes. Gateway API, dashboard, observability.",
    href: "https://github.com/kubermatic/kubelb",
  },
  {
    name: "Kubermatic Kubernetes Platform",
    role: "Core contributor",
    blurb:
      "Central management platform for Kubernetes across any infrastructure.",
    href: "https://github.com/kubermatic/kubermatic",
  },
  {
    name: "KubeOne",
    role: "Core contributor",
    blurb:
      "Automated Kubernetes cluster lifecycle: declarative install, upgrade, and operations across cloud and on-prem.",
    href: "https://github.com/kubermatic/kubeone",
  },
  {
    name: "Kubermatic Dashboard",
    role: "Core contributor",
    blurb:
      "The web UI for the Kubermatic Kubernetes Platform: self-service cluster provisioning and multi-cluster management. Angular and TypeScript.",
    href: "https://github.com/kubermatic/dashboard",
  },
  {
    name: "Machine Controller / OSM",
    role: "Lead maintainer",
    blurb:
      "Cluster API-driven worker-node lifecycle and OS configuration across 10+ cloud providers.",
    href: "https://github.com/kubermatic/machine-controller",
  },
  {
    name: "Reloader",
    role: "Lead developer",
    blurb:
      "Watches ConfigMaps/Secrets and rolls dependent workloads automatically on change.",
    href: "https://github.com/stakater/Reloader",
  },
  {
    name: "IngressMonitorController",
    role: "Lead developer",
    blurb:
      "Kubernetes controller that watches ingresses and provisions external liveness/uptime alerts.",
    href: "https://github.com/stakater/IngressMonitorController",
  },
];
