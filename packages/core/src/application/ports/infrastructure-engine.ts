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
}

/** Callback receiving streamed engine output line by line. */
export type EngineEventSink = (event: EngineEvent) => void;

/** Summary of a preview: how many resources would change. */
export interface PreviewResult {
  readonly changes: Readonly<Record<string, number>>;
}

/** Result of an apply: the stack's outputs. */
export interface ApplyResult {
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly summary: string;
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
  ): Promise<Result<PreviewResult, InfrastructureError>>;

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
