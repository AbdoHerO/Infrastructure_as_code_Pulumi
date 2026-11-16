import { targetsForServers, type ServerSelection, type ServerUsage } from '@cloudforge/core';
import { IpcCallError, invoke } from '../../lib/ipc.js';

/** A server that does not answer must not hold the dialog open for long. */
const CHECK_TIMEOUT_MS = 20_000;

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

async function check<T>(promise: Promise<T>): Promise<Checked<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('the server did not answer in time')),
      CHECK_TIMEOUT_MS,
    );
  });
  try {
    return { ok: true, value: await Promise.race([promise, timeout]) };
  } catch (error) {
    const reason =
      error instanceof IpcCallError || error instanceof Error ? error.message : String(error);
    return { ok: false, reason: reason.split('\n')[0] ?? reason };
  } finally {
    clearTimeout(timer);
  }
}

function names<T>(
  checked: Checked<readonly T[]>,
  label: string,
  unchecked: string[],
  pick: (item: T) => string | null,
): string[] {
  if (!checked.ok) {
    unchecked.push(`${label}: ${checked.reason}`);
    return [];
  }
  return checked.value.map(pick).filter((name): name is string => Boolean(name));
}

/**
 * What runs on the servers a change would touch: containers and Nginx sites read
 * from the servers over SSH, pipelines, Docker stacks and WordPress sites from
 * CloudForge's own records. Read only; a failed check is reported, not hidden.
 */
export async function inspectServerUsage(selection: ServerSelection): Promise<ServerUsage[]> {
  const targets = targetsForServers(await invoke('ansible:targets', undefined), selection);
  if (targets.length === 0) return [];
  const [pipelines, stacks, wordpress] = await Promise.all([
    check(invoke('jenkins:list', undefined)),
    check(invoke('stacks:list', undefined)),
    check(invoke('wordpress:list', undefined)),
  ]);
  return Promise.all(
    targets.map(async (target): Promise<ServerUsage> => {
      const [containers, sites] = await Promise.all([
        check(invoke('containers:list', { targetId: target.id })),
        check(invoke('nginx:listSites', { targetId: target.id })),
      ]);
      const unchecked: string[] = [];
      const on = <T extends { targetId: string }>(records: Checked<readonly T[]>): Checked<T[]> =>
        records.ok
          ? { ok: true, value: records.value.filter((record) => record.targetId === target.id) }
          : records;
      return {
        targetName: target.name,
        host: target.host,
        containers: names(containers, 'containers', unchecked, (c) =>
          c.state === 'running' ? c.name : `${c.name} (${c.state})`,
        ),
        sites: names(sites, 'Nginx sites', unchecked, (site) => site.domain),
        stacks: names(on(stacks), 'Docker stacks', unchecked, (stack) => stack.name),
        wordpress: names(on(wordpress), 'WordPress sites', unchecked, (site) => site.domain),
        pipelines: names(on(pipelines), 'pipelines', unchecked, (pipeline) => pipeline.name),
        unchecked,
      };
    }),
  );
}
