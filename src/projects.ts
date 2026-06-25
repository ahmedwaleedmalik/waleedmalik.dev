export type Project = {
  name: string;
  role: string;
  blurb: string;
  href: string;
  stars?: string;
};

export const PROJECTS: Project[] = [
  {
    name: 'KubeLB',
    role: 'Creator & lead maintainer',
    blurb: 'Centralized L4/L7 load balancing for multi-cluster Kubernetes. Gateway API, dashboard, observability.',
    href: 'https://github.com/kubermatic/kubelb',
  },
  {
    name: 'Reloader',
    role: 'Lead developer',
    blurb: 'Watches ConfigMaps/Secrets and rolls dependent workloads automatically on change.',
    href: 'https://github.com/stakater/Reloader',
  },
  {
    name: 'IngressMonitorController',
    role: 'Lead developer',
    blurb: 'Kubernetes controller that watches ingresses and provisions external liveness/uptime alerts.',
    href: 'https://github.com/stakater/IngressMonitorController',
  },
  {
    name: 'Machine Controller / OSM',
    role: 'Lead maintainer',
    blurb: 'Cluster API-driven worker-node lifecycle and OS configuration across 10+ cloud providers.',
    href: 'https://github.com/kubermatic/machine-controller',
  },
  {
    name: 'Kubermatic Kubernetes Platform',
    role: 'Core contributor',
    blurb: 'Central management platform for Kubernetes across any infrastructure.',
    href: 'https://github.com/kubermatic/kubermatic',
  },
  {
    name: 'Kubernetes LLM Inference Platform',
    role: 'Author',
    blurb: 'Portable self-hosted LLM platform: GPU substrate, vLLM/KServe, GIE routing, LiteLLM budgets, observability, and developer AI workflows.',
    href: '/projects/kubernetes-llm-inference-platform',
  },
];
