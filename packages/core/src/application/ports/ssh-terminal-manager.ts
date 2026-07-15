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
}
