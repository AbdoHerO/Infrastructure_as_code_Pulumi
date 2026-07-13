import { execFile } from 'node:child_process';
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
  PreviewResult,
  StackReference,
} from '@cloudforge/core';
import { buildProgram } from './build-program.js';

/** Configuration for the local Pulumi engine. */
export interface PulumiEngineOptions {
  /** `PULUMI_HOME` directory (plugins, credentials). */
  readonly home: string;
  /** Local backend URL, e.g. `file:///path/to/state`. */
  readonly backendUrl: string;
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

  async preview(
    ref: StackReference,
    plan: InfrastructurePlan,
    onEvent?: EngineEventSink,
  ): Promise<Result<PreviewResult, InfrastructureError>> {
    return this.withStack(ref, plan, async (stack) => {
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
    onEvent?: EngineEventSink,
  ): Promise<Result<ApplyResult, InfrastructureError>> {
    return this.withStack(ref, plan, async (stack) => {
      const result = await stack.up(outputOpts(onEvent));
      return { outputs: mapOutputs(result.outputs), summary: result.summary.result };
    });
  }

  async refresh(
    ref: StackReference,
    onEvent?: EngineEventSink,
  ): Promise<Result<void, InfrastructureError>> {
    return this.withStack(ref, emptyPlan(), async (stack) => {
      await stack.refresh(outputOpts(onEvent));
    });
  }

  async destroy(
    ref: StackReference,
    onEvent?: EngineEventSink,
  ): Promise<Result<void, InfrastructureError>> {
    return this.withStack(ref, emptyPlan(), async (stack) => {
      await stack.destroy(outputOpts(onEvent));
    });
  }

  async outputs(
    ref: StackReference,
  ): Promise<Result<Record<string, unknown>, InfrastructureError>> {
    return this.withStack(ref, emptyPlan(), async (stack) => mapOutputs(await stack.outputs()));
  }

  /** Create/select the stack and run an operation, normalising failures. */
  private async withStack<T>(
    ref: StackReference,
    plan: InfrastructurePlan,
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

      const stack = await LocalWorkspace.createOrSelectStack(
        { stackName: ref.stack, projectName: ref.project, program: buildProgram(plan) },
        workspaceOptions,
      );

      if (Object.keys(plan.config).length > 0) {
        const config: ConfigMap = {};
        for (const [key, value] of Object.entries(plan.config)) {
          config[key] = { value };
        }
        await stack.setAllConfig(config);
      }

      return ok(await operation(stack));
    } catch (cause) {
      return err(
        new InfrastructureError('Pulumi operation failed', {
          cause,
          context: { project: ref.project, stack: ref.stack },
        }),
      );
    }
  }
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
