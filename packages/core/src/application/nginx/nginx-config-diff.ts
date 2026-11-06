export interface NginxConfigLineChange {
  readonly line: number;
  readonly before: string | null;
  readonly after: string | null;
}

/** Line positions that differ, compared position by position. */
export function nginxConfigChanges(before: string, after: string): NginxConfigLineChange[] {
  const left = before.split('\n');
  const right = after.split('\n');
  const changes: NginxConfigLineChange[] = [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === right[index]) continue;
    changes.push({ line: index + 1, before: left[index] ?? null, after: right[index] ?? null });
  }
  return changes;
}

/** How many line positions differ between two versions of a config. */
export function changedLineCount(before: string, after: string): number {
  return nginxConfigChanges(before, after).length;
}
