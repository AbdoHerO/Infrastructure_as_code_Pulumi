import { getContainer } from '../../container.js';
import { emitEvent } from '../emit.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';
import { resolveSshTarget } from './ssh-target.js';
import { projectOperations } from '../../project-operation-registry.js';

export function registerAnsibleHandlers(): void {
  registerHandler('ansible:profiles', () => [...getContainer().ansibleManager.profiles()]);
  registerHandler('ansible:targets', async () =>
    orThrow(await getContainer().vpsTargetService.list()),
  );
  registerHandler('ansible:createTarget', async (request) => {
    await validateSshCredential(request.sshCredentialId);
    const target = orThrow(await getContainer().vpsTargetService.create(request));
    emitEvent('vpsTargets:changed', { reason: 'created' });
    return target;
  });
  registerHandler('ansible:updateTarget', async ({ id, ...request }) => {
    await validateSshCredential(request.sshCredentialId);
    const target = orThrow(await getContainer().vpsTargetService.update(id, request));
    emitEvent('vpsTargets:changed', { reason: 'updated' });
    return target;
  });
  registerHandler('ansible:deleteTarget', async ({ id }) => {
    orThrow(await getContainer().vpsTargetService.remove(id));
    emitEvent('vpsTargets:changed', { reason: 'deleted' });
  });
  registerHandler('ansible:inspectHostKey', async ({ host, port }) => ({
    fingerprint: orThrow(await getContainer().ansibleManager.inspectHostKey(host, port)),
  }));
  registerHandler('ansible:status', async (request) =>
    orThrow(await getContainer().ansibleManager.status(await resolveSshTarget(request))),
  );
  registerHandler('ansible:profileStates', async (request) =>
    orThrow(await getContainer().ansibleManager.profileStates(await resolveSshTarget(request))),
  );
  registerHandler('ansible:preflight', async (request) => {
    const report = orThrow(
      await getContainer().ansibleManager.preflight(
        await resolveSshTarget(request),
        request.profileId,
        request.variables,
      ),
    );
    if (request.targetId)
      orThrow(await getContainer().vpsTargetService.recordPreflight(request.targetId, report));
    return report;
  });
  registerHandler('ansible:repair', (request) =>
    operation(request.streamId, async (signal) => {
      const report = orThrow(
        await getContainer().ansibleManager.repair(
          await resolveSshTarget(request),
          (event) => emitEvent('ansible:log', { streamId: request.streamId, event }),
          { signal },
        ),
      );
      if (request.targetId)
        orThrow(await getContainer().vpsTargetService.recordPreflight(request.targetId, report));
      getContainer().activityService.recordSafe({
        type: 'ansible.target.prepared',
        message: `Prepared Ansible prerequisites on ${request.host}`,
      });
      return report;
    }),
  );
  registerHandler('ansible:bootstrap', (request) =>
    operation(request.streamId, async (signal) =>
      orThrow(
        await getContainer().ansibleManager.bootstrap(
          await resolveSshTarget(request),
          (event) => emitEvent('ansible:log', { streamId: request.streamId, event }),
          { signal },
        ),
      ),
    ),
  );
  registerHandler('ansible:run', (request) =>
    operation(request.streamId, async (signal) => {
      const outcome = orThrow(
        await getContainer().ansibleManager.run(
          await resolveSshTarget(request),
          request.profileId,
          request.variables,
          (event) => emitEvent('ansible:log', { streamId: request.streamId, event }),
          { signal },
        ),
      );
      getContainer().activityService.recordSafe({
        type: 'ansible.profile.completed',
        message: `Ansible profile "${request.profileId}" completed on ${request.host}`,
      });
      return outcome;
    }),
  );
  registerHandler('ansible:jenkinsAction', (request) =>
    operation(request.streamId, async (signal) => {
      const outcome = orThrow(
        await getContainer().ansibleManager.manageJenkins(
          await resolveSshTarget(request),
          request.action,
          (event) => emitEvent('ansible:log', { streamId: request.streamId, event }),
          { signal },
        ),
      );
      getContainer().activityService.recordSafe({
        type: `ansible.jenkins.${request.action === 'restart' ? 'restarted' : 'verified'}`,
        message: `Jenkins ${request.action === 'restart' ? 'restarted' : 'verified'} on ${request.host}`,
      });
      return outcome;
    }),
  );
  registerHandler('ansible:access', async (request) =>
    orThrow(
      await getContainer().ansibleManager.access(
        await resolveSshTarget(request),
        request.profileId,
        request.variables,
      ),
    ),
  );
  registerHandler('ansible:cancel', ({ streamId }) =>
    projectOperations.cancel(`ansible:${streamId}`),
  );
  registerHandler('ansible:networks', async (request) =>
    orThrow(await getContainer().ansibleManager.listNetworks(await resolveSshTarget(request))),
  );
  registerHandler('ansible:createNetwork', async (request) =>
    orThrow(
      await getContainer().ansibleManager.createNetwork(
        await resolveSshTarget(request),
        request.name,
      ),
    ),
  );
  registerHandler('ansible:nginxSites', async (request) =>
    orThrow(await getContainer().ansibleManager.listNginxSites(await resolveSshTarget(request))),
  );
  registerHandler('ansible:nginxUpsert', (request) =>
    operation(request.streamId, async (signal) => {
      const outcome = orThrow(
        await getContainer().ansibleManager.upsertNginxSite(
          await resolveSshTarget(request),
          request.site,
          (event) => emitEvent('ansible:log', { streamId: request.streamId, event }),
          { signal },
        ),
      );
      getContainer().activityService.recordSafe({
        type: 'ansible.nginx.applied',
        message: `Nginx route "${request.site.domain}" applied on ${request.host}`,
      });
      return outcome;
    }),
  );
  registerHandler('ansible:nginxRemove', (request) =>
    operation(request.streamId, async (signal) => {
      const outcome = orThrow(
        await getContainer().ansibleManager.removeNginxSite(
          await resolveSshTarget(request),
          request.domain,
          (event) => emitEvent('ansible:log', { streamId: request.streamId, event }),
          { signal },
        ),
      );
      getContainer().activityService.recordSafe({
        type: 'ansible.nginx.removed',
        message: `Nginx route "${request.domain}" removed from ${request.host}`,
      });
      return outcome;
    }),
  );
}

async function validateSshCredential(id: string): Promise<void> {
  orThrow(await getContainer().sshKeyService.resolveAuthentication(id));
}

async function operation<T>(
  streamId: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const projectId = getContainer().projectContext.requireActive().projectId;
  const lease = projectOperations.begin(`ansible:${streamId}`, projectId, true);
  try {
    return await run(lease.signal!);
  } finally {
    lease.complete();
  }
}
