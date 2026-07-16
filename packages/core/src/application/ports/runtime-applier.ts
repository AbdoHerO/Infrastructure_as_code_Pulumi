import type { DeploymentError, Result } from '@cloudforge/shared';
import type { VpsRuntimePlan } from '../vps-runtime/vps-runtime-plan.js';
import type { RuntimeOperation } from '../vps-runtime/runtime-operations.js';
import type { DeploymentTarget } from './deployer.js';

/** Progress from a runtime apply, streamed to the UI as it happens. */
export interface RuntimeApplyEvent {
  readonly stream: 'step' | 'stdout' | 'stderr' | 'error';
  readonly message: string;
}

export type RuntimeApplyEventSink = (event: RuntimeApplyEvent) => void;

export interface RuntimeOperationOutcome {
  readonly operationId: string;
  readonly status: 'applied' | 'failed' | 'skipped';
  readonly message: string;
}

export interface RuntimeApplyReport {
  readonly outcomes: readonly RuntimeOperationOutcome[];
  readonly applied: number;
  readonly failed: number;
}

/**
 * Executes runtime operations against a VPS.
 *
 * Implementations must execute exactly the operations they are given, in order,
 * and nothing else — the preview the user approved *is* this list, so an applier
 * that improvises makes the preview a lie.
 *
 * A failure stops the run. Docker's runtime layer has real dependencies between
 * operations (a container cannot join a network that failed to be created), and
 * continuing past a failure turns one clear error into a cascade of confusing
 * ones.
 */
export interface RuntimeApplier {
  apply(
    target: DeploymentTarget,
    plan: VpsRuntimePlan,
    operations: readonly RuntimeOperation[],
    onEvent?: RuntimeApplyEventSink,
    signal?: AbortSignal,
  ): Promise<Result<RuntimeApplyReport, DeploymentError>>;
}
