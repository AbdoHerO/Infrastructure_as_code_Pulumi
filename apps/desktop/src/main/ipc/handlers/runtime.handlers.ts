import { NO_APPLY_OPTIONS } from '@cloudforge/core';
import { getContainer } from '../../container.js';
import { emitEvent } from '../emit.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

/**
 * The VPS runtime plan: a target's desired topology.
 *
 * Every channel here is either a database operation or a read. Authoring a plan
 * never touches a server — applying one is a separate, previewed, explicitly
 * confirmed operation — so these handlers are safe to call against a target
 * running production traffic.
 *
 * Like every other SSH-backed feature, payloads carry a target id and nothing
 * else. The pinned host key is loaded in the main process from the database.
 */
export function registerRuntimeHandlers(): void {
  const service = (): ReturnType<typeof getContainer>['runtimePlanService'] =>
    getContainer().runtimePlanService;

  registerHandler('runtime:getPlan', async ({ targetId }) =>
    orThrow(await service().get(targetId)),
  );
  registerHandler('runtime:savePlan', async ({ targetId, plan }) =>
    orThrow(await service().save(targetId, plan)),
  );
  // Pure and synchronous, so the editor can show problems as they are typed
  // rather than only on save.
  registerHandler('runtime:validatePlan', ({ plan }) => Promise.resolve(service().validate(plan)));
  registerHandler('runtime:setMode', async ({ targetId, mode }) =>
    orThrow(await service().setMode(targetId, mode)),
  );
  registerHandler('runtime:drift', async ({ targetId }) =>
    orThrow(await service().drift(targetId)),
  );

  registerHandler('runtime:adopt', async ({ targetId, resourceKind, dockerName }) =>
    orThrow(await service().adopt(targetId, resourceKind, dockerName)),
  );
  registerHandler('runtime:release', async ({ targetId, resourceKind, dockerName }) =>
    orThrow(await service().release(targetId, resourceKind, dockerName)),
  );

  registerHandler('runtime:connectivity', async ({ targetId }) =>
    orThrow(await service().connectivity(targetId)),
  );
  // Additive and idempotent, so it needs no preview token: it cannot take away
  // access that already works, and the ports it opens are exactly the ones the
  // saved plan already says it needs.
  registerHandler('runtime:openFirewall', async ({ targetId }) =>
    orThrow(await service().openRequiredPorts(targetId)),
  );

  registerHandler('runtime:preview', async ({ targetId, options }) =>
    orThrow(await service().preview(targetId, options ?? NO_APPLY_OPTIONS)),
  );

  // The one channel here that changes a VPS. The token it requires was minted by
  // a preview of this exact change; the service re-derives the change from the
  // live server and refuses if it no longer matches.
  registerHandler(
    'runtime:apply',
    async ({ targetId, streamId, previewToken, confirmations, options }) =>
      orThrow(
        await service().apply(
          targetId,
          previewToken,
          confirmations ?? [],
          options ?? NO_APPLY_OPTIONS,
          (event) => emitEvent('runtime:log', { streamId, event }),
        ),
      ),
  );
}
