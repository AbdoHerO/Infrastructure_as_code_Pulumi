/**
 * Which cached data each module's channels can change, by the first part of the
 * query key. An MCP client changes things behind the window's back, and this is
 * how the open page finds out.
 */
const QUERY_ROOTS_BY_MODULE: Readonly<Record<string, readonly string[]>> = {
  activity: [],
  ansible: ['ansible', 'runtime'],
  app: ['ansible', 'cloudflare'],
  backup: [],
  cloudflare: ['cloudflare'],
  containers: ['runtime'],
  credentials: ['credentials'],
  deploy: ['deploy'],
  domains: [],
  firewall: [],
  hostAccess: [],
  hostFirewall: [],
  infra: ['infra', 'ansible'],
  jenkins: ['jenkins'],
  logs: ['logs'],
  mcp: [],
  nginx: ['nginx', 'runtime'],
  plugins: ['plugins'],
  projects: ['projects'],
  providers: ['providers'],
  runtime: ['runtime'],
  security: [],
  settings: ['settings'],
  sshKeys: ['sshKeys'],
  ssl: ['nginx', 'runtime'],
  stacks: ['stacks', 'runtime', 'nginx'],
  terminal: [],
  updates: [],
  wordpress: ['wordpress', 'runtime', 'nginx'],
};

/** The query roots to reload after these channels changed something. */
export function queryRootsForChannels(channels: readonly string[]): Set<string> {
  const roots = new Set<string>(['activity']);
  for (const channel of channels) {
    const module = channel.split(':')[0] ?? '';
    for (const root of QUERY_ROOTS_BY_MODULE[module] ?? []) roots.add(root);
  }
  return roots;
}

/** Whether a module's channels are accounted for here. */
export function knowsModule(module: string): boolean {
  return module in QUERY_ROOTS_BY_MODULE;
}
