import type { InfrastructureError, Result } from '@cloudforge/shared';
import type { InfrastructurePlan } from '../infrastructure/infrastructure-plan.js';

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

/**
 * Port abstracting the Infrastructure-as-Code engine. The concrete
 * implementation (Pulumi Automation API) lives in `@cloudforge/pulumi`; the
 * Application and Presentation layers never reference Pulumi directly.
 */
export interface InfrastructureEngine {
  /** Whether the engine is usable on this machine (e.g. the CLI is installed). */
  isAvailable(): Promise<Result<boolean, InfrastructureError>>;

  /** Dry-run: compute the changes a plan would make. */
  preview(
    ref: StackReference,
    plan: InfrastructurePlan,
    onEvent?: EngineEventSink,
  ): Promise<Result<PreviewResult, InfrastructureError>>;

  /** Apply a plan, provisioning or updating infrastructure. */
  apply(
    ref: StackReference,
    plan: InfrastructurePlan,
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
