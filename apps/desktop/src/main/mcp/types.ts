import { z } from 'zod/v4';
import type {
  IpcChannel,
  IpcEventChannel,
  IpcEventPayload,
  IpcRequest,
  IpcResponse,
} from '../../shared/ipc/contract.js';
import type { McpSettings, McpTier } from '../../shared/mcp/types.js';
import { worksWithoutProjectSession } from '../ipc/session-policy.js';
import type { OperationManager } from './operations.js';
import type { TerminalBuffers } from './terminal-buffers.js';

/** What one connected MCP client has established so far. */
export interface McpSessionState {
  sessionId: string;
  clientName: string;
  /** The project this client has been working on; a change must be acknowledged. */
  pinnedProjectId: string | null;
  /** Fingerprints this client got from the server itself, by `host:port`. */
  readonly inspectedHostKeys: Map<string, { fingerprint: string; at: number }>;
}

export interface McpDocumentationArticle {
  readonly id: string;
  readonly file: string;
  readonly title: string;
  readonly summary: string;
  readonly category: string;
  readonly content: string;
}

/** Everything a tool may use. It reaches the application only through `call`. */
export interface McpCallContext {
  /** Run an IPC channel; a failure throws the application's own error. */
  call<C extends IpcChannel>(channel: C, payload: IpcRequest<C>): Promise<IpcResponse<C>>;
  readonly session: McpSessionState;
  settings(): McpSettings;
  /** The open project's id; throws when none is open. */
  projectId(): string;
  /** Unique per tool call, for channels that stream progress. */
  readonly streamId: string;
  emit<C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>): void;
  readonly operations: OperationManager;
  readonly terminals: TerminalBuffers;
  documentation(): readonly McpDocumentationArticle[];
  now(): number;
}

export interface McpToolOperation {
  /** Where its progress lines arrive, when it streams any. */
  readonly logChannel: IpcEventChannel | null;
  /** The channel that stops it, when it can be stopped. */
  readonly cancelChannel?: 'deploy:cancel' | 'ansible:cancel';
}

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly toolset: string;
  readonly tier: McpTier;
  readonly input: z.ZodObject<z.ZodRawShape>;
  readonly channels: readonly IpcChannel[];
  /** False when the tool also works with no project open. */
  readonly needsProject: boolean;
  readonly operation: McpToolOperation | null;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  /** True when it reaches a server, a cloud account or another outside system. */
  readonly openWorld: boolean;
  /** Only listed when the client may open and switch projects. */
  readonly needsProjectSwitch: boolean;
  /** Treat this particular call as critical whatever the tool's tier. */
  escalate(input: unknown): boolean;
  run(input: unknown, context: McpCallContext): Promise<unknown>;
}

export interface McpToolOptions<Output> {
  readonly operation?: McpToolOperation;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
  /** Defaults to true: nearly every tool reaches a server or a cloud account. */
  readonly openWorld?: boolean;
  readonly needsProject?: boolean;
  readonly needsProjectSwitch?: boolean;
  readonly escalate?: (input: Output) => boolean;
}

/** Inputs with optional fields made safe for `exactOptionalPropertyTypes`. */
type Compact<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Drop the keys that are `undefined`, as the IPC contract's optional fields expect. */
export function compact<T extends object>(value: T): Compact<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Compact<T>;
}

function defineTool<Shape extends z.ZodRawShape>(
  toolset: string,
  name: string,
  channels: readonly IpcChannel[],
  tier: McpTier,
  description: string,
  shape: Shape,
  run: (input: z.output<z.ZodObject<Shape>>, context: McpCallContext) => Promise<unknown>,
  options: McpToolOptions<z.output<z.ZodObject<Shape>>>,
): McpTool {
  const schema = z.object(shape);
  type Input = z.output<typeof schema>;
  const destructive = options.destructive ?? tier === 'critical';
  return {
    name,
    description,
    toolset,
    tier,
    input: schema,
    channels,
    needsProject: options.needsProject ?? !channels.every(worksWithoutProjectSession),
    operation: options.operation ?? null,
    destructive,
    idempotent: options.idempotent ?? tier === 'read',
    openWorld: options.openWorld ?? true,
    needsProjectSwitch: options.needsProjectSwitch ?? false,
    escalate: (input) => options.escalate?.(input as Input) ?? false,
    run: (input, context) => run(input as Input, context),
  };
}

export interface ToolsetBuilder {
  /** A tool that is one IPC channel. */
  call<C extends IpcChannel, Shape extends z.ZodRawShape>(
    name: string,
    channel: C,
    tier: McpTier,
    description: string,
    shape: Shape,
    payload: (
      input: z.output<z.ZodObject<Shape>>,
      context: McpCallContext,
    ) => IpcRequest<C> | Promise<IpcRequest<C>>,
    options?: McpToolOptions<z.output<z.ZodObject<Shape>>>,
  ): McpTool;
  /** A tool that combines channels or shapes the result. */
  custom<Shape extends z.ZodRawShape>(
    name: string,
    channels: readonly IpcChannel[],
    tier: McpTier,
    description: string,
    shape: Shape,
    run: (input: z.output<z.ZodObject<Shape>>, context: McpCallContext) => Promise<unknown>,
    options?: McpToolOptions<z.output<z.ZodObject<Shape>>>,
  ): McpTool;
}

/** Tools of one toolset. Every tool in the catalogue is made here. */
export function toolset(id: string): ToolsetBuilder {
  return {
    call: (name, channel, tier, description, shape, payload, options = {}) =>
      defineTool(
        id,
        name,
        [channel],
        tier,
        description,
        shape,
        async (input, context) => context.call(channel, await payload(input, context)),
        options,
      ),
    custom: (name, channels, tier, description, shape, run, options = {}) =>
      defineTool(id, name, channels, tier, description, shape, run, options),
  };
}

/** Thrown when a tool refuses a request; the message goes back to the client. */
export class McpToolError extends Error {
  constructor(
    message: string,
    readonly code = 'MCP_REFUSED',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}
