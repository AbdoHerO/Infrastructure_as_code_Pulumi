import { describe, expect, it } from 'vitest';
import { ok, type DeploymentError, type PersistenceError, type Result } from '@cloudforge/shared';
import type {
  Deployer,
  DeployEventSink,
  DeploymentOptions,
  DeploymentOutcome,
  DeploymentTarget,
} from '../ports/deployer.js';
import type { DeploymentStep } from './deployment-template.js';
import type {
  DeploymentRecord,
  DeploymentRepository,
  DeploymentUpdate,
} from '../ports/deployment-repository.js';
import { DeploymentService } from './deployment-service.js';

const fingerprint = `SHA256:${'A'.repeat(43)}`;

class FakeDeployer implements Deployer {
  calls = 0;
  lastOptions: DeploymentOptions | undefined;

  inspectHostKey(): Promise<Result<string, DeploymentError>> {
    return Promise.resolve(ok(fingerprint));
  }

  deploy(
    _target: DeploymentTarget,
    _steps: readonly DeploymentStep[],
    _onEvent?: DeployEventSink,
    options?: DeploymentOptions,
  ): Promise<Result<DeploymentOutcome, DeploymentError>> {
    this.calls += 1;
    this.lastOptions = options;
    return Promise.resolve(ok({ success: true, completedSteps: 1, totalSteps: 1 }));
  }
}

class MemoryDeployments implements DeploymentRepository {
  records: DeploymentRecord[] = [];

  create(record: DeploymentRecord): Promise<Result<void, PersistenceError>> {
    this.records.push(record);
    return Promise.resolve(ok(undefined));
  }

  update(id: string, patch: DeploymentUpdate): Promise<Result<void, PersistenceError>> {
    this.records = this.records.map((record) =>
      record.id === id ? { ...record, ...patch } : record,
    );
    return Promise.resolve(ok(undefined));
  }

  listByProject(projectId: string): Promise<Result<DeploymentRecord[], PersistenceError>> {
    return Promise.resolve(ok(this.records.filter((record) => record.projectId === projectId)));
  }

  countAll(): Promise<Result<number, PersistenceError>> {
    return Promise.resolve(ok(this.records.length));
  }

  failRunning(reason: string, finishedAt: string): Promise<Result<number, PersistenceError>> {
    let count = 0;
    this.records = this.records.map((record) => {
      if (record.status !== 'running') return record;
      count += 1;
      return { ...record, status: 'failed', outputs: reason, finishedAt };
    });
    return Promise.resolve(ok(count));
  }
}

const target = (changes: Partial<DeploymentTarget> = {}): DeploymentTarget => ({
  host: 'server.example.com',
  port: 22,
  username: 'ubuntu',
  privateKey: 'key',
  hostKeySha256: fingerprint,
  ...changes,
});

describe('DeploymentService safety', () => {
  it('inspects and returns the host fingerprint', async () => {
    const service = new DeploymentService(new FakeDeployer(), new MemoryDeployments());
    const result = await service.inspectHostKey('server.example.com', 22);
    expect(result).toEqual(ok(fingerprint));
  });

  it('rejects shell metacharacters in an image before executing', async () => {
    const deployer = new FakeDeployer();
    const service = new DeploymentService(deployer, new MemoryDeployments());
    const result = await service.run({
      projectId: 'project',
      templateId: 'node',
      target: target(),
      context: { appImage: 'node:20; rm -rf /' },
    });
    expect(result.ok).toBe(false);
    expect(deployer.calls).toBe(0);
  });

  it('requires a trusted SHA-256 host fingerprint', async () => {
    const service = new DeploymentService(new FakeDeployer(), new MemoryDeployments());
    const result = await service.run({
      projectId: 'project',
      templateId: 'docker-host',
      target: target({ hostKeySha256: '' }),
      context: {},
    });
    expect(result.ok).toBe(false);
  });

  it('passes cancellation options and persists successful completion', async () => {
    const deployer = new FakeDeployer();
    const repository = new MemoryDeployments();
    const service = new DeploymentService(deployer, repository);
    const controller = new AbortController();
    const result = await service.run(
      {
        projectId: 'project',
        templateId: 'docker-host',
        target: target(),
        context: {},
      },
      undefined,
      { signal: controller.signal, stepTimeoutMs: 1000 },
    );
    expect(result.ok && result.value.status).toBe('success');
    expect(deployer.lastOptions?.stepTimeoutMs).toBe(1000);
    expect(repository.records[0]?.status).toBe('success');
  });

  it('marks interrupted running deployments as failed', async () => {
    const repository = new MemoryDeployments();
    const now = new Date().toISOString();
    repository.records.push({
      id: 'deployment',
      projectId: 'project',
      status: 'running',
      strategy: 'docker-host',
      outputs: '{}',
      startedAt: now,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const service = new DeploymentService(new FakeDeployer(), repository);
    const result = await service.recoverInterrupted();
    expect(result).toEqual(ok(1));
    expect(repository.records[0]?.status).toBe('failed');
  });
});
