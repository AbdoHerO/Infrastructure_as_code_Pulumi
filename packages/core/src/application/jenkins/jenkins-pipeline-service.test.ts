import { describe, expect, it, vi } from 'vitest';
import { ok } from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type { CredentialService } from '../credentials/credential-service.js';
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
});
