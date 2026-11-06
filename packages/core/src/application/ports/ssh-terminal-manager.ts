import type { DeploymentError, Result } from '@cloudforge/shared';
import type { DeploymentTarget } from './deployer.js';

export interface SshTerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export interface SshTerminalSink {
  readonly onData: (data: string) => void;
  readonly onClosed: (reason?: string) => void;
}

export interface SshCommandOptions {
  readonly timeoutMs: number;
  /** Output beyond this many characters per stream is dropped and reported. */
  readonly maxOutputLength: number;
}

export interface SshCommandResult {
  /** Null when the command was cut off by the timeout. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

/** Infrastructure port for an interactive, verified SSH shell session. */
export interface SshTerminalManager {
  open(
    sessionId: string,
    target: DeploymentTarget,
    size: SshTerminalSize,
    sink: SshTerminalSink,
  ): Promise<Result<void, DeploymentError>>;
  write(sessionId: string, data: string): Result<void, DeploymentError>;
  resize(sessionId: string, size: SshTerminalSize): Result<void, DeploymentError>;
  close(sessionId: string): void;
  closeAll(): void;
  /** Run one command without a terminal, on its own short-lived connection. */
  exec(
    target: DeploymentTarget,
    command: string,
    options: SshCommandOptions,
  ): Promise<Result<SshCommandResult, DeploymentError>>;
}
