import { describe, expect, it, vi } from 'vitest';
import { enforceOwnerOnlyPath, removeOwnerOnlyTree } from './owner-only-file.js';

describe('enforceOwnerOnlyPath', () => {
  it('replaces inherited Windows ACLs with the current user only', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'WORKSTATION\\alice\r\n' })
      .mockResolvedValueOnce({ stdout: 'processed file' });
    const chmod = vi.fn();

    await enforceOwnerOnlyPath('C:\\keys\\cloudforge-key', 0o600, {
      platform: 'win32',
      run,
      chmod,
    });

    expect(run).toHaveBeenNthCalledWith(1, 'whoami.exe', []);
    expect(run).toHaveBeenNthCalledWith(2, 'icacls.exe', ['C:\\keys\\cloudforge-key', '/reset']);
    expect(run).toHaveBeenNthCalledWith(3, 'icacls.exe', [
      'C:\\keys\\cloudforge-key',
      '/inheritance:r',
      '/grant:r',
      'WORKSTATION\\alice:(F)',
    ]);
    expect(chmod).not.toHaveBeenCalled();
  });

  it('fails closed when Windows cannot apply the owner-only ACL', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'WORKSTATION\\alice\n' })
      .mockRejectedValueOnce(new Error('access denied'));

    await expect(
      enforceOwnerOnlyPath('C:\\keys\\cloudforge-key', 0o600, {
        platform: 'win32',
        run,
        chmod: vi.fn(),
      }),
    ).rejects.toThrow('access denied');
  });

  it('makes directory owner grants inheritable', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: 'WORKSTATION\\alice\n' });

    await enforceOwnerOnlyPath(
      'C:\\keys',
      0o700,
      { platform: 'win32', run, chmod: vi.fn() },
      'directory',
    );

    expect(run).toHaveBeenLastCalledWith('icacls.exe', [
      'C:\\keys',
      '/inheritance:r',
      '/grant:r',
      'WORKSTATION\\alice:(OI)(CI)(F)',
    ]);
  });

  it('repairs a stale Windows tree ACL and retries deletion', async () => {
    const permissionError = Object.assign(new Error('access denied'), { code: 'EPERM' });
    const removeTree = vi
      .fn()
      .mockRejectedValueOnce(permissionError)
      .mockResolvedValueOnce(undefined);
    const run = vi.fn().mockResolvedValue({ stdout: 'WORKSTATION\\alice\n' });

    await removeOwnerOnlyTree('C:\\runtime-keys', {
      platform: 'win32',
      run,
      chmod: vi.fn(),
      removeTree,
    });

    expect(removeTree).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(2, 'icacls.exe', [
      'C:\\runtime-keys',
      '/reset',
      '/T',
      '/C',
    ]);
    expect(run).toHaveBeenNthCalledWith(3, 'icacls.exe', [
      'C:\\runtime-keys',
      '/grant:r',
      'WORKSTATION\\alice:(F)',
      '/T',
      '/C',
    ]);
  });

  it('uses POSIX owner-only modes outside Windows', async () => {
    const chmod = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn();

    await enforceOwnerOnlyPath('/tmp/cloudforge-key', 0o600, {
      platform: 'linux',
      run,
      chmod,
    });

    expect(chmod).toHaveBeenCalledWith('/tmp/cloudforge-key', 0o600);
    expect(run).not.toHaveBeenCalled();
  });
});
