import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { DeploymentError, err, ok, type Result } from '@cloudforge/shared';
import type {
  DeploymentTarget,
  SshTerminalManager,
  SshTerminalSink,
  SshTerminalSize,
} from '@cloudforge/core';
import { sshConnectionConfig } from './ssh-transport.js';

const CONNECT_TIMEOUT_MS = 30_000;

interface Session {
  readonly client: Client;
  readonly stream: ClientChannel;
  readonly sink: SshTerminalSink;
  closed: boolean;
}

/** ssh2 adapter for long-lived PTY sessions. Raw terminal data is never logged. */
export class NodeSshTerminalManager implements SshTerminalManager {
  private readonly sessions = new Map<string, Session>();

  open(
    sessionId: string,
    target: DeploymentTarget,
    size: SshTerminalSize,
    sink: SshTerminalSink,
  ): Promise<Result<void, DeploymentError>> {
    this.close(sessionId);
    return new Promise((resolve) => {
      const client = new Client();
      let settled = false;
      const finish = (result: Result<void, DeploymentError>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const fail = (message: string, cause?: unknown): void => {
        client.end();
        finish(err(new DeploymentError(message, cause ? { cause } : undefined)));
      };
      const timer = setTimeout(
        () => fail('Timed out while opening the SSH terminal'),
        CONNECT_TIMEOUT_MS,
      );
      let config: ConnectConfig;
      try {
        config = sshConnectionConfig(target, CONNECT_TIMEOUT_MS);
      } catch (cause) {
        return fail('Invalid SSH target', cause);
      }
      client.once('error', (cause) => {
        if (!settled) fail('SSH terminal connection failed', cause);
        else this.endSession(sessionId, 'SSH connection lost');
      });
      client.once('ready', () => {
        client.shell(
          { term: 'xterm-256color', cols: size.columns, rows: size.rows },
          (error, stream) => {
            if (error) return fail('Could not start the remote shell', error);
            const session: Session = { client, stream, sink, closed: false };
            this.sessions.set(sessionId, session);
            stream.setEncoding('utf8');
            stream.on('data', (data: string) => sink.onData(data));
            stream.stderr.setEncoding('utf8');
            stream.stderr.on('data', (data: string) => sink.onData(data));
            stream.once('close', () => this.endSession(sessionId));
            finish(ok(undefined));
          },
        );
      });
      client.connect(config);
    });
  }

  write(sessionId: string, data: string): Result<void, DeploymentError> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed)
      return err(new DeploymentError('The SSH terminal is not connected'));
    session.stream.write(data);
    return ok(undefined);
  }

  resize(sessionId: string, size: SshTerminalSize): Result<void, DeploymentError> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed)
      return err(new DeploymentError('The SSH terminal is not connected'));
    session.stream.setWindow(size.rows, size.columns, 0, 0);
    return ok(undefined);
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.stream.end('exit\n');
    this.endSession(sessionId);
  }

  closeAll(): void {
    for (const sessionId of [...this.sessions.keys()]) this.close(sessionId);
  }

  private endSession(sessionId: string, reason?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;
    session.closed = true;
    this.sessions.delete(sessionId);
    session.client.end();
    session.sink.onClosed(reason);
  }
}
