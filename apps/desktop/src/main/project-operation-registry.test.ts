import { describe, expect, it, vi } from 'vitest';
import { ProjectOperationRegistry } from './project-operation-registry.js';

describe('ProjectOperationRegistry', () => {
  it('aborts and drains abortable work before a project deactivates', async () => {
    const registry = new ProjectOperationRegistry();
    const lease = registry.begin('deploy:one', 'project-one', true);
    const aborted = vi.fn();
    lease.signal?.addEventListener('abort', aborted);

    const deactivating = registry.deactivate('project-one');
    expect(aborted).toHaveBeenCalledOnce();
    let completed = false;
    void deactivating.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    lease.complete();
    await deactivating;
    expect(completed).toBe(true);
  });

  it('does not cancel work owned by another project', async () => {
    const registry = new ProjectOperationRegistry();
    const lease = registry.begin('deploy:two', 'project-two', true);

    await registry.deactivate('project-one');

    expect(lease.signal?.aborted).toBe(false);
    lease.complete();
  });

  it('refuses to switch during a non-abortable provider operation', async () => {
    const registry = new ProjectOperationRegistry();
    const lease = registry.begin('infra:apply:one', 'project-one', false);

    await expect(registry.deactivate('project-one')).rejects.toThrow(
      'Wait for the active operation',
    );

    lease.complete();
    await expect(registry.deactivate('project-one')).resolves.toBeUndefined();
  });
});
