import { describe, expect, it } from 'vitest';
import type { AppInfo } from '@shared/ipc/contract.js';
import { formatDiagnostics } from './app-diagnostics.js';

const info: AppInfo = {
  name: 'CloudForge',
  version: '1.2.3',
  platform: 'win32',
  arch: 'x64',
  locale: 'en-US',
  packaged: true,
  build: { number: '20260714.42', commit: 'abcdef123456', builtAt: '2026-07-14T12:00:00.000Z' },
  os: { type: 'Windows_NT', release: '10.0.26100' },
  versions: { electron: '43.1.0', node: '24.0.0', chrome: '142.0.0' },
};

describe('formatDiagnostics', () => {
  it('formats reproducible runtime information without application state', () => {
    const result = formatDiagnostics(info);
    expect(result).toContain('CloudForge 1.2.3');
    expect(result).toContain('Build: 20260714.42');
    expect(result).toContain('OS: Windows_NT 10.0.26100 (win32)');
    expect(result).not.toContain('credential');
    expect(result).not.toContain('project');
  });
});
