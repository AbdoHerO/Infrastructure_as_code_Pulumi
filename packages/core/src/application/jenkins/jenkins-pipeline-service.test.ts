import { describe, expect, it, vi } from 'vitest';
import { ok } from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type { CredentialService } from '../credentials/credential-service.js';
import type { NginxService } from '../nginx/nginx-service.js';
import type { JenkinsManager } from '../ports/jenkins-manager.js';
import type {
  JenkinsPipelineRecord,
  JenkinsPipelineRepository,
} from '../ports/jenkins-pipeline-repository.js';
import type { VpsTargetService } from '../vps-targets/vps-target-service.js';
import {
  JenkinsPipelineService,
  type SaveJenkinsPipelineInput,
} from './jenkins-pipeline-service.js';

class MemoryPipelines implements JenkinsPipelineRepository {
  readonly records = new Map<string, JenkinsPipelineRecord>();
  list() {
    return Promise.resolve(ok([...this.records.values()]));
  }
  get(id: string) {
    return Promise.resolve(ok(this.records.get(id) ?? null));
  }
  getByFolderAndName(folder: string, name: string) {
    return Promise.resolve(
      ok(
        [...this.records.values()].find(
          (record) => record.folder === folder && record.name === name,
        ) ?? null,
      ),
    );
  }
  save(record: JenkinsPipelineRecord) {
    this.records.set(record.id, record);
    return Promise.resolve(ok(undefined));
  }
  remove(id: string) {
    this.records.delete(id);
    return Promise.resolve(ok(undefined));
  }
}

const input: SaveJenkinsPipelineInput = {
  name: 'shop-production',
  description: 'Deploy shop',
  targetId: 'target-1',
  jenkinsCredentialId: 'jenkins-1',
  githubCredentialId: 'github-1',
  repositoryUrl: 'https://github.com/example/shop.git',
  branch: 'main',
  jenkinsfilePath: 'Jenkinsfile',
  pipelineScript: '',
  definitionMode: 'scm',
  parameters: [
    { name: 'IMAGE_TAG', type: 'string', defaultValue: 'latest', description: '', choices: [] },
  ],
  environment: { APP_ENV: 'production' },
  domain: '',
  applicationPort: null,
  cloudflareCredentialId: null,
  cloudflareZoneId: null,
  configureDomain: false,
};

describe('JenkinsPipelineService', () => {
  it('blocks a localhost Jenkins URL for a remote VPS target', async () => {
    const service = new JenkinsPipelineService(
      {} as JenkinsPipelineRepository,
      {
        get: vi
          .fn()
          .mockResolvedValue(ok({ id: 'target-1', name: 'Production VPS', host: '203.0.113.10' })),
      } as unknown as VpsTargetService,
      {
        getDecrypted: vi.fn().mockResolvedValue(
          ok({
            kind: 'jenkins',
            data: { username: 'admin', apiToken: 'secret', baseUrl: 'http://localhost:8080' },
          }),
        ),
      } as unknown as CredentialService,
      {} as JenkinsManager,
      {} as ActivityService,
    );

    const result = await service.test('target-1', 'jenkins-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('not the selected VPS');
  });

  it('requires an encrypted GitHub credential for an explicitly private repository', async () => {
    const service = new JenkinsPipelineService(
      {} as JenkinsPipelineRepository,
      {} as VpsTargetService,
      {} as CredentialService,
      {} as JenkinsManager,
      {} as ActivityService,
    );

    const result = await service.save({
      ...input,
      repositoryAccess: 'private',
      githubCredentialId: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('GitHub credential');
  });

  it('creates an isolated folder and keeps GitHub token out of persistence', async () => {
    const repository = new MemoryPipelines();
    const ensureFolder = vi.fn().mockResolvedValue(ok(undefined));
    const ensureGithubCredential = vi.fn().mockResolvedValue(ok(undefined));
    const manager = {
      ensureFolder,
      ensureGithubCredential,
      upsertJob: vi.fn().mockResolvedValue(ok(undefined)),
    } as unknown as JenkinsManager;
    const credentials = {
      getDecrypted: vi.fn((id: string) =>
        Promise.resolve(
          id === 'jenkins-1'
            ? ok({
                kind: 'jenkins',
                data: {
                  username: 'admin',
                  apiToken: 'jenkins-secret',
                  baseUrl: 'http://jenkins:8080',
                },
              })
            : ok({ kind: 'github', data: { personalAccessToken: 'github-secret' } }),
        ),
      ),
    } as unknown as CredentialService;
    const service = new JenkinsPipelineService(
      repository,
      {
        get: vi
          .fn()
          .mockResolvedValue(ok({ id: 'target-1', name: 'Production VPS', host: '203.0.113.10' })),
      } as unknown as VpsTargetService,
      credentials,
      manager,
      { recordSafe: vi.fn() } as unknown as ActivityService,
    );

    const result = await service.save(input);

    expect(result.ok).toBe(true);
    expect(ensureFolder).toHaveBeenCalledWith(
      expect.anything(),
      'cloudforge-production-vps-target-1',
    );
    expect(ensureGithubCredential).toHaveBeenCalledWith(
      expect.anything(),
      'cloudforge-production-vps-target-1',
      expect.stringMatching(/^cloudforge-github-/),
      'github-secret',
    );
    expect(JSON.stringify([...repository.records.values()])).not.toContain('github-secret');
    expect(JSON.stringify([...repository.records.values()])).not.toContain('jenkins-secret');
  });

  it('deletes the remote job and empty folder before removing local state', async () => {
    const repository = new MemoryPipelines();
    const record: JenkinsPipelineRecord = {
      id: 'pipeline-1',
      folder: 'cloudforge-production-vps-target-1',
      ...input,
      githubCredentialId: null,
      applicationPort: null,
      cloudflareCredentialId: null,
      cloudflareZoneId: null,
      lastStatus: 'configured',
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    };
    repository.records.set(record.id, record);
    const removeJob = vi.fn().mockResolvedValue(ok(undefined));
    const pruneEmptyFolder = vi.fn().mockResolvedValue(ok(true));
    const service = new JenkinsPipelineService(
      repository,
      {
        get: vi
          .fn()
          .mockResolvedValue(ok({ id: 'target-1', name: 'Production VPS', host: '203.0.113.10' })),
      } as unknown as VpsTargetService,
      {
        getDecrypted: vi.fn().mockResolvedValue(
          ok({
            kind: 'jenkins',
            data: {
              username: 'admin',
              apiToken: 'jenkins-secret',
              baseUrl: 'http://jenkins:8080',
            },
          }),
        ),
      } as unknown as CredentialService,
      { removeJob, pruneEmptyFolder } as unknown as JenkinsManager,
      { recordSafe: vi.fn() } as unknown as ActivityService,
    );

    const result = await service.remove(record.id);

    expect(result.ok).toBe(true);
    expect(removeJob).toHaveBeenCalledWith(expect.anything(), record.folder, record.name);
    expect(pruneEmptyFolder).toHaveBeenCalledWith(expect.anything(), record.folder);
    expect(repository.records.has(record.id)).toBe(false);
  });

  it('updates the same remote job and preserves its existing SSL configuration', async () => {
    const repository = new MemoryPipelines();
    repository.records.set('pipeline-existing', {
      id: 'pipeline-existing',
      folder: 'cloudforge-production-vps-target-1',
      ...input,
      githubCredentialId: null,
      domain: 'hanoutplus.ma',
      applicationPort: 3000,
      cloudflareCredentialId: 'cloudflare-1',
      cloudflareZoneId: null,
      configureDomain: true,
      lastStatus: 'configured',
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    });
    const saveSite = vi.fn().mockResolvedValue(ok({ summary: 'saved' }));
    const service = new JenkinsPipelineService(
      repository,
      {
        get: vi
          .fn()
          .mockResolvedValue(ok({ id: 'target-1', name: 'Production VPS', host: '203.0.113.10' })),
      } as unknown as VpsTargetService,
      {
        getDecrypted: vi.fn().mockResolvedValue(
          ok({
            kind: 'jenkins',
            data: {
              username: 'admin',
              apiToken: 'jenkins-secret',
              baseUrl: 'http://jenkins:8080',
            },
          }),
        ),
      } as unknown as CredentialService,
      {
        ensureFolder: vi.fn().mockResolvedValue(ok(undefined)),
        upsertJob: vi.fn().mockResolvedValue(ok(undefined)),
      } as unknown as JenkinsManager,
      { recordSafe: vi.fn() } as unknown as ActivityService,
      {
        ensure: vi.fn().mockResolvedValue(ok({ status: 'propagated' })),
      },
      {
        listSites: vi.fn().mockResolvedValue(
          ok([
            {
              domain: 'hanoutplus.ma',
              enabled: true,
              upstreamKind: 'host',
              upstreamHost: '127.0.0.1',
              upstreamPort: 3000,
              websocket: true,
              ssl: true,
              certificatePath: '/opt/cloudforge/certs/live/hanoutplus.ma',
              httpRedirect: true,
              headers: [],
              extraDirectives: [],
              locations: [],
              proxyTimeoutSeconds: 60,
              clientMaxBodySize: '50m',
              compression: true,
              cache: false,
              customSnippets: [],
              lastModified: null,
            },
          ]),
        ),
        saveSite,
      } as unknown as NginxService,
    );

    const result = await service.save({
      ...input,
      githubCredentialId: null,
      domain: 'hanoutplus.ma',
      applicationPort: 8000,
      cloudflareCredentialId: 'cloudflare-1',
      configureDomain: true,
    });

    expect(result.ok && result.value.id).toBe('pipeline-existing');
    expect(repository.records.size).toBe(1);
    expect(saveSite).toHaveBeenCalledWith(
      'target-1',
      expect.objectContaining({
        upstreamPort: 8000,
        ssl: true,
        httpRedirect: true,
        certificatePath: '/opt/cloudforge/certs/live/hanoutplus.ma',
      }),
    );
  });

  it('synchronizes the application port with the Jenkins HOST_PORT parameter', async () => {
    const repository = new MemoryPipelines();
    const upsertJob = vi.fn().mockResolvedValue(ok(undefined));
    const manager = {
      ensureFolder: vi.fn().mockResolvedValue(ok(undefined)),
      upsertJob,
    } as unknown as JenkinsManager;
    const service = new JenkinsPipelineService(
      repository,
      {
        get: vi
          .fn()
          .mockResolvedValue(ok({ id: 'target-1', name: 'Production VPS', host: '203.0.113.10' })),
      } as unknown as VpsTargetService,
      {
        getDecrypted: vi.fn().mockResolvedValue(
          ok({
            kind: 'jenkins',
            data: {
              username: 'admin',
              apiToken: 'jenkins-secret',
              baseUrl: 'http://jenkins:8080',
            },
          }),
        ),
      } as unknown as CredentialService,
      manager,
      { recordSafe: vi.fn() } as unknown as ActivityService,
      { ensure: vi.fn().mockResolvedValue(ok({ status: 'propagated' })) },
      {
        listSites: vi.fn().mockResolvedValue(ok([])),
        saveSite: vi.fn().mockResolvedValue(ok({ summary: 'saved' })),
      } as unknown as NginxService,
    );

    const result = await service.save({
      ...input,
      githubCredentialId: null,
      parameters: [],
      configureDomain: true,
      domain: 'hanoutplus.ma',
      applicationPort: 8000,
    });

    expect(result.ok).toBe(true);
    expect(upsertJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        parameters: [
          expect.objectContaining({ name: 'HOST_PORT', type: 'string', defaultValue: '8000' }),
        ],
      }),
    );
    if (result.ok)
      expect(result.value.parameters).toEqual([
        expect.objectContaining({ name: 'HOST_PORT', defaultValue: '8000' }),
      ]);
  });

  it('uses declared parameter defaults when triggering a Jenkins build', async () => {
    const repository = new MemoryPipelines();
    const record: JenkinsPipelineRecord = {
      id: 'pipeline-1',
      folder: 'cloudforge-production-vps-target-1',
      ...input,
      githubCredentialId: null,
      applicationPort: null,
      cloudflareCredentialId: null,
      cloudflareZoneId: null,
      parameters: [
        { name: 'HOST_PORT', type: 'string', defaultValue: '8000', description: '', choices: [] },
      ],
      lastStatus: 'configured',
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    };
    repository.records.set(record.id, record);
    const trigger = vi.fn().mockResolvedValue(ok(undefined));
    const service = new JenkinsPipelineService(
      repository,
      {
        get: vi
          .fn()
          .mockResolvedValue(ok({ id: 'target-1', name: 'Production VPS', host: '203.0.113.10' })),
      } as unknown as VpsTargetService,
      {
        getDecrypted: vi.fn().mockResolvedValue(
          ok({
            kind: 'jenkins',
            data: {
              username: 'admin',
              apiToken: 'jenkins-secret',
              baseUrl: 'http://jenkins:8080',
            },
          }),
        ),
      } as unknown as CredentialService,
      { trigger } as unknown as JenkinsManager,
      { recordSafe: vi.fn() } as unknown as ActivityService,
    );

    const result = await service.trigger(record.id, {});

    expect(result.ok).toBe(true);
    expect(trigger).toHaveBeenCalledWith(expect.anything(), record.folder, record.name, {
      HOST_PORT: '8000',
    });
  });
});
