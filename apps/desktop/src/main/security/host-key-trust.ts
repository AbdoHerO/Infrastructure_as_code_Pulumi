const INSPECTION_MEMORY_MS = 30 * 60_000;

const hostKey = (host: string, port: number): string =>
  `${host.trim().toLowerCase()}:${String(port)}`;

/**
 * Which SSH fingerprints the main process itself has seen.
 *
 * A fingerprint is what SSH trusts, so whoever supplies it decides which machine
 * counts as genuine. Requests still carry one while a server is being added, but it
 * is accepted only when it was just read from that host here, or when a saved
 * target already pins it. A value made up by the caller is refused.
 */
export class HostKeyTrust {
  private readonly inspected = new Map<string, { fingerprint: string; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Record a fingerprint read from a server by the main process. */
  remember(host: string, port: number, fingerprint: string): void {
    this.inspected.set(hostKey(host, port), { fingerprint, at: this.now() });
  }

  /** Whether this fingerprint was read from this host a moment ago. */
  wasInspected(host: string, port: number, fingerprint: string): boolean {
    const known = this.inspected.get(hostKey(host, port));
    return known?.fingerprint === fingerprint && this.now() - known.at <= INSPECTION_MEMORY_MS;
  }
}

/** The fingerprints read from servers while this application has been running. */
export const hostKeyTrust = new HostKeyTrust();
