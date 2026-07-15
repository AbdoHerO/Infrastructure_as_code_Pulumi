import type { JenkinsConnection, JenkinsJobDefinition } from '@cloudforge/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JenkinsHttpManager } from './jenkins-http-manager.js';

const connection: JenkinsConnection = {
  baseUrl: 'https://jenkins.example.com',
  username: 'cloudforge',
  apiToken: 'jenkins-secret',
};

afterEach(() => vi.unstubAllGlobals());

describe('JenkinsHttpManager', () => {
  it('creates a parameterized SCM job without embedding the GitHub token', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 302 }));
    vi.stubGlobal('fetch', fetchMock);
    const definition: JenkinsJobDefinition = {
      folder: 'cloudforge-vps',
      name: 'shop-api',
      description: 'Deploy the API',
      repositoryUrl: 'https://github.com/acme/shop.git',
      branch: 'main',
      jenkinsfilePath: 'ci/Jenkinsfile',
      pipelineScript: '',
      definitionMode: 'scm',
      githubCredentialId: 'cloudforge-github-pipeline',
      parameters: [
        {
          name: 'IMAGE_TAG',
          type: 'string',
          description: 'Image to deploy',
          defaultValue: 'latest',
          choices: [],
        },
      ],
      environment: { APP_PORT: '3000' },
    };

    const result = await new JenkinsHttpManager().upsertJob(connection, definition);

    expect(result.ok).toBe(true);
    const createRequest = fetchMock.mock.calls[2];
    expect(createRequest?.[0]).toBe(
      'https://jenkins.example.com/job/cloudforge-vps/createItem?name=shop-api',
    );
    const requestBody = createRequest?.[1]?.body;
    expect(typeof requestBody).toBe('string');
    const body = typeof requestBody === 'string' ? requestBody : '';
    expect(body).toContain('https://github.com/acme/shop.git');
    expect(body).toContain('cloudforge-github-pipeline');
    expect(body).toContain('IMAGE_TAG');
    expect(body).not.toContain('jenkins-secret');
  });

  it('maps a missing Jenkins job to a safe not-found status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 })),
    );

    const result = await new JenkinsHttpManager().status(connection, 'cloudforge-vps', 'missing');

    expect(result.ok && result.value).toMatchObject({ exists: false, enabled: false });
  });
});
