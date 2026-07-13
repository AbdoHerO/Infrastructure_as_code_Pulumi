import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ConfigMap,
  LocalWorkspace,
  type LocalWorkspaceOptions,
  type OutputMap,
  type Stack,
} from '@pulumi/pulumi/automation';
import { err, InfrastructureError, ok, type Result } from '@cloudforge/shared';
import type {
  ApplyResult,
  EngineEventSink,
  InfrastructureEngine,
  InfrastructurePlan,
  ManagedResourceSummary,
  ManagedStackSummary,
  PreviewResult,
  ProviderCredentials,
  StackReference,
} from '@cloudforge/core';
import { buildProgram } from './build-program.js';

/** Configuration for the local Pulumi engine. */
export interface PulumiEngineOptions {
  /** `PULUMI_HOME` directory (plugins, credentials). */
  readonly home: string;
  /** Local backend URL, e.g. `file:///path/to/state`. */
  readonly backendUrl: string;
  /** Absolute path backing the local file backend. */
  readonly stateDir: string;
  /** Passphrase used to encrypt local stack secrets. */
  readonly passphrase: string;
}

/**
 * Pulumi Automation API implementation of {@link InfrastructureEngine}. The rest
 * of the application only ever sees the port — Pulumi is fully encapsulated here.
 */
export class PulumiEngine implements InfrastructureEngine {
  constructor(private readonly options: PulumiEngineOptions) {}

  async isAvailable(): Promise<Result<boolean, InfrastructureError>> {
    return new Promise((resolve) => {
      execFile('pulumi', ['version'], (error) => {
        resolve(ok(error === null));
      });
    });
  }

  async listManagedStacks(): Promise<Result<ManagedStackSummary[], InfrastructureError>> {
    try {
      const root = join(this.options.stateDir, '.pulumi', 'stacks');
      const projects = await readdir(root, { withFileTypes: true }).catch((cause: unknown) => {
        if (isMissingPath(cause)) return [];
        throw cause;
      });
      const stacks: ManagedStackSummary[] = [];

      for (const projectEntry of projects) {
        if (!projectEntry.isDirectory()) continue;
        const project = projectEntry.name;
        const projectDir = join(root, project);
        const files = await readdir(projectDir, { withFileTypes: true });
        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith('.json')) continue;
          const stack = file.name.slice(0, -'.json'.length);
          const checkpoint = parseCheckpoint(await readFile(join(projectDir, file.name), 'utf8'));
          if (checkpoint.resources.length === 0) continue;
          stacks.push({
            ref: { project, stack },
            resources: checkpoint.resources,
            updatedAt: checkpoint.updatedAt,
          });
        }
      }

      return ok(stacks.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')));
    } catch (cause) {
      return err(
        new InfrastructureError('Failed to read managed infrastructure stacks', { cause }),
      );
    }
  }

  async preview(
    ref: StackReference,
    plan: InfrastructurePlan,
    credentials: ProviderCredentials,
    onEvent?: EngineEventSink,
  ): Promise<Result<PreviewResult, InfrastructureError>> {
    return this.withStack(ref, plan, credentials, true, onEvent, async (stack) => {
      const result = await stack.preview(outputOpts(onEvent));
      const changes: Record<string, number> = {};
      for (const [op, count] of Object.entries(result.changeSummary)) {
        if (typeof count === 'number') changes[op] = count;
      }
      return { changes };
    });
  }

  async apply(
    ref: StackReference,
    plan: InfrastructurePlan,
    credentials: ProviderCredentials,
    onEvent?: EngineEventSink,
  ): Promise<Result<ApplyResult, InfrastructureError>> {
    return this.withStack(ref, plan, credentials, true, onEvent, async (stack) => {
      const result = await stack.up(outputOpts(onEvent));
      return { outputs: mapOutputs(result.outputs), summary: result.summary.result };
    });
  }

  async refresh(
    ref: StackReference,
    onEvent?: EngineEventSink,
  ): Promise<Result<void, InfrastructureError>> {
    // Refresh/destroy operate on stored state; the provider (including its
    // credentials) is reconstituted from the stack state, so none are supplied.
    return this.withStack(ref, emptyPlan(), undefined, false, onEvent, async (stack) => {
      await stack.refresh(outputOpts(onEvent));
    });
  }

  async destroy(
    ref: StackReference,
    onEvent?: EngineEventSink,
  ): Promise<Result<void, InfrastructureError>> {
    return this.withStack(ref, emptyPlan(), undefined, false, onEvent, async (stack) => {
      await stack.destroy(outputOpts(onEvent));
    });
  }

  async outputs(
    ref: StackReference,
  ): Promise<Result<Record<string, unknown>, InfrastructureError>> {
    return this.withStack(ref, emptyPlan(), undefined, false, undefined, async (stack) =>
      mapOutputs(await stack.outputs()),
    );
  }

  /** Create/select the stack and run an operation, normalising failures. */
  private async withStack<T>(
    ref: StackReference,
    plan: InfrastructurePlan,
    credentials: ProviderCredentials | undefined,
    createIfMissing: boolean,
    onEvent: EngineEventSink | undefined,
    operation: (stack: Stack) => Promise<T>,
  ): Promise<Result<T, InfrastructureError>> {
    try {
      const workspaceOptions: LocalWorkspaceOptions = {
        pulumiHome: this.options.home,
        envVars: {
          PULUMI_CONFIG_PASSPHRASE: this.options.passphrase,
          PULUMI_BACKEND_URL: this.options.backendUrl,
        },
        projectSettings: {
          name: ref.project,
          runtime: 'nodejs',
          backend: { url: this.options.backendUrl },
        },
      };

      const stackArgs = {
        stackName: ref.stack,
        projectName: ref.project,
        program: buildProgram(plan, credentials),
      };
      const stack = createIfMissing
        ? await LocalWorkspace.createOrSelectStack(stackArgs, workspaceOptions)
        : await LocalWorkspace.selectStack(stackArgs, workspaceOptions);

      if (Object.keys(plan.config).length > 0) {
        const config: ConfigMap = {};
        for (const [key, value] of Object.entries(plan.config)) {
          config[key] = { value };
        }
        await stack.setAllConfig(config);
      }

      return ok(await operation(stack));
    } catch (cause) {
      // Surface the real Pulumi/CLI error to the live log and the error message,
      // so failures are diagnosable instead of a bare "operation failed".
      const detail = cause instanceof Error ? cause.message : String(cause);
      onEvent?.({ stream: 'stderr', message: detail });
      return err(
        new InfrastructureError(`Pulumi operation failed: ${firstLine(detail)}`, {
          cause,
          context: { project: ref.project, stack: ref.stack },
        }),
      );
    }
  }
}

interface PulumiCheckpoint {
  readonly checkpoint?: {
    readonly latest?: {
      readonly manifest?: { readonly time?: string };
      readonly resources?: readonly {
        readonly urn?: string;
        readonly type?: string;
        readonly id?: string;
      }[];
    };
  };
}

function parseCheckpoint(raw: string): {
  resources: ManagedResourceSummary[];
  updatedAt: string | null;
} {
  const parsed = JSON.parse(raw) as PulumiCheckpoint;
  const latest = parsed.checkpoint?.latest;
  const resources = (latest?.resources ?? [])
    .filter((resource) => resource.type !== 'pulumi:pulumi:Stack' && resource.id)
    .map((resource) => toManagedResource(resource));
  return { resources, updatedAt: latest?.manifest?.time ?? null };
}

function toManagedResource(resource: {
  readonly urn?: string;
  readonly type?: string;
}): ManagedResourceSummary {
  const urnParts = (resource.urn ?? '').split('::');
  const rawType = resource.type ?? 'unknown';
  const provider =
    rawType === 'pulumi:providers:oci' ? 'oci' : (rawType.split(':')[0] ?? 'unknown');
  return {
    name: urnParts.at(-1) ?? 'unknown',
    type: friendlyResourceType(rawType),
    provider,
  };
}

function friendlyResourceType(type: string): string {
  if (type === 'pulumi:providers:oci') return 'Provider';
  const token = type.split(':').at(-1) ?? type;
  return token.split('/').at(-1) ?? token;
}

function isMissingPath(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: unknown }).code === 'ENOENT'
  );
}

/** Build the `{ onOutput }` options object, omitting the key when no sink is given. */
function outputOpts(onEvent?: EngineEventSink): { onOutput?: (out: string) => void } {
  return onEvent ? { onOutput: (out: string) => onEvent({ stream: 'stdout', message: out }) } : {};
}

function mapOutputs(outputs: OutputMap): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, output] of Object.entries(outputs)) {
    result[key] = output.secret ? '[secret]' : output.value;
  }
  return result;
}

/** Refresh/destroy/outputs don't need the plan; supply an empty one. */
function emptyPlan(): InfrastructurePlan {
  return { providerKind: '', config: {}, resources: [] };
}

/** First non-empty line of a (possibly multi-line) error message, trimmed. */
function firstLine(message: string): string {
  const line = message
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? 'unknown error').slice(0, 300);
}
