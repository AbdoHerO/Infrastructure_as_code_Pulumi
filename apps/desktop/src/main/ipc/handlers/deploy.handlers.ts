import type { DeploymentContext, DeploymentTarget } from '@cloudforge/core';
import { getContainer } from '../../container.js';
import { emitEvent } from '../emit.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

/** Register the Deployments module IPC handlers. */
export function registerDeployHandlers(): void {
  registerHandler('deploy:templates', () => getContainer().deploymentService.listTemplates());

  registerHandler('deploy:list', async ({ projectId }) =>
    orThrow(await getContainer().deploymentService.list(projectId)),
  );

  registerHandler('deploy:count', async () =>
    orThrow(await getContainer().deploymentService.count()),
  );

  registerHandler('deploy:run', async (req) => {
    // Resolve the SSH private key from the encrypted credential (never over IPC).
    const revealed = orThrow(await getContainer().credentialService.reveal(req.sshCredentialId));
    const target: DeploymentTarget = {
      host: req.host,
      port: req.port,
      username: req.username,
      privateKey: revealed.data.privateKey ?? '',
      passphrase: revealed.data.passphrase,
    };
    const context: DeploymentContext = {
      ...(req.appImage ? { appImage: req.appImage } : {}),
      ...(req.domain ? { domain: req.domain } : {}),
    };

    return orThrow(
      await getContainer().deploymentService.run(
        { projectId: req.projectId, templateId: req.templateId, target, context },
        (event) => emitEvent('deploy:log', { streamId: req.streamId, event }),
      ),
    );
  });
}
