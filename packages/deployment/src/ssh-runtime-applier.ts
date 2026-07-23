/**
 * Executes runtime operations against a VPS over verified SSH.
 *
 * Executes exactly the operations it is handed, in order, and derives nothing of
 * its own. The list came from a preview a person approved; an applier that
 * decided anything for itself would make that approval meaningless.
 *
 * Every value that reaches a shell is either drawn from a plan the validator has
 * already constrained to `[a-zA-Z0-9_.-]`, or quoted. Both, in fact — the quoting
 * is not load-bearing on top of validation, it is there because relying on
 * validation alone means one relaxed regex years from now becomes a command
 * injection.
 */
import type {
  DeploymentTarget,
  RuntimeApplier,
  RuntimeApplyEventSink,
  RuntimeApplyReport,
  RuntimeOperation,
  RuntimeOperationOutcome,
  VpsRuntimePlan,
} from '@cloudforge/core';
import { networksByDockerName, ownershipLabels } from '@cloudforge/core';
import { type DeploymentError, err, ok, type Result } from '@cloudforge/shared';
import { execCommand, quote, withSshConnection } from './ssh-transport.js';

const LABEL = 'Runtime';
const TIMEOUT_MS = 60_000;

/**
 * A last line of defence, not the first.
 *
 * `validateRuntimePlan` already rejects names outside this shape, and every name
 * is quoted before it reaches a shell. This exists because an applier is the
 * wrong place to discover that an earlier layer was loosened.
 */
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** The Docker command for one operation, or null when its id is unrecognised. */
export function commandFor(
  operation: RuntimeOperation,
  plan: VpsRuntimePlan,
): Result<string, string> {
  const [kind] = operation.id.split(':');
  const networks = networksByDockerName(plan);

  if (kind === 'network.create') {
    const network = networks.get(operation.dockerName);
    if (!network) return err(`The plan no longer describes network "${operation.dockerName}"`);
    if (!SAFE_NAME.test(network.dockerName)) return err(`Unsafe network name`);
    const labels = ownershipLabels(plan, 'network');
    const flags = [
      `--driver ${quote(network.driver)}`,
      ...(network.internal ? ['--internal'] : []),
      ...(network.attachable ? ['--attachable'] : []),
      ...(network.ipv6 ? ['--ipv6'] : []),
      ...Object.entries({ ...network.labels, ...labels }).map(
        ([key, value]) => `--label ${quote(`${key}=${value}`)}`,
      ),
    ];
    return ok(`sudo docker network create ${flags.join(' ')} ${quote(network.dockerName)}`);
  }

  if (kind === 'container.attach' || kind === 'container.alias') {
    const parts = operation.id.split(':');
    const containerName = parts[1];
    const networkName = parts[2];
    if (!containerName || !networkName) return err('Malformed attach operation');
    if (!SAFE_NAME.test(containerName) || !SAFE_NAME.test(networkName))
      return err('Unsafe container or network name');
    const service = plan.services.find((s) => s.containerName === containerName);
    const network = networks.get(networkName);
    const aliases =
      service && network
        ? (service.networks.find((n) => n.networkName === network.name)?.aliases ?? [])
        : [];
    for (const alias of aliases) if (!SAFE_NAME.test(alias)) return err(`Unsafe alias "${alias}"`);
    const aliasFlags = aliases.map((alias) => `--alias ${quote(alias)}`).join(' ');
    const connect = `sudo docker network connect ${aliasFlags} ${quote(networkName)} ${quote(containerName)}`;
    // Docker fixes a container's aliases when it joins a network and offers no
    // way to add one later, so a new alias means leaving and rejoining. The
    // disconnect is tolerant of failure because the container may not be
    // attached yet; the connect is not.
    if (kind === 'container.alias')
      return ok(
        `sudo docker network disconnect ${quote(networkName)} ${quote(containerName)} 2>/dev/null || true; ${connect}`,
      );
    return ok(connect);
  }

  if (kind === 'container.detach') {
    const parts = operation.id.split(':');
    const containerName = parts[1];
    const networkName = parts[2];
    if (!containerName || !networkName) return err('Malformed detach operation');
    if (!SAFE_NAME.test(containerName) || !SAFE_NAME.test(networkName))
      return err('Unsafe container or network name');
    return ok(`sudo docker network disconnect ${quote(networkName)} ${quote(containerName)}`);
  }

  if (kind === 'network.remove') {
    if (!SAFE_NAME.test(operation.dockerName)) return err('Unsafe network name');
    // No `--force`. Docker refuses to remove a network with containers on it,
    // and that refusal is a safety net worth keeping: if something attached
    // between preview and apply, failing is the right outcome.
    return ok(`sudo docker network rm ${quote(operation.dockerName)}`);
  }

  return err(`Unsupported operation "${operation.id}"`);
}

export class SshRuntimeApplier implements RuntimeApplier {
  async apply(
    target: DeploymentTarget,
    plan: VpsRuntimePlan,
    operations: readonly RuntimeOperation[],
    onEvent?: RuntimeApplyEventSink,
    signal?: AbortSignal,
  ): Promise<Result<RuntimeApplyReport, DeploymentError>> {
    const outcomes: RuntimeOperationOutcome[] = [];
    const commands: { operation: RuntimeOperation; command: string }[] = [];

    // Compile the complete approved change before the first mutation. Without
    // this pass, a malformed later operation could be discovered only after an
    // earlier network had already been created or a container attached. Runtime
    // apply is intentionally retryable, but a deterministic input error must
    // never be allowed to produce a partial apply.
    for (const operation of operations) {
      const command = commandFor(operation, plan);
      if (!command.ok) {
        const failedIndex = commands.length;
        return ok({
          outcomes: [
            ...commands.map(({ operation: compiled }): RuntimeOperationOutcome => ({
              operationId: compiled.id,
              status: 'skipped',
              message: 'Not attempted: the approved operation set failed validation',
            })),
            {
              operationId: operation.id,
              status: 'failed',
              message: command.error,
            },
            ...operations.slice(failedIndex + 1).map((remaining): RuntimeOperationOutcome => ({
              operationId: remaining.id,
              status: 'skipped',
              message: 'Not attempted: the approved operation set failed validation',
            })),
          ],
          applied: 0,
          failed: 1,
        });
      }
      commands.push({ operation, command: command.value });
    }

    const result = await withSshConnection(
      target,
      { label: LABEL, ...(signal ? { signal } : {}) },
      async (client) => {
        for (const { operation, command } of commands) {
          onEvent?.({ stream: 'step', message: operation.summary });
          try {
            const output = await execCommand(client, command, {
              label: LABEL,
              timeoutMs: TIMEOUT_MS,
              ...(onEvent ? { onEvent } : {}),
              ...(signal ? { signal } : {}),
            });
            outcomes.push({
              operationId: operation.id,
              status: 'applied',
              message: output.stdout.trim() || operation.summary,
            });
          } catch (cause) {
            outcomes.push({
              operationId: operation.id,
              status: 'failed',
              message: cause instanceof Error ? cause.message : String(cause),
            });
            // Stop rather than push on. Runtime operations depend on each other —
            // a container cannot join a network that failed to be created — so
            // continuing turns one legible failure into a cascade of confusing
            // ones, and leaves the VPS further from both states.
            break;
          }
        }
        return outcomes;
      },
    );
    if (!result.ok) return err(result.error);

    const applied = outcomes.filter((o) => o.status === 'applied').length;
    const failed = outcomes.filter((o) => o.status === 'failed').length;
    // Operations after a failure never ran. Recording that explicitly beats
    // leaving them absent, where a reader cannot tell "skipped" from "forgotten".
    const skipped = operations.slice(outcomes.length).map((operation): RuntimeOperationOutcome => ({
      operationId: operation.id,
      status: 'skipped',
      message: 'Not attempted: an earlier operation failed',
    }));

    return ok({ outcomes: [...outcomes, ...skipped], applied, failed });
  }
}
