import { isAbsolute, normalize, win32 } from 'node:path';
import { ValidationError } from '@cloudforge/shared';

/**
 * Check a file path that came from an API call rather than a native dialog.
 *
 * A dialog proves a person pointed at the place. A path string proves nothing, so
 * it must at least be a complete path on this computer: a relative one would
 * depend on the working directory, and a network share (`\\server\share`) would
 * send secrets off this machine.
 */
export function requireLocalPath(path: string): string {
  if (typeof path !== 'string' || path.trim() === '' || path.includes('\0')) {
    throw new ValidationError('A file path is required');
  }
  if (!isAbsolute(path) && !win32.isAbsolute(path)) {
    throw new ValidationError(`Use a complete path, not a relative one: ${path}`);
  }
  if (path.startsWith('\\\\') || path.startsWith('//')) {
    throw new ValidationError(`Network paths are not accepted: ${path}`);
  }
  return normalize(path);
}
