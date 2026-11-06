import { McpToolError, type McpCallContext } from './types.js';

export interface McpResourceDescriptor {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

const JSON_TYPE = 'application/json';
const MARKDOWN_TYPE = 'text/markdown';
const TEXT_TYPE = 'text/plain';

const resource = (
  uri: string,
  name: string,
  description: string,
  mimeType = JSON_TYPE,
): McpResourceDescriptor => ({ uri, name, description, mimeType });

/** Read-only context a client can attach, and follow when it can subscribe. */
export const MCP_RESOURCES: readonly McpResourceDescriptor[] = [
  resource('cloudforge://app/info', 'Application', 'Version, build and platform'),
  resource('cloudforge://app/updates', 'Updates', 'The update state'),
  resource('cloudforge://project/current', 'Open project', 'The project open in the window'),
  resource('cloudforge://projects', 'Projects', 'Every project on this computer'),
  resource('cloudforge://targets', 'VPS targets', 'Saved VPS targets'),
  resource('cloudforge://cloudflare/changes', 'Cloudflare', 'The latest Cloudflare sync activity'),
  resource('cloudforge://activity', 'Activity', 'The last 100 activity events'),
  resource('cloudforge://logs/app', 'Application log', 'The last 400 log lines', TEXT_TYPE),
  resource('cloudforge://settings', 'Settings', "The open project's settings"),
  resource('cloudforge://catalog/ansible-profiles', 'Ansible profiles', 'What Ansible can install'),
  resource(
    'cloudforge://catalog/deployment-templates',
    'Deployment templates',
    'Templates for deploy_run',
  ),
  resource(
    'cloudforge://catalog/infra-templates',
    'Infrastructure templates',
    'Built-in plan templates',
  ),
  resource(
    'cloudforge://catalog/resource-presets',
    'Resource presets',
    'Starting points for writing a plan',
  ),
  resource('cloudforge://catalog/dns-templates', 'DNS templates', 'Ready-made DNS records'),
  resource(
    'cloudforge://catalog/credential-kinds',
    'Credential kinds',
    'Each kind of credential and its fields',
  ),
  resource('cloudforge://catalog/plugins', 'Extensions', 'Built-in extensions'),
];

export const MCP_RESOURCE_TEMPLATES: readonly {
  readonly uriTemplate: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}[] = [
  {
    uriTemplate: 'cloudforge://targets/{id}',
    name: 'VPS target',
    description: 'One saved VPS target',
    mimeType: JSON_TYPE,
  },
  {
    uriTemplate: 'cloudforge://docs/{id}',
    name: 'Documentation article',
    description: "One article of CloudForge's documentation; docs_search lists them",
    mimeType: MARKDOWN_TYPE,
  },
  {
    uriTemplate: 'cloudforge://operations/{id}/log',
    name: 'Operation log',
    description: 'What a long-running operation has printed so far',
    mimeType: TEXT_TYPE,
  },
];

const json = (value: unknown): { mimeType: string; text: string } => ({
  mimeType: JSON_TYPE,
  text: JSON.stringify(value ?? null, null, 2),
});

/** The contents of a resource, read through the same channels as everything else. */
export async function readMcpResource(
  uri: string,
  context: McpCallContext,
): Promise<{ mimeType: string; text: string }> {
  const target = /^cloudforge:\/\/targets\/(.+)$/.exec(uri)?.[1];
  if (target) return json(await context.call('ansible:getTarget', { id: target }));

  const article = /^cloudforge:\/\/docs\/(.+)$/.exec(uri)?.[1];
  if (article) {
    const found = context.documentation().find((item) => item.id === article);
    if (!found) throw new McpToolError(`No documentation article called ${article}.`);
    return { mimeType: MARKDOWN_TYPE, text: found.content };
  }

  const operation = /^cloudforge:\/\/operations\/(.+)\/log$/.exec(uri)?.[1];
  if (operation) {
    const logs = context.operations.logs(operation);
    if (!logs) throw new McpToolError('No such operation.');
    return { mimeType: TEXT_TYPE, text: logs.lines.join('\n') };
  }

  switch (uri) {
    case 'cloudforge://app/info':
      return json(await context.call('app:getInfo', undefined));
    case 'cloudforge://app/updates':
      return json(await context.call('updates:state', undefined));
    case 'cloudforge://project/current':
      return json(await context.call('projects:session', undefined));
    case 'cloudforge://projects':
      return json(await context.call('projects:picker', undefined));
    case 'cloudforge://targets':
      return json(await context.call('ansible:targets', undefined));
    case 'cloudforge://cloudflare/changes':
      return json(await context.call('activity:list', { limit: 20, typePrefix: 'cloudflare.' }));
    case 'cloudforge://activity':
      return json(await context.call('activity:list', { limit: 100 }));
    case 'cloudforge://logs/app':
      return {
        mimeType: TEXT_TYPE,
        text: (await context.call('logs:tail', { lines: 400 })).join('\n'),
      };
    case 'cloudforge://settings':
      return json(await context.call('settings:get', undefined));
    case 'cloudforge://catalog/ansible-profiles':
      return json(await context.call('ansible:profiles', undefined));
    case 'cloudforge://catalog/deployment-templates':
      return json(await context.call('deploy:templates', undefined));
    case 'cloudforge://catalog/infra-templates':
      return json(await context.call('infra:templates', undefined));
    case 'cloudforge://catalog/resource-presets':
      return json(await context.call('infra:resourcePresets', {}));
    case 'cloudforge://catalog/dns-templates':
      return json(await context.call('cloudflare:dnsTemplates', undefined));
    case 'cloudforge://catalog/credential-kinds':
      return json(await context.call('credentials:kinds', undefined));
    case 'cloudforge://catalog/plugins':
      return json(await context.call('plugins:list', undefined));
    default:
      throw new McpToolError(`There is no resource at ${uri}.`);
  }
}
