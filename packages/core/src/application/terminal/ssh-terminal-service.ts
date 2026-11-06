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
  SshCommandResult,
  SshTerminalManager,
  SshTerminalSink,
  SshTerminalSize,
} from '../ports/ssh-terminal-manager.js';

export type SshTerminalServiceError = ValidationError | DeploymentError;

const DEFAULT_COMMAND_TIMEOUT_SECONDS = 60;
const MAX_COMMAND_TIMEOUT_SECONDS = 600;
const MAX_COMMAND_LENGTH = 65_536;
const MAX_COMMAND_OUTPUT_LENGTH = 200_000;

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

  /**
   * Run one command on a saved target and return its output and exit code. The
   * command text never reaches the activity feed: it can carry secrets.
   */
  async exec(
    targetId: string,
    command: string,
    timeoutSeconds: number = DEFAULT_COMMAND_TIMEOUT_SECONDS,
  ): Promise<Result<SshCommandResult, SshTerminalServiceError>> {
    if (!isUuid(targetId)) return err(new ValidationError('Select a valid saved VPS target'));
    if (!command.trim() || command.length > MAX_COMMAND_LENGTH)
      return err(new ValidationError('A command must be 1–65536 characters'));
    if (
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > MAX_COMMAND_TIMEOUT_SECONDS
    )
      return err(new ValidationError('The timeout must be 1–600 seconds'));
    const target = await this.targets.resolve(targetId);
    if (!target.ok) return target;
    const result = await this.terminal.exec(target.value, command, {
      timeoutMs: timeoutSeconds * 1000,
      maxOutputLength: MAX_COMMAND_OUTPUT_LENGTH,
    });
    if (result.ok) {
      this.activities.recordSafe({
        type: 'ssh.command.executed',
        message: 'Ran a command on a server over SSH',
        metadata: {
          targetId,
          exitCode: result.value.exitCode,
          timedOut: result.value.timedOut,
        },
      });
    }
    return result;
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
