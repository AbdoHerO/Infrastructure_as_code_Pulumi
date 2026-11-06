import { z } from 'zod/v4';
import { type McpTool, McpToolError, toolset } from '../types.js';
import { id } from './common.js';

const core = toolset('core');
const extras = toolset('extras');

const operationId = id('From the tool that started it, or operations_list');
const LOG_TAIL_LINES = 200;

/** Pages the window can be asked to show. */
export const UI_PAGES = [
  '/',
  '/documentation',
  '/projects',
  '/infrastructure',
  '/deployments',
  '/containers',
  '/vps-runtime',
  '/ansible',
  '/nginx',
  '/firewall',
  '/ssl',
  '/cloudflare',
  '/jenkins',
  '/wordpress',
  '/stacks',
  '/terminal',
  '/providers',
  '/templates',
  '/secrets',
  '/ssh-keys',
  '/logs',
  '/plugins',
  '/updates',
  '/settings',
  '/about',
] as const;

export const OPERATION_TOOLS: readonly McpTool[] = [
  core.custom(
    'mcp_get_permissions',
    [],
    'read',
    'What this connection may do: which kinds of tool are allowed, which toolsets are off, and which project it is working on. Permissions can only be changed by the user, in CloudForge under Settings, MCP.',
    {},
    (_input, context) => {
      const settings = context.settings();
      return Promise.resolve({
        tiers: settings.tiers,
        disabledToolsets: settings.disabledToolsets,
        allowProjectSwitch: settings.allowProjectSwitch,
        pinnedProjectId: context.session.pinnedProjectId,
      });
    },
    { openWorld: false, needsProject: false },
  ),
  core.custom(
    'operations_list',
    [],
    'read',
    'Long-running operations started by MCP clients, newest first. Finished ones are kept for an hour.',
    {},
    (_input, context) => Promise.resolve(context.operations.list()),
    { openWorld: false, needsProject: false },
  ),
  core.custom(
    'operations_get',
    [],
    'read',
    "An operation's state, result or error.",
    { operationId },
    (input, context) => {
      const view = context.operations.get(input.operationId);
      if (!view) throw new McpToolError('No such operation.');
      return Promise.resolve({
        ...view,
        logTail: context.operations.tail(input.operationId, LOG_TAIL_LINES),
      });
    },
    { openWorld: false, needsProject: false },
  ),
  core.custom(
    'operations_wait',
    [],
    'read',
    'Wait for an operation to finish, up to a limit, and return where it stands.',
    { operationId, waitSeconds: z.number().int().min(0).max(300).default(60) },
    async (input, context) => {
      const view = await context.operations.wait(input.operationId, input.waitSeconds * 1000);
      if (!view) throw new McpToolError('No such operation.');
      return { ...view, logTail: context.operations.tail(input.operationId, LOG_TAIL_LINES) };
    },
    { openWorld: false, needsProject: false },
  ),
  core.custom(
    'operations_logs',
    [],
    'read',
    "An operation's log lines from a cursor. Pass back nextCursor to read only new lines.",
    {
      operationId,
      cursor: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(2000).default(500),
    },
    (input, context) => {
      const logs = context.operations.logs(input.operationId, input.cursor, input.limit);
      if (!logs) throw new McpToolError('No such operation.');
      return Promise.resolve(logs);
    },
    { openWorld: false, needsProject: false },
  ),
  core.custom(
    'operations_cancel',
    [],
    'write',
    'Ask an operation to stop. Deployments and Ansible runs can stop; other kinds answer that they cannot. Steps already done are not rolled back.',
    { operationId },
    (input, context) => context.operations.cancel(input.operationId),
    { openWorld: false, needsProject: false, destructive: false },
  ),
];

export const EXTRA_TOOLS: readonly McpTool[] = [
  extras.custom(
    'docs_search',
    [],
    'read',
    "Search CloudForge's documentation. Every word must appear in an article. With no query, lists all articles.",
    { query: z.string().default('') },
    (input, context) => {
      const terms = input.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      return Promise.resolve(
        context
          .documentation()
          .filter((article) => {
            const text = `${article.title}\n${article.summary}\n${article.content}`.toLowerCase();
            return terms.every((term) => text.includes(term));
          })
          .map(({ content: _content, ...article }) => article),
      );
    },
    { openWorld: false, needsProject: false },
  ),
  extras.custom(
    'docs_read',
    [],
    'read',
    'One documentation article.',
    { id: id('Article id, from docs_search') },
    (input, context) => {
      const article = context.documentation().find((item) => item.id === input.id);
      if (!article) throw new McpToolError('No such article. Use docs_search to list them.');
      return Promise.resolve(article);
    },
    { openWorld: false, needsProject: false },
  ),
  extras.custom(
    'ui_navigate',
    [],
    'local',
    'Show a page in the CloudForge window.',
    { page: z.enum(UI_PAGES) },
    (input, context) => {
      context.emit('ui:command', { kind: 'navigate', path: input.page });
      return Promise.resolve({ shown: input.page });
    },
    { openWorld: false, needsProject: false },
  ),
  extras.custom(
    'ui_set_theme',
    [],
    'local',
    "Change the CloudForge window's theme.",
    { theme: z.enum(['light', 'dark', 'system']) },
    (input, context) => {
      context.emit('ui:command', { kind: 'theme', theme: input.theme });
      return Promise.resolve({ theme: input.theme });
    },
    { openWorld: false, needsProject: false, idempotent: true },
  ),
];
