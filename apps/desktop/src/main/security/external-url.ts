/** Only HTTPS pages may leave the sandboxed renderer for the operating-system browser. */
export function isSafeExternalUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
