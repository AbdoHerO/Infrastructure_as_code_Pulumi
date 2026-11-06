import type { EventSubscriber } from './operations.js';

interface Buffered {
  text: string;
  /** Characters scrolled out of `text`, so cursors stay valid. */
  dropped: number;
  closed: boolean;
  closedReason: string | null;
  stop: () => void;
}

const MAX_BUFFER_LENGTH = 500_000;

/** Keeps what each MCP-opened terminal printed until the client reads it. */
export class TerminalBuffers {
  private readonly sessions = new Map<string, Buffered>();

  constructor(private readonly subscribe: EventSubscriber) {}

  track(sessionId: string): void {
    const session: Buffered = {
      text: '',
      dropped: 0,
      closed: false,
      closedReason: null,
      stop: () => undefined,
    };
    const stopData = this.subscribe('terminal:data', (payload) => {
      if (payload.sessionId !== sessionId) return;
      session.text += payload.data;
      if (session.text.length > MAX_BUFFER_LENGTH) {
        const extra = session.text.length - MAX_BUFFER_LENGTH;
        session.text = session.text.slice(extra);
        session.dropped += extra;
      }
    });
    const stopClosed = this.subscribe('terminal:closed', (payload) => {
      if (payload.sessionId !== sessionId) return;
      session.closed = true;
      session.closedReason = payload.reason ?? null;
    });
    session.stop = () => {
      stopData();
      stopClosed();
    };
    this.sessions.set(sessionId, session);
  }

  read(
    sessionId: string,
    cursor = 0,
  ): { output: string; nextCursor: number; closed: boolean; closedReason: string | null } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const start = Math.max(0, cursor - session.dropped);
    return {
      output: session.text.slice(start),
      nextCursor: session.dropped + session.text.length,
      closed: session.closed,
      closedReason: session.closedReason,
    };
  }

  forget(sessionId: string): void {
    this.sessions.get(sessionId)?.stop();
    this.sessions.delete(sessionId);
  }
}
