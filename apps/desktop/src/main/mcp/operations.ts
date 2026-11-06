import type { IpcEventChannel, IpcEventPayload } from '../../shared/ipc/contract.js';

/** Follow an event channel; returns the function that stops following it. */
export type EventSubscriber = <C extends IpcEventChannel>(
  channel: C,
  listener: (payload: IpcEventPayload<C>) => void,
) => () => void;

export type McpOperationStatus = 'running' | 'succeeded' | 'failed';

export interface McpOperationView {
  readonly operationId: string;
  readonly tool: string;
  readonly client: string;
  readonly status: McpOperationStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly cancellable: boolean;
  readonly logLines: number;
  /** Set once it has finished successfully. */
  readonly result?: unknown;
  /** Set once it has failed. */
  readonly error?: { readonly code: string; readonly message: string };
}

interface Operation {
  readonly id: string;
  readonly tool: string;
  readonly client: string;
  readonly startedAt: number;
  readonly lines: string[];
  /** How many lines scrolled out of the buffer, so cursors stay valid. */
  dropped: number;
  finishedAt: number | null;
  status: McpOperationStatus;
  result?: unknown;
  error?: { readonly code: string; readonly message: string };
  readonly done: Promise<void>;
  readonly cancel: (() => Promise<void>) | null;
}

export interface StartOperationInput {
  readonly id: string;
  readonly tool: string;
  readonly client: string;
  readonly logChannel: IpcEventChannel | null;
  readonly cancel: (() => Promise<void>) | null;
  readonly run: () => Promise<unknown>;
  readonly onLog?: (line: string) => void;
  readonly onFinished?: (operation: McpOperationView) => void;
}

const MAX_LOG_LINES = 2000;
const MAX_FINISHED_OPERATIONS = 50;
const FINISHED_TTL_MS = 60 * 60_000;

/**
 * Work that outlives a single tool call.
 *
 * A Pulumi apply can take many minutes and most MCP clients give up on a tool call
 * long before that, so a slow tool starts an operation, waits a while, and answers
 * with an id the client can come back with. The operation carries on regardless of
 * what the client does, exactly as it does if the user leaves the page.
 */
export class OperationManager {
  private readonly operations = new Map<string, Operation>();

  constructor(
    private readonly subscribe: EventSubscriber,
    private readonly now: () => number = Date.now,
  ) {}

  start(input: StartOperationInput): McpOperationView {
    this.prune();
    let finish = (): void => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const operation: Operation = {
      id: input.id,
      tool: input.tool,
      client: input.client,
      startedAt: this.now(),
      lines: [],
      dropped: 0,
      finishedAt: null,
      status: 'running',
      done,
      cancel: input.cancel,
    };
    this.operations.set(input.id, operation);

    const stopFollowing = input.logChannel
      ? this.subscribe(input.logChannel, (payload) => {
          const line = logLine(payload, input.id);
          if (line === null) return;
          this.append(operation, line);
          input.onLog?.(line);
        })
      : (): void => undefined;

    void input
      .run()
      .then(
        (result) => {
          operation.status = 'succeeded';
          operation.result = result;
        },
        (error: unknown) => {
          operation.status = 'failed';
          operation.error = describeError(error);
        },
      )
      .finally(() => {
        operation.finishedAt = this.now();
        stopFollowing();
        finish();
        input.onFinished?.(this.view(operation));
      });
    return this.view(operation);
  }

  /** The operation once it finishes, or as it stands after `waitMs`. */
  async wait(id: string, waitMs: number): Promise<McpOperationView | null> {
    const operation = this.operations.get(id);
    if (!operation) return null;
    if (operation.status === 'running' && waitMs > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        operation.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    return this.view(operation);
  }

  get(id: string): McpOperationView | null {
    const operation = this.operations.get(id);
    return operation ? this.view(operation) : null;
  }

  list(): McpOperationView[] {
    this.prune();
    return [...this.operations.values()].reverse().map((operation) => this.view(operation));
  }

  /** Log lines from a cursor. Keep passing `nextCursor` to follow a running operation. */
  logs(
    id: string,
    cursor = 0,
    limit = 500,
  ): { lines: string[]; nextCursor: number; missedLines: number } | null {
    const operation = this.operations.get(id);
    if (!operation) return null;
    const missedLines = Math.max(0, operation.dropped - cursor);
    const start = Math.max(0, cursor - operation.dropped);
    const lines = operation.lines.slice(start, start + limit);
    return { lines, nextCursor: operation.dropped + start + lines.length, missedLines };
  }

  tail(id: string, count: number): string[] {
    return this.operations.get(id)?.lines.slice(-count) ?? [];
  }

  /** Ask it to stop. Answers honestly when this kind of work cannot be stopped. */
  async cancel(id: string): Promise<{ cancelled: boolean; message: string }> {
    const operation = this.operations.get(id);
    if (!operation) return { cancelled: false, message: 'No such operation' };
    if (operation.status !== 'running') {
      return { cancelled: false, message: `The operation already ${operation.status}` };
    }
    if (!operation.cancel) {
      return {
        cancelled: false,
        message: 'This kind of operation cannot be stopped once it has started',
      };
    }
    await operation.cancel();
    return {
      cancelled: true,
      message: 'Asked it to stop. Steps already completed are not rolled back.',
    };
  }

  private append(operation: Operation, line: string): void {
    operation.lines.push(line);
    if (operation.lines.length > MAX_LOG_LINES) {
      operation.lines.shift();
      operation.dropped += 1;
    }
  }

  private view(operation: Operation): McpOperationView {
    return {
      operationId: operation.id,
      tool: operation.tool,
      client: operation.client,
      status: operation.status,
      startedAt: new Date(operation.startedAt).toISOString(),
      finishedAt:
        operation.finishedAt === null ? null : new Date(operation.finishedAt).toISOString(),
      cancellable: operation.cancel !== null,
      logLines: operation.dropped + operation.lines.length,
      ...(operation.status === 'succeeded' ? { result: operation.result } : {}),
      ...(operation.error ? { error: operation.error } : {}),
    };
  }

  private prune(): void {
    const finished = [...this.operations.values()].filter((item) => item.finishedAt !== null);
    const expired = finished.filter(
      (item, index) =>
        this.now() - (item.finishedAt ?? 0) > FINISHED_TTL_MS ||
        index < finished.length - MAX_FINISHED_OPERATIONS,
    );
    for (const item of expired) this.operations.delete(item.id);
  }
}

function logLine(payload: unknown, streamId: string): string | null {
  const event = payload as {
    readonly streamId?: unknown;
    readonly event?: { readonly stream?: unknown; readonly message?: unknown };
  };
  if (event.streamId !== streamId || typeof event.event?.message !== 'string') return null;
  const text = event.event.message.trimEnd();
  if (!text) return null;
  const stream = event.event.stream;
  return `${stream === 'stderr' || stream === 'error' ? '! ' : stream === 'step' ? '▶ ' : ''}${text}`;
}

function describeError(error: unknown): { code: string; message: string } {
  const record = error as { readonly code?: unknown; readonly message?: unknown };
  return {
    code: typeof record?.code === 'string' ? record.code : 'ERROR',
    message: typeof record?.message === 'string' ? record.message : String(error),
  };
}
