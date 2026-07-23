import { describe, expect, it, vi } from 'vitest';
import { ok } from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type { CredentialService } from '../credentials/credential-service.js';
import type { NginxService } from '../nginx/nginx-service.js';
import type { JenkinsJobDefinition, JenkinsManager } from '../ports/jenkins-manager.js';
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
  environmentCredentialId: null,
  domain: '',
  applicationPort: null,
  cloudflareCredentialId: null,
  cloudflareZoneId: null,
  configureDomain: false,
  applicationRoutes: [],
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
      environmentCredentialId: null,
      applicationRoutes: [],
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
    const upsertApplication = vi.fn().mockResolvedValue(ok(undefined));
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
      undefined,
      undefined,
      { upsertApplication } as never,
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
    expect(upsertApplication).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: 'target-1',
        name: 'shop-production',
        deploymentMode: 'scm',
        repositoryUrl: 'https://github.com/example/shop.git',
        branch: 'main',
        ownership: 'cloudforge-managed',
      }),
    );
  });

  it('moves the runtime application when an existing pipeline changes VPS target', async () => {
    const repository = new MemoryPipelines();
    repository.records.set('pipeline-1', {
      id: 'pipeline-1',
      folder: 'cloudforge-production-vps-target-1',
      ...input,
      applicationPort: null,
      githubCredentialId: null,
      environmentCredentialId: null,
      applicationRoutes: [],
      cloudflareCredentialId: null,
      cloudflareZoneId: null,
      lastStatus: 'configured',
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    });
    const upsertApplication = vi.fn().mockResolvedValue(ok(undefined));
    const removeApplication = vi.fn().mockResolvedValue(ok(undefined));
    const service = new JenkinsPipelineService(
      repository,
      {
        get: vi.fn((targetId: string) =>
          Promise.resolve(
            ok({
              id: targetId,
              name: targetId === 'target-1' ? 'Old VPS' : 'New VPS',
              host: targetId === 'target-1' ? '203.0.113.10' : '203.0.113.11',
            }),
          ),
        ),
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
        removeJob: vi.fn().mockResolvedValue(ok(undefined)),
      } as unknown as JenkinsManager,
      { recordSafe: vi.fn() } as unknown as ActivityService,
      undefined,
      undefined,
      { upsertApplication, removeApplication } as never,
    );

    const result = await service.save({
      ...input,
      id: 'pipeline-1',
      targetId: 'target-2',
      githubCredentialId: null,
    });

    expect(result.ok).toBe(true);
    expect(upsertApplication).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'target-2', sourceId: 'pipeline-1' }),
    );
    expect(removeApplication).toHaveBeenCalledWith('target-1', 'pipeline-1');
  });

  it('synchronizes an encrypted environment file as a folder-scoped Jenkins secret', async () => {
    const repository = new MemoryPipelines();
    const environmentContent =
      'APP_ENV=production\nCLOUDFORGE_OPTIONAL_PLACEHOLDERS=MAIL_HOST,MAIL_FROM_ADDRESS\nMAIL_HOST=CHANGE_ME_MAIL_HOST\nMAIL_FROM_ADDRESS="CHANGE_ME_MAIL_FROM"';
    const ensureSecretTextCredential = vi.fn().mockResolvedValue(ok(undefined));
    const upsertJob = vi.fn().mockResolvedValue(ok(undefined));
    const service = new JenkinsPipelineService(
      repository,
      {
        get: vi
          .fn()
          .mockResolvedValue(ok({ id: 'target-1', name: 'Production VPS', host: '203.0.113.10' })),
      } as unknown as VpsTargetService,
      {
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
              : ok({
                  kind: 'environment-file',
                  data: { filename: '.env.production', content: environmentContent },
                }),
          ),
        ),
      } as unknown as CredentialService,
      {
        ensureFolder: vi.fn().mockResolvedValue(ok(undefined)),
        ensureGithubCredential: vi.fn().mockResolvedValue(ok(undefined)),
        ensureSecretTextCredential,
        upsertJob,
      } as unknown as JenkinsManager,
      { recordSafe: vi.fn() } as unknown as ActivityService,
    );

    const result = await service.save({
      ...input,
      githubCredentialId: null,
      environmentCredentialId: 'env-1',
    });

    expect(result.ok).toBe(true);
    expect(ensureSecretTextCredential).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('cloudforge-production-vps'),
      expect.stringMatching(/^cloudforge-env-/),
      Buffer.from(environmentContent).toString('base64'),
      'CloudForge .env.production',
    );
    expect(upsertJob).toHaveBeenCalled();
    const definition = upsertJob.mock.calls[0]?.[1] as unknown as JenkinsJobDefinition;
    expect(definition.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'CLOUDFORGE_ENV_CREDENTIAL_ID' })]),
    );
    expect(JSON.stringify([...repository.records.values()])).not.toContain('APP_ENV=production');
  });

  it('deletes the remote job and empty folder before removing local state', async () => {
    const repository = new MemoryPipelines();
    const record: JenkinsPipelineRecord = {
      id: 'pipeline-1',
      folder: 'cloudforge-production-vps-target-1',
      ...input,
      environmentCredentialId: null,
      applicationRoutes: [],
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
      environmentCredentialId: null,
      applicationRoutes: [],
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
      applicationRoutes: [{ path: '/app', port: 8081 }],
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
        locations: [
          {
            path: '/app',
            upstreamHost: '127.0.0.1',
            upstreamPort: 8081,
            websocket: true,
            proxyTimeoutSeconds: 3600,
          },
        ],
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
      environmentCredentialId: null,
      applicationRoutes: [],
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

  describe('managed parameters', () => {
    const targets = () =>
      ({
        get: vi
          .fn()
          .mockResolvedValue(ok({ id: 'target-1', name: 'Production VPS', host: '203.0.113.10' })),
      }) as unknown as VpsTargetService;
    const credentials = () =>
      ({
        getDecrypted: vi.fn().mockResolvedValue(
          ok({
            kind: 'jenkins',
            data: { username: 'admin', apiToken: 'jenkins-secret', baseUrl: 'http://jenkins:8080' },
          }),
        ),
      }) as unknown as CredentialService;
    const domainAutomation = () =>
      [
        { ensure: vi.fn().mockResolvedValue(ok({ status: 'propagated' })) },
        {
          listSites: vi.fn().mockResolvedValue(ok([])),
          saveSite: vi.fn().mockResolvedValue(ok({ summary: 'saved' })),
        } as unknown as NginxService,
      ] as const;

    const stored = (over: Partial<JenkinsPipelineRecord> = {}): JenkinsPipelineRecord => ({
      id: 'pipeline-1',
      folder: 'cloudforge-production-vps-target-1',
      ...input,
      environmentCredentialId: null,
      applicationRoutes: [],
      githubCredentialId: null,
      applicationPort: null,
      cloudflareCredentialId: null,
      cloudflareZoneId: null,
      parameters: [],
      lastStatus: 'configured',
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
      ...over,
    });

    it('overrides a HOST_PORT the caller tried to set at trigger time', async () => {
      // The Nginx site this service wrote proxies to 8000. A build honouring the
      // caller's 9999 deploys the container where the proxy is not looking, and
      // the domain answers 502 with nothing in the log to explain it.
      const repository = new MemoryPipelines();
      repository.records.set(
        'pipeline-1',
        stored({
          configureDomain: true,
          domain: 'app.example.com',
          applicationPort: 8000,
          parameters: [
            {
              name: 'HOST_PORT',
              type: 'string',
              defaultValue: '8000',
              description: '',
              choices: [],
              managed: true,
            },
          ],
        }),
      );
      const trigger = vi.fn().mockResolvedValue(ok(undefined));
      const service = new JenkinsPipelineService(
        repository,
        targets(),
        credentials(),
        { trigger } as unknown as JenkinsManager,
        { recordSafe: vi.fn() } as unknown as ActivityService,
      );

      await service.trigger('pipeline-1', { HOST_PORT: '9999' });

      expect(trigger.mock.calls[0]?.[3]).toMatchObject({ HOST_PORT: '8000' });
    });

    it('still lets a caller set a parameter CloudForge does not own', async () => {
      const repository = new MemoryPipelines();
      repository.records.set(
        'pipeline-1',
        stored({
          parameters: [
            {
              name: 'IMAGE_TAG',
              type: 'string',
              defaultValue: 'latest',
              description: '',
              choices: [],
            },
          ],
        }),
      );
      const trigger = vi.fn().mockResolvedValue(ok(undefined));
      const service = new JenkinsPipelineService(
        repository,
        targets(),
        credentials(),
        { trigger } as unknown as JenkinsManager,
        { recordSafe: vi.fn() } as unknown as ActivityService,
      );

      await service.trigger('pipeline-1', { IMAGE_TAG: 'v2' });

      expect(trigger.mock.calls[0]?.[3]).toMatchObject({ IMAGE_TAG: 'v2' });
    });

    it('withdraws the HOST_PORT it added once domain automation is switched off', async () => {
      // Left behind, its default freezes at the old port and nothing maintains it.
      const repository = new MemoryPipelines();
      repository.records.set(
        'pipeline-1',
        stored({
          configureDomain: true,
          applicationPort: 8000,
          parameters: [
            {
              name: 'HOST_PORT',
              type: 'string',
              defaultValue: '8000',
              description: '',
              choices: [],
              managed: true,
            },
          ],
        }),
      );
      const upsertJob = vi.fn().mockResolvedValue(ok(undefined));
      const service = new JenkinsPipelineService(
        repository,
        targets(),
        credentials(),
        {
          ensureFolder: vi.fn().mockResolvedValue(ok(undefined)),
          upsertJob,
        } as unknown as JenkinsManager,
        { recordSafe: vi.fn() } as unknown as ActivityService,
      );

      const result = await service.save({
        ...input,
        id: 'pipeline-1',
        githubCredentialId: null,
        parameters: [
          {
            name: 'HOST_PORT',
            type: 'string',
            defaultValue: '8000',
            description: '',
            choices: [],
            managed: true,
          },
        ],
        configureDomain: false,
        applicationPort: null,
      });

      expect(result.ok && result.value.parameters).toEqual([]);
    });

    it('leaves a HOST_PORT it never added alone', async () => {
      // Requirement 20: a resource CloudForge did not create is not its to
      // withdraw. A pipeline that never had domain automation on may carry a
      // HOST_PORT the user wrote by hand.
      const repository = new MemoryPipelines();
      repository.records.set('pipeline-1', stored({ configureDomain: false }));
      const service = new JenkinsPipelineService(
        repository,
        targets(),
        credentials(),
        {
          ensureFolder: vi.fn().mockResolvedValue(ok(undefined)),
          upsertJob: vi.fn().mockResolvedValue(ok(undefined)),
        } as unknown as JenkinsManager,
        { recordSafe: vi.fn() } as unknown as ActivityService,
      );

      const result = await service.save({
        ...input,
        id: 'pipeline-1',
        githubCredentialId: null,
        parameters: [
          { name: 'HOST_PORT', type: 'string', defaultValue: '3000', description: '', choices: [] },
        ],
        configureDomain: false,
        applicationPort: null,
      });

      expect(result.ok && result.value.parameters).toEqual([
        expect.objectContaining({ name: 'HOST_PORT', defaultValue: '3000' }),
      ]);
    });

    it('marks what it owns so the UI can refuse to edit it', async () => {
      const repository = new MemoryPipelines();
      const [managedDns, nginx] = domainAutomation();
      const service = new JenkinsPipelineService(
        repository,
        targets(),
        credentials(),
        {
          ensureFolder: vi.fn().mockResolvedValue(ok(undefined)),
          upsertJob: vi.fn().mockResolvedValue(ok(undefined)),
        } as unknown as JenkinsManager,
        { recordSafe: vi.fn() } as unknown as ActivityService,
        managedDns,
        nginx,
      );

      const result = await service.save({
        ...input,
        githubCredentialId: null,
        parameters: [],
        configureDomain: true,
        domain: 'app.example.com',
        applicationPort: 8000,
      });

      expect(result.ok && result.value.parameters[0]).toMatchObject({
        name: 'HOST_PORT',
        managed: true,
      });
    });

    it('describes a parameter it owns in its own words', async () => {
      // Keeping whatever text arrived lets a parameter this service owns
      // describe itself as something else.
      const repository = new MemoryPipelines();
      const [managedDns, nginx] = domainAutomation();
      const service = new JenkinsPipelineService(
        repository,
        targets(),
        credentials(),
        {
          ensureFolder: vi.fn().mockResolvedValue(ok(undefined)),
          upsertJob: vi.fn().mockResolvedValue(ok(undefined)),
        } as unknown as JenkinsManager,
        { recordSafe: vi.fn() } as unknown as ActivityService,
        managedDns,
        nginx,
      );

      const result = await service.save({
        ...input,
        githubCredentialId: null,
        parameters: [
          {
            name: 'HOST_PORT',
            type: 'string',
            defaultValue: '1',
            description: 'Anything you like',
            choices: [],
          },
        ],
        configureDomain: true,
        domain: 'app.example.com',
        applicationPort: 8000,
      });

      expect(result.ok && result.value.parameters[0]?.description).toContain(
        'Managed by CloudForge',
      );
      expect(result.ok && result.value.parameters[0]?.defaultValue).toBe('8000');
    });

    it('restates the port over whatever Jenkins reports', async () => {
      // Jenkins is not the record of intent. Reading a hand-edited value back as
      // the plan is how the edit silently becomes the configuration, while the
      // Nginx site keeps proxying to the original port.
      const repository = new MemoryPipelines();
      repository.records.set(
        'pipeline-1',
        stored({ configureDomain: true, domain: 'app.example.com', applicationPort: 8000 }),
      );
      const service = new JenkinsPipelineService(
        repository,
        targets(),
        credentials(),
        {
          status: vi.fn().mockResolvedValue(
            ok({
              parameters: [
                {
                  name: 'HOST_PORT',
                  type: 'string',
                  defaultValue: '9999',
                  description: 'edited in Jenkins',
                  choices: [],
                },
              ],
              builds: [],
            }),
          ),
        } as unknown as JenkinsManager,
        { recordSafe: vi.fn() } as unknown as ActivityService,
      );

      const result = await service.status('pipeline-1');

      expect(result.ok && result.value.parameters).toEqual([
        expect.objectContaining({ name: 'HOST_PORT', defaultValue: '8000', managed: true }),
      ]);
    });
  });

  it('blocks a Jenkins build before queueing when the selected environment still has placeholders', async () => {
    const repository = new MemoryPipelines();
    const record: JenkinsPipelineRecord = {
      id: 'pipeline-1',
      folder: 'cloudforge-production-vps-target-1',
      ...input,
      environmentCredentialId: 'environment-1',
      applicationRoutes: [],
      githubCredentialId: null,
      applicationPort: null,
      cloudflareCredentialId: null,
      cloudflareZoneId: null,
      parameters: [
        {
          name: 'CLOUDFORGE_ENV_CREDENTIAL_ID',
          type: 'string',
          defaultValue: 'cloudforge-env-pipeline-1',
          description: '',
          choices: [],
        },
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
              : ok({
                  kind: 'environment-file',
                  data: {
                    filename: '.env.production',
                    content:
                      'APP_ENV=production\nREDIS_PASSWORD=CHANGE_ME_REDIS_PASSWORD\nMAIL_HOST=CHANGE_ME_MAIL_HOST',
                  },
                }),
          ),
        ),
      } as unknown as CredentialService,
      {
        ensureSecretTextCredential: vi.fn().mockResolvedValue(ok(undefined)),
        trigger,
      } as unknown as JenkinsManager,
      { recordSafe: vi.fn() } as unknown as ActivityService,
    );

    const result = await service.trigger(record.id, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('REDIS_PASSWORD');
      expect(result.error.message).toContain('MAIL_HOST');
    }
    expect(trigger).not.toHaveBeenCalled();
  });

  it('refreshes the folder-scoped environment secret before queueing each build', async () => {
    const repository = new MemoryPipelines();
    const record: JenkinsPipelineRecord = {
      id: 'pipeline-1',
      folder: 'cloudforge-production-vps-target-1',
      ...input,
      environmentCredentialId: 'environment-1',
      applicationRoutes: [],
      githubCredentialId: null,
      applicationPort: null,
      cloudflareCredentialId: null,
      cloudflareZoneId: null,
      parameters: [
        {
          name: 'CLOUDFORGE_ENV_CREDENTIAL_ID',
          type: 'string',
          defaultValue: '',
          description: '',
          choices: [],
        },
      ],
      lastStatus: 'configured',
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    };
    repository.records.set(record.id, record);
    const ensureSecretTextCredential = vi.fn().mockResolvedValue(ok(undefined));
    const trigger = vi.fn().mockResolvedValue(ok(undefined));
    const service = new JenkinsPipelineService(
      repository,
      {
        get: vi
          .fn()
          .mockResolvedValue(ok({ id: 'target-1', name: 'Production VPS', host: '203.0.113.10' })),
      } as unknown as VpsTargetService,
      {
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
              : ok({
                  kind: 'environment-file',
                  data: { filename: '.env.production', content: 'APP_ENV=production' },
                }),
          ),
        ),
      } as unknown as CredentialService,
      { ensureSecretTextCredential, trigger } as unknown as JenkinsManager,
      { recordSafe: vi.fn() } as unknown as ActivityService,
    );

    const result = await service.trigger(record.id, {});

    expect(result.ok).toBe(true);
    expect(ensureSecretTextCredential).toHaveBeenCalledWith(
      expect.anything(),
      record.folder,
      'cloudforge-env-pipeline-1',
      Buffer.from('APP_ENV=production').toString('base64'),
      'CloudForge .env.production',
    );
    expect(trigger).toHaveBeenCalledWith(expect.anything(), record.folder, record.name, {
      CLOUDFORGE_ENV_CREDENTIAL_ID: 'cloudforge-env-pipeline-1',
    });
  });

  it('synchronizes Jenkinsfile parameters discovered after the first build', async () => {
    const repository = new MemoryPipelines();
    const record: JenkinsPipelineRecord = {
      id: 'pipeline-1',
      folder: 'cloudforge-production-vps-target-1',
      ...input,
      environmentCredentialId: null,
      applicationRoutes: [],
      githubCredentialId: null,
      applicationPort: null,
      cloudflareCredentialId: null,
      cloudflareZoneId: null,
      lastStatus: 'configured',
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    };
    repository.records.set(record.id, record);
    const discovered = [
      {
        name: 'DEPLOY_ACTION',
        type: 'choice' as const,
        defaultValue: 'deploy',
        description: 'Deployment mode',
        choices: ['deploy', 'deploy_and_migrate'],
      },
      {
        name: 'CONFIRM_WIPE',
        type: 'string' as const,
        defaultValue: '',
        description: '',
        choices: [],
      },
    ];
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
        status: vi.fn().mockResolvedValue(
          ok({
            exists: true,
            enabled: true,
            color: 'red',
            inQueue: false,
            lastBuildNumber: 1,
            lastBuildResult: 'FAILURE',
            lastBuildUrl: 'http://jenkins/build/1',
            parameters: discovered,
          }),
        ),
      } as unknown as JenkinsManager,
      { recordSafe: vi.fn() } as unknown as ActivityService,
    );

    const result = await service.status(record.id);

    expect(result.ok && result.value.parameters).toEqual(discovered);
    expect(repository.records.get(record.id)?.parameters).toEqual(discovered);
    expect(repository.records.get(record.id)?.lastStatus).toBe('FAILURE');
  });

  it('preserves the CloudForge-managed environment credential when Jenkins reports an empty default', async () => {
    const repository = new MemoryPipelines();
    const record: JenkinsPipelineRecord = {
      id: 'pipeline-1',
      folder: 'cloudforge-production-vps-target-1',
      ...input,
      environmentCredentialId: 'environment-1',
      applicationRoutes: [],
      githubCredentialId: null,
      applicationPort: null,
      cloudflareCredentialId: null,
      cloudflareZoneId: null,
      parameters: [
        {
          name: 'CLOUDFORGE_ENV_CREDENTIAL_ID',
          type: 'string',
          defaultValue: '',
          description: '',
          choices: [],
        },
      ],
      lastStatus: 'configured',
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    };
    repository.records.set(record.id, record);
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
        status: vi.fn().mockResolvedValue(
          ok({
            exists: true,
            enabled: true,
            color: 'blue',
            inQueue: false,
            lastBuildNumber: 2,
            lastBuildResult: 'SUCCESS',
            lastBuildUrl: 'http://jenkins/build/2',
            parameters: [
              {
                name: 'CLOUDFORGE_ENV_CREDENTIAL_ID',
                type: 'string',
                defaultValue: '',
                description: '',
                choices: [],
              },
            ],
          }),
        ),
      } as unknown as JenkinsManager,
      { recordSafe: vi.fn() } as unknown as ActivityService,
    );

    const result = await service.status(record.id);

    expect(result.ok && result.value.parameters).toContainEqual(
      expect.objectContaining({
        name: 'CLOUDFORGE_ENV_CREDENTIAL_ID',
        defaultValue: 'cloudforge-env-pipeline-1',
      }),
    );
    expect(repository.records.get(record.id)?.parameters).toContainEqual(
      expect.objectContaining({
        name: 'CLOUDFORGE_ENV_CREDENTIAL_ID',
        defaultValue: 'cloudforge-env-pipeline-1',
      }),
    );
  });
});
