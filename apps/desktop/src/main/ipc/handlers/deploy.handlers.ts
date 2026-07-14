import type { DeploymentContext, DeploymentTarget } from '@cloudforge/core';
import { getContainer } from '../../container.js';
import { emitEvent } from '../emit.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

const activeDeployments = new Map<string, AbortController>();

/** Register the Deployments module IPC handlers. */
export function registerDeployHandlers(): void {
  registerHandler('deploy:templates', () => getContainer().deploymentService.listTemplates());

  registerHandler('deploy:list', async ({ projectId }) =>
    orThrow(await getContainer().deploymentService.list(projectId)),
  );

  registerHandler('deploy:count', async () =>
    orThrow(await getContainer().deploymentService.count()),
  );

  registerHandler('deploy:inspectHostKey', async ({ host, port }) => ({
    fingerprint: orThrow(await getContainer().deploymentService.inspectHostKey(host, port)),
  }));

  registerHandler('deploy:cancel', ({ streamId }) => {
    activeDeployments.get(streamId)?.abort();
  });

  registerHandler('deploy:run', async (req) => {
    if (activeDeployments.has(req.streamId)) throw new Error('Deployment stream is already active');
    const controller = new AbortController();
    activeDeployments.set(req.streamId, controller);
    // Resolve the SSH private key from the encrypted credential (never over IPC).
    const revealed = orThrow(await getContainer().credentialService.reveal(req.sshCredentialId));
    const target: DeploymentTarget = {
      host: req.host,
      port: req.port,
      username: req.username,
      privateKey: revealed.data.privateKey ?? '',
      passphrase: revealed.data.passphrase,
      hostKeySha256: req.hostKeySha256,
    };
    const context: DeploymentContext = {
      ...(req.appImage ? { appImage: req.appImage } : {}),
      ...(req.domain ? { domain: req.domain } : {}),
    };

    try {
      const dto = orThrow(
        await getContainer().deploymentService.run(
          { projectId: req.projectId, templateId: req.templateId, target, context },
          (event) => emitEvent('deploy:log', { streamId: req.streamId, event }),
          { signal: controller.signal },
        ),
      );
      getContainer().activityService.recordSafe({
        type: `deployment.${dto.status}`,
        message: `Deployment "${req.templateId}" ${dto.status} on ${req.host}`,
        projectId: req.projectId,
      });
      return dto;
    } finally {
      activeDeployments.delete(req.streamId);
    }
  });
}
