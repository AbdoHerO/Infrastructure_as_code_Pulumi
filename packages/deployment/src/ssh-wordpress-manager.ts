/**
 * Runs WordPress sites over verified SSH.
 *
 * Thin by design: every line of shell lives in `wordpress-script`. The one
 * thing done here is keeping passwords out of scripts: they are written over
 * SFTP as owner-only files in /tmp on the same connection, and the script
 * moves or reads them as root, then deletes them.
 */
import { randomUUID } from 'node:crypto';
import type {
  DeploymentTarget,
  WordPressDeployment,
  WordPressEventSink,
  WordPressManager,
  WordPressRuntimeStatus,
} from '@cloudforge/core';
import { ok, type DeploymentError, type Result } from '@cloudforge/shared';
import {
  deployWordPressScript,
  parseWordPressStatus,
  removeWordPressScript,
  updateWordPressScript,
  wordpressStatusScript,
} from './wordpress-script.js';
import {
  execCommand,
  privilegedScript,
  runPrivilegedScript,
  uploadFile,
  withSshConnection,
} from './ssh-transport.js';
import { lineEvents } from './line-events.js';

const LABEL = 'WordPress';
/** Image pulls on a small VPS dominate; the first deploy can take several minutes. */
const DEPLOY_TIMEOUT_MS = 20 * 60_000;
const STATUS_TIMEOUT_MS = 90_000;

export class SshWordPressManager implements WordPressManager {
  async deploy(
    target: DeploymentTarget,
    deployment: WordPressDeployment,
    onEvent?: WordPressEventSink,
  ): Promise<Result<WordPressRuntimeStatus, DeploymentError>> {
    const upload = randomUUID();
    const environmentFile = `/tmp/cloudforge-wp-${upload}.env`;
    const adminPasswordFile = `/tmp/cloudforge-wp-${upload}.pw`;
    const script = deployWordPressScript({
      project: deployment.project,
      composeYaml: deployment.composeYaml,
      phpIni: deployment.phpIni,
      hostPort: deployment.hostPort,
      siteUrl: deployment.siteUrl,
      siteTitle: deployment.siteTitle,
      adminUser: deployment.adminUser,
      adminEmail: deployment.adminEmail,
      environmentFile,
      adminPasswordFile,
    });
    const lines = lineEvents(onEvent);
    const result = await withSshConnection(target, { label: LABEL }, async (client) => {
      try {
        await uploadFile(
          client,
          environmentFile,
          `DB_PASSWORD=${deployment.secrets.databasePassword}\nDB_ROOT_PASSWORD=${deployment.secrets.databaseRootPassword}\n`,
        );
        await uploadFile(client, adminPasswordFile, `${deployment.secrets.adminPassword}\n`);
        return await execCommand(client, privilegedScript(script, 'cloudforge-wp'), {
          label: LABEL,
          timeoutMs: DEPLOY_TIMEOUT_MS,
          onEvent: lines.push,
        });
      } finally {
        // The script's trap deletes them; this covers a failure before it ran.
        await execCommand(client, `rm -f ${environmentFile} ${adminPasswordFile}`, {
          label: LABEL,
          timeoutMs: 15_000,
        }).catch(() => undefined);
      }
    });
    lines.flush();
    if (!result.ok) return result;
    return ok({ project: deployment.project, ...parseWordPressStatus(result.value.stdout) });
  }

  async update(
    target: DeploymentTarget,
    project: string,
    onEvent?: WordPressEventSink,
  ): Promise<Result<WordPressRuntimeStatus, DeploymentError>> {
    const lines = lineEvents(onEvent);
    const result = await runPrivilegedScript(target, updateWordPressScript(project), {
      label: LABEL,
      timeoutMs: DEPLOY_TIMEOUT_MS,
      onEvent: lines.push,
      scriptPrefix: 'cloudforge-wp',
    });
    lines.flush();
    if (!result.ok) return result;
    return ok({ project, ...parseWordPressStatus(result.value.stdout) });
  }

  async status(
    target: DeploymentTarget,
    project: string,
  ): Promise<Result<WordPressRuntimeStatus, DeploymentError>> {
    const result = await runPrivilegedScript(target, wordpressStatusScript(project), {
      label: LABEL,
      timeoutMs: STATUS_TIMEOUT_MS,
      scriptPrefix: 'cloudforge-wp',
    });
    if (!result.ok) return result;
    return ok({ project, ...parseWordPressStatus(result.value.stdout) });
  }

  async remove(
    target: DeploymentTarget,
    project: string,
    deleteData: boolean,
    onEvent?: WordPressEventSink,
  ): Promise<Result<void, DeploymentError>> {
    const lines = lineEvents(onEvent);
    const result = await runPrivilegedScript(target, removeWordPressScript(project, deleteData), {
      label: LABEL,
      timeoutMs: STATUS_TIMEOUT_MS * 2,
      onEvent: lines.push,
      scriptPrefix: 'cloudforge-wp',
    });
    lines.flush();
    return result.ok ? ok(undefined) : result;
  }
}
