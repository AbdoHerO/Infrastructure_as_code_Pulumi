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
  it('lets the Jenkins Folder plugin initialize a new folder', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 302 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new JenkinsHttpManager().ensureFolder(connection, 'cloudforge-vps');

    expect(result.ok).toBe(true);
    const createRequest = fetchMock.mock.calls[2];
    expect(createRequest?.[0]).toContain('mode=com.cloudbees.hudson.plugins.folder.Folder');
    expect(createRequest?.[1]).toMatchObject({
      method: 'POST',
      body: 'json=%7B%7D',
    });
  });

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

  it('removes invalid XML control characters from Jenkins job fields', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 302 }));
    vi.stubGlobal('fetch', fetchMock);
    const definition: JenkinsJobDefinition = {
      folder: 'cloudforge-vps',
      name: 'shop-api',
      description: 'Deploy →\u0086 safely',
      repositoryUrl: 'https://github.com/acme/shop.git',
      branch: 'main',
      jenkinsfilePath: 'Jenkinsfile',
      pipelineScript: '',
      definitionMode: 'scm',
      githubCredentialId: null,
      parameters: [
        {
          name: 'DEPLOY_ACTION',
          type: 'choice',
          description: 'Deploy\u0086 without corrupting Jenkins XML',
          defaultValue: 'deploy',
          choices: ['deploy', 'deploy_and_migrate'],
        },
      ],
      environment: {},
    };

    const result = await new JenkinsHttpManager().upsertJob(connection, definition);

    expect(result.ok).toBe(true);
    const requestBody = fetchMock.mock.calls[2]?.[1]?.body;
    expect(typeof requestBody).toBe('string');
    expect(requestBody).not.toContain('\u0086');
    expect(requestBody).toContain('Deploy → safely');
    expect(requestBody).toContain('Deploy without corrupting Jenkins XML');
    expect(requestBody).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    const headers = fetchMock.mock.calls[2]?.[1]?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get('content-type')).toBe('application/xml; charset=UTF-8');
  });

  it('updates a folder-scoped secret-text credential without exposing it in a job', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new JenkinsHttpManager().ensureSecretTextCredential(
      connection,
      'cloudforge-vps',
      'cloudforge-env-app',
      'QVBQX0VOVj1wcm9kdWN0aW9u',
      'CloudForge .env.production',
    );

    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/credential/cloudforge-env-app/config.xml');
    const body = fetchMock.mock.calls[1]?.[1]?.body;
    expect(typeof body === 'string' && body).toContain(
      'org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl',
    );
    expect(typeof body === 'string' && body).toContain('QVBQX0VOVj1wcm9kdWN0aW9u');
  });

  it('maps a missing Jenkins job to a safe not-found status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 })),
    );

    const result = await new JenkinsHttpManager().status(connection, 'cloudforge-vps', 'missing');

    expect(result.ok && result.value).toMatchObject({ exists: false, enabled: false });
  });

  it('deletes a CloudForge folder only when it has no jobs', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ jobs: [] }))
      .mockResolvedValueOnce(Response.json({ crumbRequestField: 'Jenkins-Crumb', crumb: 'crumb' }))
      .mockResolvedValueOnce(new Response('', { status: 302 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new JenkinsHttpManager().pruneEmptyFolder(connection, 'cloudforge-vps');

    expect(result).toEqual({ ok: true, value: true });
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      'https://jenkins.example.com/job/cloudforge-vps/doDelete',
    );
  });

  it('keeps a Jenkins folder that still contains another pipeline', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ jobs: [{ name: 'another-pipeline' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new JenkinsHttpManager().pruneEmptyFolder(connection, 'cloudforge-vps');

    expect(result).toEqual({ ok: true, value: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a new pipeline without a build as not built', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        buildable: true,
        color: 'notbuilt',
        inQueue: false,
        lastBuild: null,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new JenkinsHttpManager().status(
      connection,
      'cloudforge-vps',
      'new-pipeline',
    );

    expect(result.ok && result.value).toEqual({
      exists: true,
      enabled: true,
      color: 'notbuilt',
      inQueue: false,
      lastBuildNumber: null,
      lastBuildResult: null,
      lastBuildUrl: null,
      parameters: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://jenkins.example.com/job/cloudforge-vps/job/new-pipeline/api/json',
    );
  });

  it('loads the result of an existing last build separately', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          buildable: true,
          color: 'blue',
          inQueue: false,
          lastBuild: { number: 7, url: 'https://jenkins.example.com/build/7/' },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          number: 7,
          result: 'SUCCESS',
          url: 'https://jenkins.example.com/build/7/',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new JenkinsHttpManager().status(
      connection,
      'cloudforge-vps',
      'deployed-pipeline',
    );

    expect(result.ok && result.value).toMatchObject({
      lastBuildNumber: 7,
      lastBuildResult: 'SUCCESS',
      lastBuildUrl: 'https://jenkins.example.com/build/7/',
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://jenkins.example.com/job/cloudforge-vps/job/deployed-pipeline/7/api/json?tree=number,result,url',
    );
  });

  it('discovers parameters evaluated from a repository Jenkinsfile', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          buildable: true,
          color: 'red',
          inQueue: false,
          lastBuild: { number: 1, result: 'FAILURE', url: 'https://jenkins/build/1/' },
          property: [
            {
              parameterDefinitions: [
                {
                  name: 'DEPLOY_ACTION',
                  description: 'Deployment mode',
                  _class: 'hudson.model.ChoiceParameterDefinition',
                  choices: ['deploy', 'deploy_and_migrate', 'deploy_migrate_seed'],
                  defaultParameterValue: { value: 'deploy' },
                },
                {
                  name: 'CONFIRM_WIPE',
                  _class: 'hudson.model.StringParameterDefinition',
                  defaultParameterValue: { value: '' },
                },
              ],
            },
          ],
        }),
      ),
    );

    const result = await new JenkinsHttpManager().status(connection, 'cloudforge-vps', 'shop-api');

    expect(result.ok && result.value.parameters).toEqual([
      expect.objectContaining({
        name: 'DEPLOY_ACTION',
        type: 'choice',
        defaultValue: 'deploy',
        choices: ['deploy', 'deploy_and_migrate', 'deploy_migrate_seed'],
      }),
      expect.objectContaining({
        name: 'CONFIRM_WIPE',
        type: 'string',
        defaultValue: '',
      }),
    ]);
  });
});
