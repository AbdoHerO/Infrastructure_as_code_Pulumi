import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// Relative rather than the `@shared` alias: that alias is provided by
// electron-vite/tsconfig paths, which vitest does not load for this package.
import { IPC_CHANNELS, IPC_EVENT_CHANNELS } from '../../shared/ipc/contract.js';

// Resolve from this file, not the working directory: the suite runs both from
// the package (`pnpm test`) and from the repository root (`pnpm test:coverage`).
const mainRoot = fileURLToPath(new URL('../', import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /(?<!\.test)\.ts$/.test(entry) ? [path] : [];
  });
}

/** Collect the string-literal argument of every call to `name` across the main process. */
function calledChannels(name: string): string[] {
  const pattern = new RegExp(`\\b${name}\\(\\s*'([^']+)'`, 'g');
  return sourceFiles(mainRoot).flatMap((path) => {
    const source = readFileSync(path, 'utf8');
    return [...source.matchAll(pattern)].map((match) => match[1]!);
  });
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

/**
 * The typed contract keeps the three processes in lock-step at compile time, and
 * `contract.ts` carries compile-time guards proving each runtime list covers its
 * contract. These tests close the remaining gap: that every declared channel is
 * actually served, and that nothing is served or emitted which was never
 * declared. Registration is what the renderer ultimately depends on.
 */
describe('IPC contract', () => {
  it('declares every channel exactly once', () => {
    expect(duplicates(IPC_CHANNELS)).toEqual([]);
    expect(duplicates(IPC_EVENT_CHANNELS)).toEqual([]);
  });

  it('registers a main-process handler for every declared channel', () => {
    const registered = new Set(calledChannels('registerHandler'));
    const unhandled = IPC_CHANNELS.filter((channel) => !registered.has(channel));

    expect(unhandled, 'channels declared in IpcContract with no registerHandler call').toEqual([]);
  });

  it('registers no handler for an undeclared channel', () => {
    const declared = new Set<string>(IPC_CHANNELS);
    const undeclared = [...new Set(calledChannels('registerHandler'))].filter(
      (channel) => !declared.has(channel),
    );

    expect(undeclared, 'registerHandler calls whose channel is missing from IPC_CHANNELS').toEqual(
      [],
    );
  });

  it('registers each channel only once', () => {
    expect(duplicates(calledChannels('registerHandler'))).toEqual([]);
  });

  it('emits only event channels on the preload allow-list', () => {
    const allowed = new Set<string>(IPC_EVENT_CHANNELS);
    const blocked = [...new Set(calledChannels('emitEvent'))].filter(
      (channel) => !allowed.has(channel),
    );

    // The preload rejects unknown channels at runtime, so an omission here is a
    // "Unknown event channel" throw in the renderer rather than a build failure.
    expect(blocked, 'emitEvent calls whose channel is missing from IPC_EVENT_CHANNELS').toEqual([]);
  });
});
