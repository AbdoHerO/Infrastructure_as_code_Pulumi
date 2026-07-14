import type { InfrastructureError, Result } from '@cloudforge/shared';
import type { InfrastructurePlan } from '../infrastructure/infrastructure-plan.js';
import type { ProviderCredentials } from './provider-factory.js';

/** Identifies a single stack: one environment of one project. */
export interface StackReference {
  readonly project: string;
  readonly stack: string;
}

/** A streamed event emitted while an engine operation runs. */
export interface EngineEvent {
  readonly stream: 'stdout' | 'stderr';
  readonly message: string;
  readonly progress?: EngineProgress;
}

/** Structured progress derived from the IaC engine's real resource events. */
export interface EngineProgress {
  readonly scope: 'operation' | 'resource';
  readonly status: 'preparing' | 'in-progress' | 'ready' | 'failed';
  readonly label: string;
  readonly operation?: string;
  readonly resource?: {
    readonly name: string;
    readonly type: string;
  };
}

/** Callback receiving streamed engine output line by line. */
export type EngineEventSink = (event: EngineEvent) => void;

export type PreviewOperation = 'create' | 'update' | 'replace' | 'delete' | 'same';

/** One provider-independent resource operation reported by the IaC engine. */
export interface PreviewResourceChange {
  readonly urn: string;
  readonly name: string;
  readonly type: string;
  readonly operation: PreviewOperation;
  readonly destructive: boolean;
  readonly changedProperties: readonly string[];
  readonly replacementProperties: readonly string[];
}

/** Engine-produced preview analysis before Application-layer authorization. */
export interface PreviewAnalysis {
  readonly changes: Readonly<Record<string, number>>;
  readonly resources: readonly PreviewResourceChange[];
  readonly hasReplacements: boolean;
  readonly hasDeletes: boolean;
}

/** Preview returned to Presentation with a one-use safe-apply authorization. */
export interface PreviewResult extends PreviewAnalysis {
  readonly previewToken: string;
}

/** Result of an apply: the stack's outputs. */
export interface ApplyResult {
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly summary: string;
  readonly targetSync?: {
    readonly count: number;
    readonly warnings: readonly string[];
  };
}

/** A cloud resource tracked by a local infrastructure stack. */
export interface ManagedResourceSummary {
  readonly name: string;
  readonly type: string;
  readonly provider: string;
}

/** A locally-managed stack, including stacks whose project record was removed. */
export interface ManagedStackSummary {
  readonly ref: StackReference;
  readonly resources: readonly ManagedResourceSummary[];
  readonly updatedAt: string | null;
}

/**
 * Port abstracting the Infrastructure-as-Code engine. The concrete
 * implementation (Pulumi Automation API) lives in `@cloudforge/pulumi`; the
 * Application and Presentation layers never reference Pulumi directly.
 */
export interface InfrastructureEngine {
  /** Whether the engine is usable on this machine (e.g. the CLI is installed). */
  isAvailable(): Promise<Result<boolean, InfrastructureError>>;

  /** Discover every stack in the app's local backend, including orphaned stacks. */
  listManagedStacks(): Promise<Result<ManagedStackSummary[], InfrastructureError>>;

  /**
   * Dry-run: compute the changes a plan would make. Provider credentials are
   * required because the engine instantiates the real provider to diff against
   * the live cloud account.
   */
  preview(
    ref: StackReference,
    plan: InfrastructurePlan,
    credentials: ProviderCredentials,
    onEvent?: EngineEventSink,
  ): Promise<Result<PreviewAnalysis, InfrastructureError>>;

  /**
   * Apply a plan, provisioning or updating real cloud infrastructure. Provider
   * credentials authenticate the engine against the target account.
   */
  apply(
    ref: StackReference,
    plan: InfrastructurePlan,
    credentials: ProviderCredentials,
    onEvent?: EngineEventSink,
  ): Promise<Result<ApplyResult, InfrastructureError>>;

  /** Refresh the stack's state to match reality. */
  refresh(
    ref: StackReference,
    onEvent?: EngineEventSink,
  ): Promise<Result<void, InfrastructureError>>;

  /** Destroy all resources in the stack. */
  destroy(
    ref: StackReference,
    onEvent?: EngineEventSink,
  ): Promise<Result<void, InfrastructureError>>;

  /** Read the current outputs of a stack. */
  outputs(ref: StackReference): Promise<Result<Record<string, unknown>, InfrastructureError>>;
}
