import { randomUUID } from 'node:crypto';
import type { McpApprovalRequest } from '../../shared/mcp/types.js';

interface Pending {
  readonly request: McpApprovalRequest;
  readonly decide: (approved: boolean) => void;
}

export interface McpApprovalsOptions {
  timeoutSeconds(): number;
  /** The waiting list changed; the window shows whatever is first in it. */
  onChanged(pending: readonly McpApprovalRequest[]): void;
  now?(): number;
}

/**
 * Critical calls waiting for a person.
 *
 * Decisions only arrive through `mcp:resolveApproval`, which no MCP tool can reach,
 * so a client cannot approve its own request. Silence counts as a refusal.
 */
export class McpApprovals {
  private readonly waiting = new Map<string, Pending>();

  constructor(private readonly options: McpApprovalsOptions) {}

  request(input: {
    readonly client: string;
    readonly tool: string;
    readonly title: string;
    readonly summary: string;
  }): Promise<boolean> {
    const now = this.options.now?.() ?? Date.now();
    const timeoutMs = this.options.timeoutSeconds() * 1000;
    const request: McpApprovalRequest = {
      id: randomUUID(),
      ...input,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + timeoutMs).toISOString(),
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.resolve(request.id, false), timeoutMs);
      this.waiting.set(request.id, {
        request,
        decide: (approved) => {
          clearTimeout(timer);
          resolve(approved);
        },
      });
      this.options.onChanged(this.pending());
    });
  }

  resolve(id: string, approved: boolean): void {
    const pending = this.waiting.get(id);
    if (!pending) return;
    this.waiting.delete(id);
    pending.decide(approved);
    this.options.onChanged(this.pending());
  }

  pending(): McpApprovalRequest[] {
    return [...this.waiting.values()].map((item) => item.request);
  }

  /** Refuse everything still waiting, when the server stops. */
  refuseAll(): void {
    for (const id of [...this.waiting.keys()]) this.resolve(id, false);
  }
}
