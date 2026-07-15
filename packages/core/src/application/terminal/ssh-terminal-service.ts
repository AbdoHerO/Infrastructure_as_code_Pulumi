import {
  err,
  isUuid,
  ok,
  type DeploymentError,
  type Result,
  ValidationError,
} from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type { RemoteTargetResolver } from '../ports/remote-target-resolver.js';
import type {
  SshTerminalManager,
  SshTerminalSink,
  SshTerminalSize,
} from '../ports/ssh-terminal-manager.js';

export type SshTerminalServiceError = ValidationError | DeploymentError;

/** Opens interactive shells only through saved, fingerprint-verified VPS targets. */
export class SshTerminalService {
  constructor(
    private readonly targets: RemoteTargetResolver,
    private readonly terminal: SshTerminalManager,
    private readonly activities: ActivityService,
  ) {}

  async open(
    targetId: string,
    sessionId: string,
    size: SshTerminalSize,
    sink: SshTerminalSink,
  ): Promise<Result<void, SshTerminalServiceError>> {
    const validation = validateRequest(targetId, sessionId, size);
    if (!validation.ok) return validation;
    const target = await this.targets.resolve(targetId);
    if (!target.ok) return target;
    const opened = await this.terminal.open(sessionId, target.value, size, sink);
    if (opened.ok) {
      this.activities.recordSafe({
        type: 'ssh.terminal.opened',
        message: 'Opened an interactive SSH terminal',
        metadata: { targetId },
      });
    }
    return opened;
  }

  write(sessionId: string, data: string): Result<void, SshTerminalServiceError> {
    if (!isUuid(sessionId)) return err(new ValidationError('Invalid terminal session'));
    if (!data || data.length > 65_536)
      return err(new ValidationError('Terminal input must be 1–65536 characters'));
    return this.terminal.write(sessionId, data);
  }

  resize(sessionId: string, size: SshTerminalSize): Result<void, SshTerminalServiceError> {
    if (!isUuid(sessionId) || !validSize(size))
      return err(new ValidationError('Invalid terminal resize request'));
    return this.terminal.resize(sessionId, size);
  }

  close(sessionId: string): Result<void, ValidationError> {
    if (!isUuid(sessionId)) return err(new ValidationError('Invalid terminal session'));
    this.terminal.close(sessionId);
    this.activities.recordSafe({
      type: 'ssh.terminal.closed',
      message: 'Closed an interactive SSH terminal',
      metadata: { sessionId },
    });
    return ok(undefined);
  }

  closeAll(): void {
    this.terminal.closeAll();
  }
}

function validateRequest(
  targetId: string,
  sessionId: string,
  size: SshTerminalSize,
): Result<void, ValidationError> {
  if (!isUuid(targetId)) return err(new ValidationError('Select a valid saved VPS target'));
  if (!isUuid(sessionId)) return err(new ValidationError('Invalid terminal session'));
  if (!validSize(size)) return err(new ValidationError('Invalid terminal dimensions'));
  return ok(undefined);
}

function validSize(size: SshTerminalSize): boolean {
  return (
    Number.isInteger(size.columns) &&
    size.columns >= 20 &&
    size.columns <= 500 &&
    Number.isInteger(size.rows) &&
    size.rows >= 5 &&
    size.rows <= 300
  );
}
