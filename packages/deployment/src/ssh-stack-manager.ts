/**
 * Runs Docker Compose stacks over verified SSH.
 *
 * Thin by design: every line of shell lives in `stack-script`. The one thing
 * done here is keeping the Compose file and `.env` out of scripts: they are
 * written over SFTP as owner-only files in /tmp on the same connection, and the
 * script moves them into place as root.
 */
import { randomUUID } from 'node:crypto';
import type {
  DeploymentTarget,
  StackDeployment,
  StackEventSink,
  StackManager,
  StackRuntimeStatus,
} from '@cloudforge/core';
import { DeploymentError, err, ok, type Result } from '@cloudforge/shared';
import { lineEvents } from './line-events.js';
import {
  deployStackScript,
  parseStackStatus,
  parseUsedPorts,
  removeStackScript,
  stackStatusScript,
  usedPortsScript,
} from './stack-script.js';
import {
  execCommand,
  privilegedScript,
  runPrivilegedScript,
  uploadFile,
  withSshConnection,
} from './ssh-transport.js';

const LABEL = 'Docker stack';
const PREFIX = 'cloudforge-stack';
/** Image pulls on a small VPS dominate; a first deploy can take several minutes. */
const DEPLOY_TIMEOUT_MS = 20 * 60_000;
const SHORT_TIMEOUT_MS = 90_000;
/** Failures come with all of Compose's progress lines; the end holds the reason. */
const ERROR_LINES = 6;

/** Keep the lines that say what went wrong, not the progress before them. */
function shortened(error: DeploymentError): DeploymentError {
  const lines = error.message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length <= ERROR_LINES) return error;
  return new DeploymentError(lines.slice(-ERROR_LINES).join(' '), { cause: error });
}

export class SshStackManager implements StackManager {
  async deploy(
    target: DeploymentTarget,
    deployment: StackDeployment,
    onEvent?: StackEventSink,
  ): Promise<Result<StackRuntimeStatus, DeploymentError>> {
    const upload = randomUUID();
    const composeFile = `/tmp/${PREFIX}-${upload}.yaml`;
    const environmentFile = `/tmp/${PREFIX}-${upload}.env`;
    const script = deployStackScript({
      project: deployment.project,
      overrideYaml: deployment.overrideYaml,
      externalNetworks: deployment.externalNetworks,
      externalVolumes: deployment.externalVolumes,
      containerNames: deployment.containerNames,
      hostPorts: deployment.hostPorts,
      composeFile,
      environmentFile,
    });
    const lines = lineEvents(onEvent);
    const result = await withSshConnection(target, { label: LABEL }, async (client) => {
      try {
        await uploadFile(client, composeFile, ensureNewline(deployment.composeYaml));
        await uploadFile(client, environmentFile, ensureNewline(deployment.environment));
        return await execCommand(client, privilegedScript(script, PREFIX), {
          label: LABEL,
          timeoutMs: DEPLOY_TIMEOUT_MS,
          onEvent: lines.push,
        });
      } finally {
        // The script's trap deletes them; this covers a failure before it ran.
        await execCommand(client, `rm -f ${composeFile} ${environmentFile}`, {
          label: LABEL,
          timeoutMs: 15_000,
        }).catch(() => undefined);
      }
    });
    lines.flush();
    if (!result.ok) return err(shortened(result.error));
    return ok({ project: deployment.project, ...parseStackStatus(result.value.stdout) });
  }

  async status(
    target: DeploymentTarget,
    project: string,
    hostPorts: readonly number[],
  ): Promise<Result<StackRuntimeStatus, DeploymentError>> {
    const result = await runPrivilegedScript(target, stackStatusScript(project, hostPorts), {
      label: LABEL,
      timeoutMs: SHORT_TIMEOUT_MS,
      scriptPrefix: PREFIX,
    });
    if (!result.ok) return err(shortened(result.error));
    return ok({ project, ...parseStackStatus(result.value.stdout) });
  }

  async remove(
    target: DeploymentTarget,
    project: string,
    deleteData: boolean,
    onEvent?: StackEventSink,
  ): Promise<Result<void, DeploymentError>> {
    const lines = lineEvents(onEvent);
    const result = await runPrivilegedScript(target, removeStackScript(project, deleteData), {
      label: LABEL,
      timeoutMs: SHORT_TIMEOUT_MS * 2,
      onEvent: lines.push,
      scriptPrefix: PREFIX,
    });
    lines.flush();
    return result.ok ? ok(undefined) : err(shortened(result.error));
  }

  async usedPorts(target: DeploymentTarget): Promise<Result<readonly number[], DeploymentError>> {
    const result = await runPrivilegedScript(target, usedPortsScript(), {
      label: LABEL,
      timeoutMs: SHORT_TIMEOUT_MS,
      scriptPrefix: PREFIX,
    });
    return result.ok ? ok(parseUsedPorts(result.value.stdout)) : result;
  }
}

function ensureNewline(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
}
