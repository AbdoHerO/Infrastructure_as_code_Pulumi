/**
 * What already runs on the servers an infrastructure change would touch.
 *
 * Applying a plan, or destroying it, can wipe a server that hosts live sites.
 * Before that, the Infrastructure page lists what CloudForge knows runs there,
 * so a click in the wrong project cannot take everything down unnoticed.
 */

/** The fields of a saved VPS target that tie it to a server of a stack. */
export interface ServerTargetLink {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly managedProjectId: string | null;
  readonly managedResourceName: string | null;
}

export interface ServerSelection {
  /**
   * The project whose servers these are: its id, or a test on the project id a
   * target was linked to (a stack whose project record is gone has no id left).
   */
  readonly project: string | ((managedProjectId: string) => boolean);
  /** Servers of the plan the change touches; `'all'` for a destroy. */
  readonly servers: readonly string[] | 'all';
  /** Public addresses of the stack's servers, by server name, from its outputs. */
  readonly addresses: Readonly<Record<string, string>>;
}

/**
 * The saved targets that point at the selected servers: those CloudForge linked
 * to the stack when it created them, and those added by hand with the same address.
 */
export function targetsForServers<Target extends ServerTargetLink>(
  targets: readonly Target[],
  selection: ServerSelection,
): Target[] {
  const selected = (name: string): boolean =>
    selection.servers === 'all' || selection.servers.includes(name);
  const project = selection.project;
  const ownedBy = (id: string | null): boolean =>
    id !== null && (typeof project === 'string' ? id === project : project(id));
  const hosts = new Set(
    Object.entries(selection.addresses)
      .filter(([name]) => selected(name))
      .map(([, host]) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  return targets.filter(
    (target) =>
      (ownedBy(target.managedProjectId) &&
        (target.managedResourceName === null || selected(target.managedResourceName))) ||
      hosts.has(target.host.trim().toLowerCase()),
  );
}

/** What one server runs, as far as CloudForge could tell. */
export interface ServerUsage {
  readonly targetName: string;
  readonly host: string;
  readonly containers: readonly string[];
  readonly sites: readonly string[];
  readonly pipelines: readonly string[];
  readonly stacks: readonly string[];
  readonly wordpress: readonly string[];
  /** Checks that failed, e.g. the server did not answer over SSH. */
  readonly unchecked: readonly string[];
}

/** Whether a server runs something, or might: a check that failed proves nothing. */
export function mayBeInUse(usage: ServerUsage): boolean {
  return (
    usage.containers.length > 0 ||
    usage.sites.length > 0 ||
    usage.pipelines.length > 0 ||
    usage.stacks.length > 0 ||
    usage.wordpress.length > 0 ||
    usage.unchecked.length > 0
  );
}

const MAX_LISTED = 8;

function listed(label: string, items: readonly string[]): string | null {
  if (items.length === 0) return null;
  const shown = items.slice(0, MAX_LISTED).join(', ');
  const more = items.length > MAX_LISTED ? ` and ${String(items.length - MAX_LISTED)} more` : '';
  return `  ${label} (${String(items.length)}): ${shown}${more}`;
}

/** Plain text for a confirmation dialog, one block per server. */
export function describeServerUsage(usages: readonly ServerUsage[]): string {
  if (usages.length === 0) {
    return 'CloudForge has no saved VPS target for these servers, so it cannot tell what runs on them.';
  }
  return usages
    .map((usage) => {
      const lines = [
        listed('Containers', usage.containers),
        listed('Nginx sites', usage.sites),
        listed('Docker stacks', usage.stacks),
        listed('WordPress sites', usage.wordpress),
        listed('Pipelines', usage.pipelines),
        ...usage.unchecked.map((reason) => `  Could not check: ${reason}`),
      ].filter((line): line is string => line !== null);
      const heading = `${usage.targetName} (${usage.host})`;
      return lines.length > 0
        ? `${heading}\n${lines.join('\n')}`
        : `${heading}\n  Nothing found running.`;
    })
    .join('\n\n');
}
