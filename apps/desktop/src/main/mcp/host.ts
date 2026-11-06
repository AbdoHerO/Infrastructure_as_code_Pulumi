import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  isInitializeRequest,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import type {
  IpcChannel,
  IpcEventChannel,
  IpcEventPayload,
  IpcRequest,
  IpcResponse,
  IpcResult,
} from '../../shared/ipc/contract.js';
import type { McpClientInfo, McpSettings, McpTier } from '../../shared/mcp/types.js';
import type { McpApprovals } from './approvals.js';
import { CORE_TOOLSET, MCP_TOOLS } from './catalog/index.js';
import { alwaysUsesLocalFiles, usesLocalFiles } from './catalog/local-files.js';
import { type EventSubscriber, OperationManager } from './operations.js';
import { MCP_PROMPTS, renderPrompt } from './prompts.js';
import { describeCall } from './redaction.js';
import { MCP_RESOURCE_TEMPLATES, MCP_RESOURCES, readMcpResource } from './resources.js';
import { TerminalBuffers } from './terminal-buffers.js';
import {
  type McpCallContext,
  type McpDocumentationArticle,
  type McpSessionState,
  type McpTool,
  McpToolError,
} from './types.js';

export interface McpHostLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface McpHostDeps {
  call<C extends IpcChannel>(
    channel: C,
    payload: IpcRequest<C>,
  ): Promise<IpcResult<IpcResponse<C>>>;
  activeProjectId(): string | null;
  settings(): McpSettings;
  verifyToken(candidate: string): boolean;
  readonly approvals: McpApprovals;
  readonly subscribe: EventSubscriber;
  emit<C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>): void;
  /** Called after every call that is not a plain read. */
  audit(entry: { client: string; tool: string; outcome: 'succeeded' | 'failed' }): void;
  documentation(): readonly McpDocumentationArticle[];
  onClientsChanged(): void;
  readonly log: McpHostLog;
  now?(): number;
}

interface Session {
  readonly state: McpSessionState;
  readonly server: Server;
  readonly transport: StreamableHTTPServerTransport;
  readonly subscriptions: Set<string>;
  readonly connectedAt: string;
  clientVersion: string;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_WAIT_SECONDS = 45;
const MAX_WAIT_SECONDS = 300;
const LOG_TAIL_LINES = 200;
const MAX_RESULT_LENGTH = 1_000_000;

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Whether a tier is switched on at all; `critical` may still ask first. */
export function tierEnabled(settings: McpSettings, tier: McpTier): boolean {
  return tier === 'critical' ? settings.tiers.critical !== 'off' : settings.tiers[tier];
}

/** The tools this device's settings let a client see. */
export function visibleTools(settings: McpSettings): McpTool[] {
  return MCP_TOOLS.filter(
    (tool) =>
      tierEnabled(settings, tool.tier) &&
      (settings.tiers.local || !alwaysUsesLocalFiles(tool.name)) &&
      (tool.toolset === CORE_TOOLSET || !settings.disabledToolsets.includes(tool.toolset)) &&
      (!tool.needsProjectSwitch || settings.allowProjectSwitch),
  );
}

/** The JSON Schema a client sees: a slow tool also takes how long to wait. */
export function toolInputSchema(tool: McpTool): Record<string, unknown> {
  const schema = tool.operation
    ? tool.input.extend({
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_SECONDS)
          .optional()
          .describe(
            `How long to wait for it to finish, default ${String(DEFAULT_WAIT_SECONDS)}. If it is still running, the answer has an operationId for operations_wait.`,
          ),
      })
    : tool.input;
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, {
    io: 'input',
    target: 'draft-7',
  }) as Record<string, unknown>;
  return json;
}

function toolTitle(name: string): string {
  const words = name.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function textResult(
  value: unknown,
  isError = false,
): {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
} {
  const text = JSON.stringify(value ?? { ok: true }, null, 2);
  return {
    content: [
      {
        type: 'text',
        text:
          text.length > MAX_RESULT_LENGTH
            ? `${text.slice(0, MAX_RESULT_LENGTH)}\n… cut off at ${String(MAX_RESULT_LENGTH)} characters`
            : text,
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(error: unknown): ReturnType<typeof textResult> {
  if (error instanceof z.ZodError) {
    return textResult({ error: { code: 'INVALID_INPUT', message: z.prettifyError(error) } }, true);
  }
  if (error instanceof McpToolError) {
    return textResult(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
      true,
    );
  }
  return textResult(
    { error: { code: 'ERROR', message: error instanceof Error ? error.message : String(error) } },
    true,
  );
}

/**
 * The MCP server: authenticates on loopback, keeps one protocol session per client
 * and turns tool calls into the same channel calls the window makes.
 */
export class McpHost {
  private http: HttpServer | null = null;
  private port: number | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly stopFollowing: (() => void)[] = [];
  readonly operations: OperationManager;
  private readonly terminals: TerminalBuffers;

  constructor(private readonly deps: McpHostDeps) {
    this.operations = new OperationManager(deps.subscribe, () => this.now());
    this.terminals = new TerminalBuffers(deps.subscribe);
  }

  get url(): string | null {
    return this.port === null ? null : `http://127.0.0.1:${String(this.port)}/mcp`;
  }

  get running(): boolean {
    return this.http !== null;
  }

  clients(): McpClientInfo[] {
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.state.sessionId,
      name: session.state.clientName,
      version: session.clientVersion,
      connectedAt: session.connectedAt,
    }));
  }

  async start(port: number): Promise<void> {
    if (this.http) await this.stop();
    const http = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.deps.log.error({ event: 'mcp.http.failed', err: error }, 'MCP request failed');
        if (!response.headersSent) respond(response, 500, 'The request failed');
        else response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(port, '127.0.0.1', () => {
        http.off('error', reject);
        resolve();
      });
    });
    const address = http.address();
    this.port = typeof address === 'object' && address ? address.port : port;
    this.http = http;
    this.followChanges();
    this.deps.log.info({ event: 'mcp.started', port: this.port }, 'MCP server started');
  }

  async stop(): Promise<void> {
    for (const stop of this.stopFollowing.splice(0)) stop();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.transport.close()));
    const http = this.http;
    this.http = null;
    this.port = null;
    if (http) {
      http.closeAllConnections();
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
      });
      this.deps.log.info({ event: 'mcp.stopped' }, 'MCP server stopped');
    }
    this.deps.onClientsChanged();
  }

  /** Tell clients which tools they may now see. */
  notifyToolsChanged(): void {
    for (const session of this.sessions.values()) {
      void session.server.sendToolListChanged().catch(() => undefined);
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private followChanges(): void {
    const touch = (uri: string): void => {
      for (const session of this.sessions.values()) {
        if (session.subscriptions.has(uri)) {
          void session.server.sendResourceUpdated({ uri }).catch(() => undefined);
        }
      }
    };
    this.stopFollowing.push(
      this.deps.subscribe('vpsTargets:changed', () => touch('cloudforge://targets')),
      this.deps.subscribe('updates:state', () => touch('cloudforge://app/updates')),
      this.deps.subscribe('cloudflare:changed', () => touch('cloudforge://cloudflare/changes')),
      this.deps.subscribe('projects:sessionChanged', () => {
        touch('cloudforge://project/current');
        touch('cloudforge://projects');
      }),
      this.deps.subscribe('app:dataChanged', () => {
        touch('cloudforge://activity');
        touch('cloudforge://settings');
      }),
    );
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const refusal = this.refuse(request);
    if (refusal) return respond(response, refusal.status, refusal.message);

    const header = request.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;
    if (request.method === 'POST') {
      const body = await readJsonBody(request);
      if (body === null) return respond(response, 400, 'The request body is not valid JSON');
      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return respond(response, 404, 'This MCP session has ended');
        return session.transport.handleRequest(request, response, body);
      }
      if (!isInitializeRequest(body)) {
        return respond(response, 400, 'Start with an initialize request');
      }
      const transport = this.createSession();
      return transport.handleRequest(request, response, body);
    }
    if (request.method === 'GET' || request.method === 'DELETE') {
      const session = sessionId ? this.sessions.get(sessionId) : undefined;
      if (!session) return respond(response, 404, 'This MCP session has ended');
      return session.transport.handleRequest(request, response);
    }
    return respond(response, 405, 'Method not allowed');
  }

  /**
   * Only this computer, only with the token, and never from a web page. The port
   * is reachable by every program and every browser tab here, so being on loopback
   * proves nothing by itself: the token proves who is asking, and the Host and
   * Origin checks stop a web page from reaching this through DNS rebinding.
   */
  private refuse(request: IncomingMessage): { status: number; message: string } | null {
    if (!LOOPBACK_ADDRESSES.has(request.socket.remoteAddress ?? '')) {
      return { status: 403, message: 'Only this computer may connect' };
    }
    const path = (request.url ?? '').split('?')[0];
    if (path !== '/mcp') return { status: 404, message: 'Not found' };
    const host = (request.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (!LOOPBACK_NAMES.has(host)) return { status: 403, message: 'Unexpected Host header' };
    const origin = request.headers.origin;
    if (origin && !isLoopbackOrigin(origin)) {
      return { status: 403, message: 'Web pages may not connect' };
    }
    const authorization = request.headers.authorization ?? '';
    const token = /^Bearer (.+)$/i.exec(authorization)?.[1];
    if (!token || !this.deps.verifyToken(token)) {
      return { status: 401, message: 'A valid token is required' };
    }
    return null;
  }

  private createSession(): StreamableHTTPServerTransport {
    const state: McpSessionState = {
      sessionId: '',
      clientName: 'unknown',
      pinnedProjectId: null,
      inspectedHostKeys: new Map(),
    };
    const subscriptions = new Set<string>();
    const server = this.createProtocolServer(state, subscriptions);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        state.sessionId = sessionId;
        this.sessions.set(sessionId, {
          state,
          server,
          transport,
          subscriptions,
          connectedAt: new Date(this.now()).toISOString(),
          clientVersion: '',
        });
      },
    });
    transport.onclose = (): void => {
      if (state.sessionId && this.sessions.delete(state.sessionId)) {
        this.deps.onClientsChanged();
      }
    };
    server.oninitialized = (): void => {
      const client = server.getClientVersion();
      state.clientName = client?.name ?? 'unknown';
      const session = this.sessions.get(state.sessionId);
      if (session) session.clientVersion = client?.version ?? '';
      this.deps.log.info(
        { event: 'mcp.client.connected', client: state.clientName },
        'MCP client connected',
      );
      this.deps.onClientsChanged();
    };
    // The SDK's own class only misses its interface under exactOptionalPropertyTypes.
    void server.connect(transport as unknown as Transport);
    return transport;
  }

  private createProtocolServer(state: McpSessionState, subscriptions: Set<string>): Server {
    const server = new Server(
      { name: 'cloudforge', title: 'CloudForge', version: '1.0.0' },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { subscribe: true, listChanged: false },
          prompts: { listChanged: false },
        },
        instructions:
          'CloudForge manages cloud infrastructure and servers. Tools act on the project open in the CloudForge window. Saved VPS targets are referred to by id: start with targets_list. Changes that delete or cost something first run a preview, and critical ones ask the user to approve them in the CloudForge window. If a tool you expect is missing, mcp_get_permissions shows what the user has allowed; only the user can change that, in Settings under MCP. The prompts describe the usual workflows.',
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: visibleTools(this.deps.settings()).map((tool) => ({
        name: tool.name,
        title: toolTitle(tool.name),
        description: tool.description,
        inputSchema: toolInputSchema(tool) as { type: 'object' },
        annotations: {
          title: toolTitle(tool.name),
          readOnlyHint: tool.tier === 'read',
          destructiveHint: tool.destructive,
          idempotentHint: tool.idempotent,
          openWorldHint: tool.openWorld,
        },
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const progressToken = extra._meta?.progressToken;
      let progress = 0;
      const onLog =
        progressToken === undefined
          ? undefined
          : (line: string): void => {
              progress += 1;
              void extra
                .sendNotification({
                  method: 'notifications/progress',
                  params: { progressToken, progress, message: line },
                })
                .catch(() => undefined);
            };
      try {
        return await this.callTool(state, request.params.name, request.params.arguments, onLog);
      } catch (error) {
        return errorResult(error);
      }
    });

    server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [...MCP_RESOURCES] }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
      resourceTemplates: [...MCP_RESOURCE_TEMPLATES],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const contents = await readMcpResource(uri, this.context(state, randomUUID()));
      return { contents: [{ uri, mimeType: contents.mimeType, text: contents.text }] };
    });
    server.setRequestHandler(SubscribeRequestSchema, (request) => {
      subscriptions.add(request.params.uri);
      return {};
    });
    server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
      subscriptions.delete(request.params.uri);
      return {};
    });

    server.setRequestHandler(ListPromptsRequestSchema, () => ({
      prompts: MCP_PROMPTS.map(({ name, title, description, arguments: args }) => ({
        name,
        title,
        description,
        arguments: [...args],
      })),
    }));
    server.setRequestHandler(GetPromptRequestSchema, (request) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: renderPrompt(request.params.name, request.params.arguments ?? {}),
          },
        },
      ],
    }));
    return server;
  }

  private async callTool(
    state: McpSessionState,
    name: string,
    rawArguments: Record<string, unknown> | undefined,
    onLog: ((line: string) => void) | undefined,
  ): Promise<ReturnType<typeof textResult>> {
    const settings = this.deps.settings();
    const tool = visibleTools(settings).find((item) => item.name === name);
    if (!tool) {
      const hidden = MCP_TOOLS.some((item) => item.name === name);
      throw new McpToolError(
        hidden
          ? `${name} is switched off. The user can allow it in CloudForge under Settings, MCP.`
          : `There is no tool called ${name}.`,
        hidden ? 'TOOL_DISABLED' : 'UNKNOWN_TOOL',
      );
    }

    const { waitSeconds, ...args } = (rawArguments ?? {}) as Record<string, unknown> & {
      waitSeconds?: unknown;
    };
    const input = tool.input.parse(args);
    if (!settings.tiers.local && usesLocalFiles(tool.name, input)) {
      throw new McpToolError(
        'This call reads or writes a file on this computer, which is switched off. The user can allow it in CloudForge under Settings, MCP.',
        'TOOL_DISABLED',
      );
    }
    if (tool.needsProject) this.enforcePinnedProject(state);

    const critical = tool.tier === 'critical' || tool.escalate(input);
    if (critical) await this.requireApproval(settings, state, tool, input);

    const streamId = randomUUID();
    const context = this.context(state, streamId);
    if (!tool.operation) {
      try {
        const result = await tool.run(input, context);
        this.afterRun(state, tool, 'succeeded');
        return textResult(result);
      } catch (error) {
        this.afterRun(state, tool, 'failed');
        throw error;
      }
    }

    const { logChannel, cancelChannel } = tool.operation;
    const started = this.operations.start({
      id: streamId,
      tool: tool.name,
      client: state.clientName,
      logChannel,
      cancel: cancelChannel
        ? async (): Promise<void> => {
            await context.call(cancelChannel, { streamId });
          }
        : null,
      run: () => tool.run(input, context),
      ...(onLog ? { onLog } : {}),
      onFinished: (operation) =>
        this.afterRun(state, tool, operation.status === 'succeeded' ? 'succeeded' : 'failed'),
    });
    const waitMs = waitTime(waitSeconds) * 1000;
    const view = (await this.operations.wait(started.operationId, waitMs)) ?? started;
    const logTail = this.operations.tail(started.operationId, LOG_TAIL_LINES);
    if (view.status === 'running') {
      return textResult({
        ...view,
        logTail,
        note: 'Still running. Call operations_wait or operations_logs with this operationId.',
      });
    }
    return textResult({ ...view, logTail }, view.status === 'failed');
  }

  private afterRun(state: McpSessionState, tool: McpTool, outcome: 'succeeded' | 'failed'): void {
    if (tool.tier === 'read') return;
    this.deps.audit({ client: state.clientName, tool: tool.name, outcome });
    if (outcome === 'succeeded' && tool.channels.length > 0) {
      this.deps.emit('app:dataChanged', { channels: tool.channels, origin: 'mcp' });
    }
  }

  /**
   * A client that was working on one project must not carry on in another just
   * because someone switched the window: its next delete would land in the wrong
   * place. It has to look, and say it knows, by calling `projects_get_session`.
   */
  private enforcePinnedProject(state: McpSessionState): void {
    const active = this.deps.activeProjectId();
    if (!active) {
      throw new McpToolError(
        'No project is open. Ask the user to open and unlock a project in CloudForge.',
        'NO_PROJECT',
      );
    }
    if (state.pinnedProjectId === null) {
      state.pinnedProjectId = active;
      return;
    }
    if (state.pinnedProjectId !== active) {
      throw new McpToolError(
        'The project open in CloudForge has changed. Call projects_get_session to see which one is open, and check with the user before carrying on.',
        'PROJECT_CHANGED',
      );
    }
  }

  private async requireApproval(
    settings: McpSettings,
    state: McpSessionState,
    tool: McpTool,
    input: unknown,
  ): Promise<void> {
    if (settings.tiers.critical === 'off') {
      throw new McpToolError(
        'This call is critical and critical actions are switched off. The user can allow them in CloudForge under Settings, MCP.',
        'TOOL_DISABLED',
      );
    }
    if (settings.tiers.critical === 'allow') return;
    const approved = await this.deps.approvals.request({
      client: state.clientName,
      tool: tool.name,
      title: toolTitle(tool.name),
      summary: describeCall(tool.description, input),
    });
    if (!approved) {
      throw new McpToolError(
        'The user did not approve this action in CloudForge, so it was not run.',
        'NOT_APPROVED',
      );
    }
  }

  private context(state: McpSessionState, streamId: string): McpCallContext {
    const { deps } = this;
    return {
      call: async <C extends IpcChannel>(
        channel: C,
        payload: IpcRequest<C>,
      ): Promise<IpcResponse<C>> => {
        const result = await deps.call(channel, payload);
        if (result.ok) return result.value;
        throw new McpToolError(result.error.message, result.error.code, result.error.context);
      },
      session: state,
      settings: () => deps.settings(),
      projectId: () => {
        const active = deps.activeProjectId();
        if (!active) throw new McpToolError('No project is open.', 'NO_PROJECT');
        return active;
      },
      streamId,
      emit: (channel, payload) => deps.emit(channel, payload),
      operations: this.operations,
      terminals: this.terminals,
      documentation: () => deps.documentation(),
      now: () => this.now(),
    };
  }
}

function waitTime(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WAIT_SECONDS;
  return Math.min(MAX_WAIT_SECONDS, Math.max(0, value));
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_NAMES.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function respond(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: message }));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    length += buffer.length;
    if (length > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}
