import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { app } from 'electron';
import pino, { type Logger } from 'pino';

/**
 * Application logger.
 *
 * Writes structured JSON to `<userData>/logs/cloudforge.log` (everything, down to
 * trace) and a readable subset to stdout (info+). It is the single sink for:
 * app lifecycle, every IPC call and its outcome, streamed engine/deployment
 * output, forwarded renderer errors, and uncaught exceptions.
 *
 * Secrets are never logged — call sites log metadata and outcomes, never request
 * payloads or decrypted values.
 */
let logger: Logger | undefined;
let logFilePath = '';
let logDir = '';
let activeProjectId: string | null = null;
let activeProjectStream: ReturnType<typeof pino.destination> | null = null;
const MAX_ACTIVE_LOG_BYTES = 10 * 1024 * 1024;

/** Absolute path to the active project's isolated log directory. */
export function getLogDir(): string {
  const root = logDir || join(app.getPath('userData'), 'logs');
  return activeProjectId ? join(root, 'projects', activeProjectId) : root;
}

/** Absolute path to the active project's isolated log file. */
export function getLogFilePath(): string {
  return activeProjectId
    ? join(getLogDir(), 'cloudforge.log')
    : logFilePath || join(getLogDir(), 'cloudforge.log');
}

/**
 * Route subsequent application records into the selected project's private
 * log in addition to the device-level diagnostic log.
 */
export function setActiveLogProject(projectId: string | null): void {
  if (activeProjectId === projectId) return;
  try {
    activeProjectStream?.flushSync();
    activeProjectStream?.end();
  } catch {
    // Workspace switching must not fail because a diagnostic stream is busy.
  }
  activeProjectStream = null;
  activeProjectId = projectId;
  if (!projectId) return;

  const directory = getLogDir();
  mkdirSync(directory, { recursive: true });
  const path = getLogFilePath();
  rotatePath(path, directory);
  activeProjectStream = pino.destination({ dest: path, sync: false, mkdir: true });
}

/** Initialise the logger once, at startup. */
export function initLogger(): Logger {
  if (logger) return logger;

  logDir = join(app.getPath('userData'), 'logs');
  mkdirSync(logDir, { recursive: true });
  logFilePath = join(logDir, 'cloudforge.log');
  rotateActiveLog();

  const fileStream = pino.destination({ dest: logFilePath, sync: false, mkdir: true });
  const projectRouter = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      try {
        activeProjectStream?.write(chunk.toString('utf8'));
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });

  logger = pino(
    {
      level: process.env.CF_LOG_LEVEL ?? 'trace',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      serializers: { err: pino.stdSerializers.err },
    },
    pino.multistream([
      { level: 'trace', stream: fileStream }, // the file captures everything
      { level: 'trace', stream: projectRouter }, // workspace log is isolated
      { level: 'info', stream: process.stdout }, // console stays readable
    ]),
  );

  process.on('uncaughtException', (err) => {
    logger?.fatal({ err, event: 'process.uncaughtException' }, 'Uncaught exception');
  });
  process.on('unhandledRejection', (reason) => {
    logger?.error({ err: reason, event: 'process.unhandledRejection' }, 'Unhandled rejection');
  });
  app.on('will-quit', () => {
    try {
      fileStream.flushSync();
      activeProjectStream?.flushSync();
    } catch {
      // best effort on shutdown
    }
  });

  logger.info({ event: 'log.init', logFilePath }, 'Logging initialised');
  return logger;
}

function rotateActiveLog(): void {
  rotatePath(logFilePath, logDir);
}

function rotatePath(path: string, directory: string): void {
  try {
    if (!existsSync(path) || statSync(path).size < MAX_ACTIVE_LOG_BYTES) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    renameSync(path, join(directory, `cloudforge-${timestamp}.log`));
  } catch {
    // Logging must remain available even if rotation cannot be performed.
  }
}

/** Remove rotated logs older than the configured retention period. */
export function pruneLogs(retentionDays: number): number {
  const cutoff = Date.now() - Math.max(1, retentionDays) * 86_400_000;
  let removed = 0;
  try {
    for (const name of readdirSync(getLogDir())) {
      if (!/^cloudforge-.+\.log$/.test(name)) continue;
      const path = join(getLogDir(), name);
      if (statSync(path).mtimeMs >= cutoff) continue;
      unlinkSync(path);
      removed += 1;
    }
  } catch {
    // Retention cleanup is best-effort and must not prevent startup.
  }
  return removed;
}

/** The active logger (lazily initialised). */
export function log(): Logger {
  return logger ?? initLogger();
}

interface RawLine {
  time?: string;
  level?: string;
  msg?: string;
  event?: string;
  channel?: string;
  code?: string;
  err?: { message?: string };
}

/** Read and human-format the last `maxLines` lines of the log file. */
export function readLastLines(maxLines: number): string[] {
  try {
    const path = getLogFilePath();
    const size = statSync(path).size;
    const chunk = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(chunk);
    const fd = openSync(path, 'r');
    readSync(fd, buffer, 0, chunk, size - chunk);
    closeSync(fd);

    return buffer
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .slice(-maxLines)
      .map(formatLine);
  } catch {
    return [];
  }
}

function formatLine(line: string): string {
  try {
    const entry = JSON.parse(line) as RawLine;
    const time = entry.time ? new Date(entry.time).toLocaleTimeString() : '';
    const level = (entry.level ?? 'info').toUpperCase().padEnd(5);
    const parts = [entry.msg];
    if (entry.channel) parts.push(`channel=${entry.channel}`);
    if (entry.code) parts.push(`code=${entry.code}`);
    if (entry.err?.message) parts.push(`err="${entry.err.message}"`);
    return `${time} ${level} ${parts.filter(Boolean).join('  ')}`.trim();
  } catch {
    return line;
  }
}
