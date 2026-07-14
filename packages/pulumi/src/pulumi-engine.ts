import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ConfigMap,
  type EngineEvent as PulumiEngineEvent,
  LocalWorkspace,
  type LocalWorkspaceOptions,
  type OutputMap,
  type Stack,
} from '@pulumi/pulumi/automation';
import { err, InfrastructureError, ok, type Result } from '@cloudforge/shared';
import type {
  ApplyResult,
  EngineEvent,
  EngineEventSink,
  InfrastructureEngine,
  InfrastructurePlan,
  ManagedResourceSummary,
  ManagedStackSummary,
  PreviewAnalysis,
  PreviewResourceChange,
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
  ): Promise<Result<PreviewAnalysis, InfrastructureError>> {
    return this.withStack(ref, plan, credentials, true, onEvent, async (stack) => {
      const resourceChanges = new Map<string, PreviewResourceChange>();
      const result = await stack.preview(outputOpts(onEvent, 'preview', resourceChanges));
      const changes: Record<string, number> = {};
      for (const [op, count] of Object.entries(result.changeSummary)) {
        if (typeof count === 'number') changes[op] = count;
      }
      const resources = [...resourceChanges.values()].sort((a, b) => a.name.localeCompare(b.name));
      return {
        changes,
        resources,
        hasReplacements: resources.some((resource) => resource.operation === 'replace'),
        hasDeletes: resources.some((resource) => resource.operation === 'delete'),
      };
    });
  }

  async apply(
    ref: StackReference,
    plan: InfrastructurePlan,
    credentials: ProviderCredentials,
    onEvent?: EngineEventSink,
  ): Promise<Result<ApplyResult, InfrastructureError>> {
    return this.withStack(ref, plan, credentials, true, onEvent, async (stack) => {
      const result = await stack.up(outputOpts(onEvent, 'apply'));
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
      await stack.refresh(outputOpts(onEvent, 'refresh'));
    });
  }

  async destroy(
    ref: StackReference,
    onEvent?: EngineEventSink,
  ): Promise<Result<void, InfrastructureError>> {
    return this.withStack(ref, emptyPlan(), undefined, false, onEvent, async (stack) => {
      await stack.destroy(outputOpts(onEvent, 'destroy'));
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
      onEvent?.({
        stream: 'stdout',
        message: 'Preparing infrastructure engine',
        progress: {
          scope: 'operation',
          status: 'preparing',
          label: 'Preparing infrastructure engine',
        },
      });
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
      onEvent?.({
        stream: 'stderr',
        message: detail,
        progress: {
          scope: 'operation',
          status: 'failed',
          label: 'Infrastructure operation failed',
        },
      });
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
  const provider = rawType.startsWith('pulumi:providers:')
    ? (rawType.split(':').at(-1) ?? 'unknown')
    : (rawType.split(':')[0] ?? 'unknown');
  return {
    name: urnParts.at(-1) ?? 'unknown',
    type: friendlyResourceType(rawType),
    provider,
  };
}

function friendlyResourceType(type: string): string {
  if (type.startsWith('pulumi:providers:')) return 'Provider';
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
type InfrastructureOperation = 'preview' | 'apply' | 'refresh' | 'destroy';

function outputOpts(
  onEvent: EngineEventSink | undefined,
  operation: InfrastructureOperation,
  previewChanges?: Map<string, PreviewResourceChange>,
): {
  onOutput?: (out: string) => void;
  onEvent?: (event: PulumiEngineEvent) => void;
} {
  if (!onEvent && !previewChanges) return {};
  let failed = false;
  let completed = false;
  return {
    ...(onEvent ? { onOutput: (out: string) => onEvent({ stream: 'stdout', message: out }) } : {}),
    onEvent: (event: PulumiEngineEvent) => {
      capturePreviewChange(event, previewChanges);
      const mapped = toProgressEvent(event, failed, operation, completed);
      if (!mapped) return;
      if (mapped.progress?.status === 'failed') failed = true;
      if (event.summaryEvent && mapped.progress?.status === 'ready') completed = true;
      onEvent?.(mapped);
    },
  };
}

/** Capture the real Pulumi planned operations without leaking provider types. */
export function capturePreviewChange(
  event: PulumiEngineEvent,
  changes: Map<string, PreviewResourceChange> | undefined,
): void {
  const resourceEvent = event.resourcePreEvent;
  if (!changes || !resourceEvent?.planning) return;
  const metadata = resourceEvent.metadata;
  if (metadata.type === 'pulumi:pulumi:Stack' || metadata.op === 'same') return;
  const resource = resourceFromMetadata(metadata);
  const operation = previewOperation(metadata.op);
  const detailed = metadata.detailedDiff ?? {};
  const changedProperties = [...new Set([...(metadata.diffs ?? []), ...Object.keys(detailed)])];
  const replacementProperties = [
    ...new Set([
      ...(metadata.keys ?? []),
      ...Object.entries(detailed)
        .filter(([, diff]) => diff.diffKind.endsWith('-replace'))
        .map(([property]) => property),
    ]),
  ];
  const existing = changes.get(metadata.urn);
  const strongest = strongerOperation(existing?.operation, operation);
  changes.set(metadata.urn, {
    urn: metadata.urn,
    ...resource,
    operation: strongest,
    destructive: strongest === 'replace' || strongest === 'delete',
    changedProperties: [...new Set([...(existing?.changedProperties ?? []), ...changedProperties])],
    replacementProperties: [
      ...new Set([...(existing?.replacementProperties ?? []), ...replacementProperties]),
    ],
  });
}

function previewOperation(operation: string): PreviewResourceChange['operation'] {
  if (operation === 'update') return 'update';
  if (operation === 'delete') return 'delete';
  if (
    operation.includes('replacement') ||
    operation.includes('replaced') ||
    operation === 'replace'
  )
    return 'replace';
  if (operation === 'same') return 'same';
  return 'create';
}

function strongerOperation(
  current: PreviewResourceChange['operation'] | undefined,
  next: PreviewResourceChange['operation'],
): PreviewResourceChange['operation'] {
  const weight: Record<PreviewResourceChange['operation'], number> = {
    same: 0,
    update: 1,
    create: 2,
    delete: 3,
    replace: 4,
  };
  return current && weight[current] >= weight[next] ? current : next;
}

/** Translate Pulumi's structured events into provider-independent UI progress. */
export function toProgressEvent(
  event: PulumiEngineEvent,
  operationFailed = false,
  operation: InfrastructureOperation = 'apply',
  operationCompleted = false,
): EngineEvent | null {
  if (event.preludeEvent) {
    return progressEvent('operation', 'preparing', 'Calculating infrastructure changes');
  }

  if (event.resourcePreEvent) {
    const { metadata, planning } = event.resourcePreEvent;
    if (metadata.op === 'same' || metadata.type === 'pulumi:pulumi:Stack') return null;
    const resource = resourceFromMetadata(metadata);
    const action = planning
      ? `Planning ${operationLabel(metadata.op)}`
      : operationLabel(metadata.op);
    return progressEvent(
      'resource',
      'in-progress',
      `${action} ${resource.type} “${resource.name}”`,
      metadata.op,
      resource,
    );
  }

  if (event.resOpFailedEvent) {
    const { metadata } = event.resOpFailedEvent;
    const resource = resourceFromMetadata(metadata);
    return progressEvent(
      'resource',
      'failed',
      `${resource.type} “${resource.name}” failed`,
      metadata.op,
      resource,
    );
  }

  if (event.resOutputsEvent) {
    const { metadata, planning } = event.resOutputsEvent;
    if (metadata.op === 'same' || metadata.type === 'pulumi:pulumi:Stack') return null;
    const resource = resourceFromMetadata(metadata);
    return progressEvent(
      'resource',
      'ready',
      `${resource.type} “${resource.name}” ${planning ? 'planned' : completionLabel(metadata.op)}`,
      metadata.op,
      resource,
    );
  }

  if (event.summaryEvent) {
    const status = operationFailed || event.summaryEvent.maybeCorrupt ? 'failed' : 'ready';
    return progressEvent(
      'operation',
      status,
      status === 'ready'
        ? `${operationCompleteLabel(operation)} in ${formatDuration(event.summaryEvent.durationSeconds)}`
        : 'Infrastructure operation finished with errors',
    );
  }

  if (event.cancelEvent) {
    // Pulumi can emit cancelEvent while tearing down its event stream after a
    // successful summary. A terminal event must never overwrite that success.
    if (operationCompleted) return null;
    return progressEvent('operation', 'failed', 'Infrastructure operation cancelled');
  }

  return null;
}

function operationCompleteLabel(operation: InfrastructureOperation): string {
  switch (operation) {
    case 'preview':
      return 'Preview ready';
    case 'refresh':
      return 'Cloud state refreshed';
    case 'destroy':
      return 'Infrastructure destroyed';
    default:
      return 'Infrastructure ready';
  }
}

function progressEvent(
  scope: 'operation' | 'resource',
  status: 'preparing' | 'in-progress' | 'ready' | 'failed',
  label: string,
  operation?: string,
  resource?: { name: string; type: string },
): EngineEvent {
  return {
    stream: status === 'failed' ? 'stderr' : 'stdout',
    message: label,
    progress: {
      scope,
      status,
      label,
      ...(operation ? { operation } : {}),
      ...(resource ? { resource } : {}),
    },
  };
}

function resourceFromMetadata(metadata: { urn: string; type: string }): {
  name: string;
  type: string;
} {
  return {
    name: metadata.urn.split('::').at(-1) ?? 'unknown',
    type: friendlyResourceType(metadata.type),
  };
}

function operationLabel(operation: string): string {
  switch (operation) {
    case 'create':
    case 'create-replacement':
      return 'Creating';
    case 'update':
      return 'Updating';
    case 'delete':
    case 'delete-replaced':
      return 'Deleting';
    case 'replace':
      return 'Replacing';
    case 'refresh':
      return 'Refreshing';
    default:
      return 'Processing';
  }
}

function completionLabel(operation: string): string {
  return operation.startsWith('delete') ? 'deleted' : 'ready';
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
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
