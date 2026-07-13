import { closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

/** Absolute path to the log directory (safe to call before init). */
export function getLogDir(): string {
  return logDir || join(app.getPath('userData'), 'logs');
}

/** Absolute path to the log file (safe to call before init). */
export function getLogFilePath(): string {
  return logFilePath || join(getLogDir(), 'cloudforge.log');
}

/** Initialise the logger once, at startup. */
export function initLogger(): Logger {
  if (logger) return logger;

  logDir = join(app.getPath('userData'), 'logs');
  mkdirSync(logDir, { recursive: true });
  logFilePath = join(logDir, 'cloudforge.log');

  const fileStream = pino.destination({ dest: logFilePath, sync: false, mkdir: true });

  logger = pino(
    {
      level: process.env.CF_LOG_LEVEL ?? 'trace',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      serializers: { err: pino.stdSerializers.err },
    },
    pino.multistream([
      { level: 'trace', stream: fileStream }, // the file captures everything
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
    } catch {
      // best effort on shutdown
    }
  });

  logger.info({ event: 'log.init', logFilePath }, 'Logging initialised');
  return logger;
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
