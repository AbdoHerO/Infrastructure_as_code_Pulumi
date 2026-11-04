import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Globe,
  RefreshCw,
  Rocket,
  Trash2,
  Wrench,
  XCircle,
} from 'lucide-react';
import {
  nextWordPressPort,
  validateWordPressSite,
  wordpressSiteUrl,
  type WordPressDomainCheck,
  type WordPressRuntimeStatus,
  type WordPressSiteRecord,
} from '@cloudforge/core';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  LogTerminal,
  Select,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@cloudforge/ui';
import { PageHeader } from '../../components/PageHeader.js';
import { useConfirmation } from '../../components/ConfirmationDialogProvider.js';
import { invoke, subscribe } from '../../lib/ipc.js';
import { useVpsTargets } from '../ansible/useAnsible.js';
import { useCredentials } from '../secrets/useCredentials.js';

const SITES_KEY = ['wordpress', 'sites'] as const;
/** One or more DNS labels in front of the Cloudflare domain: `blog`, `shop.eu`. */
const SUBDOMAIN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

async function copy(value: string, label: string): Promise<void> {
  try {
    await invoke('app:copyText', { text: value });
    toast.success(`${label} copied`);
  } catch (error) {
    toast.error(`Could not copy: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusBadge(site: WordPressSiteRecord): JSX.Element {
  if (site.status === 'failed') return <Badge variant="destructive">Failed</Badge>;
  if (site.status === 'deploying') return <Badge variant="secondary">Deploying</Badge>;
  return site.warnings.length > 0 ? (
    <Badge variant="warning">Running · {site.warnings.length} warning</Badge>
  ) : (
    <Badge variant="success">Running</Badge>
  );
}

function DomainAvailability({
  domain,
  check,
  checking,
}: {
  domain: string;
  check: WordPressDomainCheck | null;
  checking: boolean;
}): JSX.Element {
  if (checking || !check)
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <RefreshCw className="size-4 animate-spin" /> Checking whether {domain} is free…
      </p>
    );
  if (!check.available)
    return (
      <div className="border-destructive/40 bg-destructive/5 rounded-md border p-3 text-sm">
        <p className="text-destructive flex items-center gap-2 font-medium">
          <XCircle className="size-4" /> {domain} is already in use. Choose another subdomain.
        </p>
        <ul className="text-muted-foreground mt-1 list-disc pl-6">
          {check.conflicts.map((conflict) => (
            <li key={conflict}>{conflict}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="text-sm">
      <p className="text-success flex items-center gap-2 font-medium">
        <CheckCircle2 className="size-4" /> {domain} is free
      </p>
      {check.notes.map((note) => (
        <p key={note} className="text-muted-foreground pl-6">
          {note}
        </p>
      ))}
    </div>
  );
}

/** A URL the operating-system browser may open: the app only lets HTTPS leave. */
function SiteLink({ url, label }: { url: string; label: string }): JSX.Element {
  return url.startsWith('https://') ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="text-primary inline-flex items-center gap-1 hover:underline"
    >
      {label} <ExternalLink className="size-3" />
    </a>
  ) : (
    <span>{label}</span>
  );
}

export function WordPressPage(): JSX.Element {
  const confirm = useConfirmation();
  const client = useQueryClient();
  const targets = useVpsTargets();
  const credentials = useCredentials();
  const cloudflareCredentials = useMemo(
    () => credentials.data?.filter((credential) => credential.kind === 'cloudflare') ?? [],
    [credentials.data],
  );
  const sites = useQuery({
    queryKey: SITES_KEY,
    queryFn: () => invoke('wordpress:list', undefined),
  });

  const [targetId, setTargetId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [domainMode, setDomainMode] = useState<'subdomain' | 'root'>('subdomain');
  const [subdomain, setSubdomain] = useState('');
  const [manualDomain, setManualDomain] = useState('');
  const [domainCheck, setDomainCheck] = useState<WordPressDomainCheck | null>(null);
  const [checkingDomain, setCheckingDomain] = useState(false);
  const [siteTitle, setSiteTitle] = useState('');
  const [adminUser, setAdminUser] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [hostPort, setHostPort] = useState('');
  const [cloudflareCredentialId, setCloudflareCredentialId] = useState('');
  const [https, setHttps] = useState(true);
  const [certificateEmail, setCertificateEmail] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [created, setCreated] = useState<{
    site: WordPressSiteRecord;
    adminPassword: string;
  } | null>(null);
  const [statuses, setStatuses] = useState<Record<string, WordPressRuntimeStatus>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const streamId = useMemo(() => crypto.randomUUID(), []);

  useEffect(() => {
    if (!targetId && targets.data?.[0]) setTargetId(targets.data[0].id);
  }, [targetId, targets.data]);
  // Preselect the first Cloudflare account once; choosing "not on Cloudflare" stays chosen.
  const [accountPicked, setAccountPicked] = useState(false);
  useEffect(() => {
    if (accountPicked || !credentials.data) return;
    setAccountPicked(true);
    if (cloudflareCredentials[0]) setCloudflareCredentialId(cloudflareCredentials[0].id);
  }, [accountPicked, credentials.data, cloudflareCredentials]);
  useEffect(
    () =>
      subscribe('wordpress:log', (payload) => {
        if (payload.streamId !== streamId) return;
        const text = payload.event.message.trimEnd();
        if (!text) return;
        const line = payload.event.stream === 'step' ? `▶ ${text}` : text;
        setLogs((current) => [...current.slice(-800), line]);
      }),
    [streamId],
  );

  const zones = useQuery({
    queryKey: ['cloudflare', 'zones', cloudflareCredentialId],
    queryFn: () => invoke('cloudflare:zones', { credentialId: cloudflareCredentialId }),
    enabled: cloudflareCredentialId !== '',
  });
  useEffect(() => {
    const available = zones.data ?? [];
    if (available.length > 0 && !available.some((zone) => zone.id === zoneId))
      setZoneId(available[0]?.id ?? '');
  }, [zoneId, zones.data]);
  const zone = zones.data?.find((item) => item.id === zoneId);
  const subdomainValid = SUBDOMAIN.test(subdomain);
  const domain = cloudflareCredentialId
    ? zone
      ? domainMode === 'root'
        ? zone.name
        : subdomainValid
          ? `${subdomain}.${zone.name}`
          : ''
      : ''
    : manualDomain.trim().toLowerCase();

  // Ask the main process whether anything already uses the domain: another site,
  // a Jenkins application, Nginx on the server, or a Cloudflare record elsewhere.
  useEffect(() => {
    setDomainCheck(null);
    if (!targetId || !/^[a-z0-9.-]+\.[a-z]{2,63}$/.test(domain)) return;
    let current = true;
    const timer = setTimeout(() => {
      setCheckingDomain(true);
      invoke('wordpress:checkDomain', {
        targetId,
        domain,
        cloudflareCredentialId: cloudflareCredentialId || null,
        cloudflareZoneId: cloudflareCredentialId ? zoneId || null : null,
      })
        .then((result) => {
          if (current) setDomainCheck(result);
        })
        .catch((error: unknown) => {
          if (current)
            setDomainCheck({
              domain,
              available: false,
              conflicts: [`Could not check the domain: ${message(error)}`],
              notes: [],
            });
        })
        .finally(() => {
          if (current) setCheckingDomain(false);
        });
    }, 600);
    return () => {
      current = false;
      clearTimeout(timer);
      setCheckingDomain(false);
    };
  }, [targetId, domain, cloudflareCredentialId, zoneId, sites.data]);
  const domainReady = domainCheck?.domain === domain && domainCheck.available && !checkingDomain;

  const target = targets.data?.find((item) => item.id === targetId);
  const suggestedPort = nextWordPressPort(
    (sites.data ?? []).filter((site) => site.targetId === targetId).map((site) => site.hostPort),
  );
  const input = {
    targetId,
    domain,
    siteTitle,
    adminUser,
    adminEmail,
    adminPassword,
    hostPort: hostPort.trim() === '' ? null : Number(hostPort),
    cloudflareCredentialId: cloudflareCredentialId || null,
    cloudflareZoneId: cloudflareCredentialId ? zoneId || null : null,
    https,
    certificateEmail,
  };
  const validation = validateWordPressSite(input);
  const refresh = (): Promise<void> => client.invalidateQueries({ queryKey: SITES_KEY });

  const create = useMutation({
    mutationFn: () => invoke('wordpress:create', { site: input, streamId }),
    onMutate: () => {
      setLogs([]);
      setCreated(null);
    },
    onSuccess: (result) => {
      setCreated(result);
      setAdminPassword('');
      if (result.site.warnings.length > 0)
        toast.warning(`WordPress is running with a warning. See the site below.`);
      else toast.success(`WordPress is live at ${result.site.domain}`);
    },
    onError: (error) => toast.error(message(error)),
    onSettled: () => void refresh(),
  });

  const submit = (): void => {
    if (!validation.ok) {
      toast.error(validation.error.message);
      return;
    }
    const value = validation.value;
    void confirm({
      title: `Deploy WordPress on ${value.domain}?`,
      description: [
        `Starts WordPress and a MariaDB database in Docker on ${target?.name ?? 'the server'} (${target?.host ?? ''}), reachable only on 127.0.0.1:${String(value.hostPort ?? suggestedPort)}.`,
        value.cloudflareCredentialId
          ? `Points ${value.domain} to the server in Cloudflare.`
          : `Does not change DNS: ${value.domain} must already point to ${target?.host ?? 'the server'}.`,
        `Publishes it with Nginx${value.https ? ' and requests a free Let’s Encrypt certificate' : ''}.`,
        'Nothing else on the server is changed.',
      ].join(' '),
      confirmLabel: 'Deploy WordPress',
      destructive: false,
    }).then((confirmed) => {
      if (confirmed) create.mutate();
    });
  };

  const run = async (id: string, action: string, work: () => Promise<unknown>): Promise<void> => {
    setBusy(`${id}:${action}`);
    setLogs([]);
    try {
      await work();
    } catch (error) {
      toast.error(message(error));
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const checkStatus = (site: WordPressSiteRecord): Promise<void> =>
    run(site.id, 'status', async () => {
      const status = await invoke('wordpress:status', { id: site.id });
      setStatuses((current) => ({ ...current, [site.id]: status }));
      toast.success(
        `${site.domain}: ${status.containers.filter((item) => item.state === 'running').length} of ${status.containers.length} containers running`,
      );
    });

  const update = (site: WordPressSiteRecord): void => {
    void confirm({
      title: `Update ${site.domain}?`,
      description:
        'Downloads the latest WordPress, MariaDB and WP-CLI images, restarts the site (a few seconds offline) and updates WordPress core. Posts, pages, media, themes and plugins are kept.',
      confirmLabel: 'Update',
      destructive: false,
    }).then((confirmed) => {
      if (!confirmed) return;
      void run(site.id, 'update', async () => {
        const updated = await invoke('wordpress:update', { id: site.id, streamId });
        toast.success(`${site.domain} runs WordPress ${updated.wordpressVersion ?? '(latest)'}`);
      });
    });
  };

  const redeploy = (site: WordPressSiteRecord): void => {
    void confirm({
      title: `Redeploy ${site.domain}?`,
      description:
        'Runs every step again with the same passwords: containers, DNS, Nginx and HTTPS. Use it after fixing DNS or when a step failed. Content is kept.',
      confirmLabel: 'Redeploy',
      destructive: false,
    }).then((confirmed) => {
      if (!confirmed) return;
      void run(site.id, 'redeploy', async () => {
        const result = await invoke('wordpress:redeploy', { id: site.id, streamId });
        if (result.warnings.length > 0) toast.warning('Redeployed with a warning');
        else toast.success(`${site.domain} is live`);
      });
    });
  };

  const remove = (site: WordPressSiteRecord, deleteData: boolean): void => {
    void confirm({
      title: deleteData
        ? `Delete ${site.domain} and all its content?`
        : `Remove ${site.domain} from the server?`,
      description: deleteData
        ? 'Deletes the containers, the database, every post, page, upload, theme and plugin, the Nginx site and the saved passwords. This cannot be undone.'
        : 'Stops and removes the containers and the Nginx site. The database, uploads and passwords are kept on the server, so deploying the same domain again brings the site back.',
      confirmLabel: deleteData ? 'Delete everything' : 'Remove',
      destructive: true,
    }).then((confirmed) => {
      if (!confirmed) return;
      void run(site.id, deleteData ? 'delete' : 'remove', async () => {
        await invoke('wordpress:remove', { id: site.id, deleteData, streamId });
        toast.success(deleteData ? `${site.domain} was deleted` : `${site.domain} was removed`);
      });
    });
  };

  const targetName = (id: string): string =>
    targets.data?.find((item) => item.id === id)?.name ?? 'Unknown server';
  const working = create.isPending || busy !== null;

  return (
    <div>
      <PageHeader
        title="WordPress"
        description="Deploy WordPress sites on your servers: the latest WordPress and MariaDB in Docker, published on your domain with Nginx and HTTPS."
      />

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Rocket className="size-4" /> New WordPress site
            </CardTitle>
            <CardDescription>
              The server needs Docker and Nginx (set them up in VPS Runtime). Containers appear in
              Containers and in Dockhand as the stack{' '}
              <code>
                {domain.trim()
                  ? `cloudforge-wp-${domain
                      .trim()
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, '-')
                      .replace(/^-+|-+$/g, '')}`
                  : 'cloudforge-wp-<domain>'}
              </code>
              .
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="wp-target">Server</Label>
              <Select
                id="wp-target"
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
              >
                {(targets.data ?? []).length === 0 ? (
                  <option value="">No saved server</option>
                ) : null}
                {(targets.data ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.host})
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="wp-cloudflare">Cloudflare account</Label>
              <Select
                id="wp-cloudflare"
                value={cloudflareCredentialId}
                onChange={(event) => setCloudflareCredentialId(event.target.value)}
              >
                {cloudflareCredentials.map((credential) => (
                  <option key={credential.id} value={credential.id}>
                    {credential.name}
                  </option>
                ))}
                <option value="">Domain not on Cloudflare (I set DNS myself)</option>
              </Select>
            </div>
            {cloudflareCredentialId ? (
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="wp-zone">Domain</Label>
                <div className="grid gap-3 md:grid-cols-[1fr_auto_1.4fr]">
                  <Select
                    id="wp-zone"
                    value={zoneId}
                    disabled={zones.isLoading}
                    onChange={(event) => setZoneId(event.target.value)}
                  >
                    {zones.isLoading ? <option value="">Loading your domains…</option> : null}
                    {!zones.isLoading && (zones.data ?? []).length === 0 ? (
                      <option value="">No domain in this Cloudflare account</option>
                    ) : null}
                    {(zones.data ?? []).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                  <Select
                    id="wp-domain-mode"
                    aria-label="Use the domain or a subdomain"
                    value={domainMode}
                    onChange={(event) =>
                      setDomainMode(event.target.value === 'root' ? 'root' : 'subdomain')
                    }
                  >
                    <option value="subdomain">New subdomain</option>
                    <option value="root">The domain itself</option>
                  </Select>
                  {domainMode === 'subdomain' ? (
                    <div className="flex items-center gap-2">
                      <Input
                        id="wp-subdomain"
                        value={subdomain}
                        placeholder="blog"
                        autoComplete="off"
                        onChange={(event) => setSubdomain(event.target.value.trim().toLowerCase())}
                      />
                      <span className="text-muted-foreground whitespace-nowrap text-sm">
                        .{zone?.name ?? 'domain'}
                      </span>
                    </div>
                  ) : (
                    <div className="text-muted-foreground flex items-center text-sm">
                      {zone?.name ?? ''}
                    </div>
                  )}
                </div>
                {zones.isError ? (
                  <p className="text-destructive text-sm">
                    Could not load the Cloudflare domains: {message(zones.error)}
                  </p>
                ) : null}
                {domainMode === 'subdomain' && subdomain && !subdomainValid ? (
                  <p className="text-destructive text-sm">
                    A subdomain uses letters, digits and hyphens, e.g. blog or shop.eu
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="wp-domain">Domain</Label>
                <Input
                  id="wp-domain"
                  value={manualDomain}
                  placeholder="blog.example.com"
                  onChange={(event) => setManualDomain(event.target.value)}
                />
              </div>
            )}
            {domain ? (
              <div className="md:col-span-2">
                <DomainAvailability
                  domain={domain}
                  check={domainCheck?.domain === domain ? domainCheck : null}
                  checking={checkingDomain}
                />
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="wp-title">Site title</Label>
              <Input
                id="wp-title"
                value={siteTitle}
                placeholder="My blog"
                onChange={(event) => setSiteTitle(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wp-port">Local port (optional)</Label>
              <Input
                id="wp-port"
                inputMode="numeric"
                value={hostPort}
                placeholder={`${String(suggestedPort)} (automatic)`}
                onChange={(event) => setHostPort(event.target.value.replace(/[^0-9]/g, ''))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wp-admin">Admin user name</Label>
              <Input
                id="wp-admin"
                value={adminUser}
                placeholder="alex"
                autoComplete="off"
                onChange={(event) => setAdminUser(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wp-email">Admin email</Label>
              <Input
                id="wp-email"
                type="email"
                value={adminEmail}
                placeholder="you@example.com"
                onChange={(event) => setAdminEmail(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wp-password">Admin password (optional)</Label>
              <Input
                id="wp-password"
                type="password"
                value={adminPassword}
                autoComplete="new-password"
                placeholder="Leave empty to generate a strong one"
                onChange={(event) => setAdminPassword(event.target.value)}
              />
            </div>
            <div className="flex items-center gap-3">
              <Switch id="wp-https" checked={https} onCheckedChange={setHttps} />
              <Label htmlFor="wp-https">HTTPS with a free Let’s Encrypt certificate</Label>
            </div>
            {https ? (
              <div className="space-y-2">
                <Label htmlFor="wp-cert-email">Certificate email (optional)</Label>
                <Input
                  id="wp-cert-email"
                  type="email"
                  value={certificateEmail}
                  placeholder={adminEmail || 'Same as the admin email'}
                  onChange={(event) => setCertificateEmail(event.target.value)}
                />
              </div>
            ) : (
              <div />
            )}
            <div className="flex flex-wrap items-center gap-3 md:col-span-2">
              <Button onClick={submit} disabled={working || !targetId || !domainReady}>
                <Rocket className="mr-2 size-4" />
                {create.isPending ? 'Deploying… (a few minutes)' : 'Deploy WordPress'}
              </Button>
              {!validation.ok && (domain || siteTitle || adminUser || adminEmail) ? (
                <span className="text-muted-foreground text-sm">{validation.error.message}</span>
              ) : null}
            </div>
          </CardContent>
        </Card>

        {created ? (
          <Card className="border-success/40">
            <CardHeader>
              <CardTitle>WordPress is ready: save the admin login now</CardTitle>
              <CardDescription>
                The password is shown here once. You can reveal it again later in Secrets, under
                “WordPress · {created.site.domain}”.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              {[
                ['Site', wordpressSiteUrl(created.site.domain, created.site.https)],
                [
                  'Admin page',
                  `${wordpressSiteUrl(created.site.domain, created.site.https)}/wp-admin/`,
                ],
                ['User name', created.site.adminUser],
                ['Password', created.adminPassword],
              ].map(([label, value]) => (
                <div key={label} className="flex flex-wrap items-center gap-3">
                  <span className="text-muted-foreground w-28">{label}</span>
                  <code className="bg-muted rounded px-2 py-1">
                    {label === 'Password' ? '•'.repeat(12) : value}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void copy(value ?? '', label ?? '')}
                  >
                    <Copy className="mr-1 size-3" /> Copy
                  </Button>
                  {label === 'Admin page' && value ? <SiteLink url={value} label="Open" /> : null}
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        {logs.length > 0 || working ? (
          <Card>
            <CardHeader>
              <CardTitle>Progress</CardTitle>
            </CardHeader>
            <CardContent>
              <LogTerminal lines={logs} emptyMessage="Connecting to the server…" />
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="size-4" /> Sites
            </CardTitle>
            <CardDescription>
              WordPress keeps itself up to date for security releases. Update also refreshes PHP,
              Apache and MariaDB.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {(sites.data ?? []).length === 0 ? (
              <p className="text-muted-foreground text-sm">No WordPress site yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Domain</TableHead>
                    <TableHead>Server</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>WordPress</TableHead>
                    <TableHead>Port</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(sites.data ?? []).map((site) => {
                    const url = wordpressSiteUrl(site.domain, site.https);
                    const status = statuses[site.id];
                    const isBusy = (action: string): boolean => busy === `${site.id}:${action}`;
                    return (
                      <TableRow key={site.id}>
                        <TableCell className="align-top">
                          <div className="font-medium">
                            <SiteLink url={url} label={site.domain} />
                          </div>
                          <div className="text-muted-foreground text-xs">
                            <SiteLink url={`${url}/wp-admin/`} label="Admin" /> · {site.adminUser}
                          </div>
                          {[...site.warnings, ...(site.lastError ? [site.lastError] : [])].map(
                            (text) => (
                              <div
                                key={text}
                                className="text-warning mt-1 flex max-w-xl items-start gap-1 text-xs"
                              >
                                <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {text}
                              </div>
                            ),
                          )}
                          {status ? (
                            <div className="text-muted-foreground mt-1 text-xs">
                              {status.containers
                                .map(
                                  (item) =>
                                    `${item.service}: ${item.state}${item.health ? ` (${item.health})` : ''}`,
                                )
                                .join(' · ') || 'No container found on the server'}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="align-top">{targetName(site.targetId)}</TableCell>
                        <TableCell className="align-top">{statusBadge(site)}</TableCell>
                        <TableCell className="align-top">{site.wordpressVersion ?? '—'}</TableCell>
                        <TableCell className="align-top">127.0.0.1:{site.hostPort}</TableCell>
                        <TableCell className="align-top">
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={working}
                              onClick={() => void checkStatus(site)}
                            >
                              <RefreshCw
                                className={`mr-1 size-3 ${isBusy('status') ? 'animate-spin' : ''}`}
                              />
                              Check
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={working || site.status === 'failed'}
                              onClick={() => update(site)}
                            >
                              Update
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={working}
                              onClick={() => redeploy(site)}
                            >
                              <Wrench className="mr-1 size-3" /> Redeploy
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={working}
                              onClick={() => remove(site, false)}
                            >
                              Remove
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive"
                              disabled={working}
                              onClick={() => remove(site, true)}
                            >
                              <Trash2 className="mr-1 size-3" /> Delete
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
