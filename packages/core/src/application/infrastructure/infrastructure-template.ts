import type { InfrastructurePlan, ResourceSpec } from './infrastructure-plan.js';

/** Inputs a template may weave into the generated plan. */
export interface InfraTemplateContext {
  readonly region?: string;
  readonly sshPublicKey?: string;
  readonly shape?: string;
}

/** A predefined, reusable infrastructure template. */
export interface InfrastructureTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: 'compute' | 'data' | 'ai' | 'network';
  readonly build: (context: InfraTemplateContext) => InfrastructurePlan;
}

function base(context: InfraTemplateContext): { config: Record<string, string> } {
  return { config: context.region ? { region: context.region } : {} };
}

function network(): ResourceSpec {
  return { kind: 'network', name: 'network', cidrBlock: '10.0.0.0/16' };
}
function subnet(isPublic: boolean): ResourceSpec {
  return {
    kind: 'subnet',
    name: 'subnet',
    networkName: 'network',
    cidrBlock: '10.0.1.0/24',
    public: isPublic,
  };
}
function compute(shape: string, ctx: InfraTemplateContext): ResourceSpec {
  return {
    kind: 'compute',
    name: 'instance',
    shape,
    image: 'ubuntu-22.04',
    subnetName: 'subnet',
    sshPublicKey: ctx.sshPublicKey ?? '',
    assignPublicIp: true,
    ocpus: 1,
    memoryGb: 8,
    bootVolumeGb: 50,
  };
}
function firewall(ports: readonly number[]): ResourceSpec {
  return {
    kind: 'firewall',
    name: 'firewall',
    networkName: 'network',
    rules: ports.map((port) => ({
      protocol: 'tcp' as const,
      port,
      source: '0.0.0.0/0',
      direction: 'ingress' as const,
    })),
  };
}

/** The built-in infrastructure templates. */
export const INFRASTRUCTURE_TEMPLATES: readonly InfrastructureTemplate[] = [
  {
    id: 'oci-always-free-arm',
    name: 'OCI Always Free ARM VPS',
    description:
      'Ubuntu 24.04 ARM64: A1 Flex, 2 OCPUs, 12 GB RAM and a 200 GB boot disk. Uses the current documented Always Free compute and storage allowances; verify tenancy usage.',
    category: 'compute',
    build: (ctx) => ({
      providerKind: 'oracle',
      ...base(ctx),
      resources: [
        network(),
        subnet(true),
        firewall([22, 80, 443]),
        {
          kind: 'compute',
          name: 'always-free-arm',
          shape: 'VM.Standard.A1.Flex',
          image: 'ubuntu-24.04',
          subnetName: 'subnet',
          sshPublicKey: ctx.sshPublicKey ?? '',
          assignPublicIp: true,
          ocpus: 2,
          memoryGb: 12,
          bootVolumeGb: 200,
        },
      ],
    }),
  },
  {
    id: 'web-server',
    name: 'Web Server',
    description: 'A public VM with HTTP/HTTPS open — ideal for a Docker host.',
    category: 'compute',
    build: (ctx) => ({
      providerKind: 'oracle',
      ...base(ctx),
      resources: [
        network(),
        subnet(true),
        firewall([22, 80, 443]),
        compute(ctx.shape ?? 'VM.Standard.E4.Flex', ctx),
      ],
    }),
  },
  {
    id: 'ai-server',
    name: 'AI Server',
    description: 'A larger VM exposing the Ollama port for model serving.',
    category: 'ai',
    build: (ctx) => ({
      providerKind: 'oracle',
      ...base(ctx),
      resources: [
        network(),
        subnet(true),
        firewall([22, 443, 11434]),
        compute(ctx.shape ?? 'VM.Standard.E4.Flex', ctx),
      ],
    }),
  },
  {
    id: 'database',
    name: 'Database Host',
    description: 'A VM with an attached block volume and Postgres port open.',
    category: 'data',
    build: (ctx) => ({
      providerKind: 'oracle',
      ...base(ctx),
      resources: [
        network(),
        subnet(false),
        firewall([22, 5432]),
        compute(ctx.shape ?? 'VM.Standard.E4.Flex', ctx),
        { kind: 'volume', name: 'data', sizeGb: 100, attachTo: 'instance' },
      ],
    }),
  },
  {
    id: 'k8s-node',
    name: 'Kubernetes Node',
    description: 'A VM prepared to join a Kubernetes cluster.',
    category: 'compute',
    build: (ctx) => ({
      providerKind: 'oracle',
      ...base(ctx),
      resources: [
        network(),
        subnet(true),
        firewall([22, 6443, 10250]),
        compute(ctx.shape ?? 'VM.Standard.E4.Flex', ctx),
      ],
    }),
  },
];

/** Look up an infrastructure template by id. */
export function findInfrastructureTemplate(id: string): InfrastructureTemplate | undefined {
  return INFRASTRUCTURE_TEMPLATES.find((template) => template.id === id);
}

/** Transport-safe summary of an infrastructure template. */
export interface InfrastructureTemplateSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: InfrastructureTemplate['category'];
}

/** List infrastructure templates as transport-safe summaries. */
export function listInfrastructureTemplateSummaries(): InfrastructureTemplateSummary[] {
  return INFRASTRUCTURE_TEMPLATES.map(({ id, name, description, category }) => ({
    id,
    name,
    description,
    category,
  }));
}
