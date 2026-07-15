import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArchiveRestore,
  CheckCircle2,
  FileCode2,
  Globe2,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
} from '@cloudforge/ui';
import type { ManagedNginxSite } from '@cloudforge/core';
import { PageHeader } from '../../components/PageHeader.js';
import { invoke } from '../../lib/ipc.js';
import { useVpsTargets } from '../ansible/useAnsible.js';
import { useNginx, useNginxEvents } from './useNginx.js';

const NEW_SITE: ManagedNginxSite = {
  domain: '',
  enabled: true,
  upstreamKind: 'host',
  upstreamHost: '127.0.0.1',
  upstreamPort: 3000,
  websocket: false,
  ssl: false,
  httpRedirect: false,
  headers: [],
  extraDirectives: [],
  locations: [],
  proxyTimeoutSeconds: 60,
  clientMaxBodySize: '10m',
  compression: true,
  cache: false,
  customSnippets: [],
  lastModified: null,
};

export function NginxPage(): JSX.Element {
  const targets = useVpsTargets();
  const [targetId, setTargetId] = useState('');
  const streamId = useMemo(() => crypto.randomUUID(), []);
  const nginx = useNginx(targetId, streamId);
  const events = useNginxEvents(streamId);
  const [site, setSite] = useState<ManagedNginxSite>(NEW_SITE);
  const [config, setConfig] = useState('');
  const [originalConfig, setOriginalConfig] = useState('');
  const [logKind, setLogKind] = useState<'access' | 'error'>('error');
  const [search, setSearch] = useState('');
  const [liveTail, setLiveTail] = useState(false);
  const [liveLogLines, setLiveLogLines] = useState<string[]>([]);
  const [backupComparison, setBackupComparison] = useState<{
    id: string;
    changedLines: number;
  } | null>(null);
  const fail = (error: Error): void => {
    toast.error(error.message);
  };
  useEffect(() => {
    if (!targets.data) return;
    if (!targets.data.some((target) => target.id === targetId)) {
      setTargetId(targets.data[0]?.id ?? '');
    }
  }, [targetId, targets.data]);
  useEffect(() => {
    if (!liveTail || !targetId) return;
    const refresh = (): void => {
      void invoke('nginx:logs', {
        targetId,
        query: { kind: logKind, search, limit: 1000 },
      })
        .then(({ lines: latest }) => setLiveLogLines(latest))
        .catch((error: Error) => {
          setLiveTail(false);
          toast.error(error.message);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 3_000);
    return () => window.clearInterval(timer);
  }, [liveTail, logKind, search, targetId]);
  const update = <K extends keyof ManagedNginxSite>(key: K, value: ManagedNginxSite[K]): void =>
    setSite((current) => ({ ...current, [key]: value }));
  const saveSite = (): void => {
    events.clear();
    nginx.saveSite.mutate(
      { ...site, lastModified: new Date().toISOString() },
      {
        onSuccess: ({ summary }) => {
          toast.success(summary);
          setSite(NEW_SITE);
        },
        onError: fail,
      },
    );
  };
  const busy =
    nginx.saveSite.isPending ||
    nginx.saveConfig.isPending ||
    nginx.reload.isPending ||
    nginx.removeSite.isPending ||
    nginx.restore.isPending;
  const overview = nginx.overview.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Nginx"
        description="Manage Nginx sites, configuration, status, logs, and rollback per VPS target."
      />
      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <div>
              <Label>VPS target</Label>
              <Select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
                <option value="">Select a saved target</option>
                {targets.data?.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.name} · {target.host}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              className="self-end"
              variant="outline"
              disabled={!targetId || nginx.overview.isFetching}
              onClick={() => void nginx.overview.refetch()}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>
      {!targetId ? (
        <Card>
          <CardContent className="text-muted-foreground py-12 text-center text-sm">
            Create and verify a VPS target in Ansible, then select it here.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <Metric
              icon={Server}
              label="Installation"
              value={overview?.installation ?? 'Checking…'}
            />
            <Metric
              icon={overview?.running ? CheckCircle2 : XCircle}
              label="Service"
              value={overview?.running ? `Running · ${overview.version ?? 'unknown'}` : 'Stopped'}
            />
            <Metric
              icon={ShieldCheck}
              label="Configuration"
              value={overview?.configStatus ?? 'unknown'}
            />
            <Metric
              icon={Globe2}
              label="Sites / SSL"
              value={`${overview?.siteCount ?? 0} / ${overview?.sslDomainCount ?? 0}`}
            />
          </div>
          {overview?.installation === 'docker' && (
            <Card className="border-amber-300">
              <CardContent className="py-4 text-sm">
                A Docker Nginx container was detected. Dashboard and validation work, but editing
                requires its configuration directory to be mounted at the standard host path.
              </CardContent>
            </Card>
          )}
          <Tabs defaultValue="sites">
            <TabsList>
              <TabsTrigger value="sites">Sites</TabsTrigger>
              <TabsTrigger value="config">Config editor</TabsTrigger>
              <TabsTrigger value="status">Live status</TabsTrigger>
              <TabsTrigger value="logs">Logs</TabsTrigger>
              <TabsTrigger value="backups">Backups</TabsTrigger>
            </TabsList>
            <TabsContent value="sites" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>All discovered sites</CardTitle>
                  <CardDescription>
                    Every change is backed up, validated, and rolled back automatically on failure.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Domain</TableHead>
                        <TableHead>Upstream</TableHead>
                        <TableHead>WebSocket</TableHead>
                        <TableHead>SSL</TableHead>
                        <TableHead>Modified</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {nginx.sites.data?.map((item) => (
                        <TableRow key={item.domain}>
                          <TableCell className="space-x-2 font-medium">
                            <span>{item.domain}</span>
                            <Badge variant={item.managed === false ? 'secondary' : 'outline'}>
                              {item.managed === false ? 'External' : 'CloudForge'}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {item.upstreamHost}:{item.upstreamPort}
                          </TableCell>
                          <TableCell>{item.websocket ? 'Yes' : 'No'}</TableCell>
                          <TableCell>{item.ssl ? 'Yes' : 'No'}</TableCell>
                          <TableCell>
                            {item.lastModified ? new Date(item.lastModified).toLocaleString() : '—'}
                          </TableCell>
                          <TableCell className="space-x-2 text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={item.managed === false}
                              onClick={() => setSite(item)}
                            >
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={busy || item.managed === false}
                              onClick={() =>
                                window.confirm(
                                  `Delete ${item.domain}? A backup will be created first.`,
                                ) &&
                                nginx.removeSite.mutate(item.domain, {
                                  onSuccess: ({ summary }) => toast.success(summary),
                                  onError: fail,
                                })
                              }
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{site.domain ? 'Edit site' : 'Create site'}</CardTitle>
                  <CardDescription>
                    Update the existing config in place; CloudForge does not delete and recreate the
                    VPS.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-2">
                  <Field label="Domain">
                    <Input
                      value={site.domain}
                      placeholder="app.example.com or *.example.com"
                      onChange={(event) => update('domain', event.target.value)}
                    />
                  </Field>
                  <Field label="Upstream type">
                    <Select
                      value={site.upstreamKind}
                      onChange={(event) =>
                        update('upstreamKind', event.target.value as 'host' | 'docker')
                      }
                    >
                      <option value="host">Host / IP</option>
                      <option value="docker">Docker container</option>
                    </Select>
                  </Field>
                  <Field label="Upstream host">
                    <Input
                      value={site.upstreamHost}
                      onChange={(event) => update('upstreamHost', event.target.value)}
                    />
                  </Field>
                  <Field label="Port">
                    <Input
                      type="number"
                      value={site.upstreamPort}
                      onChange={(event) => update('upstreamPort', Number(event.target.value))}
                    />
                  </Field>
                  <Field label="Proxy timeout (seconds)">
                    <Input
                      type="number"
                      value={site.proxyTimeoutSeconds}
                      onChange={(event) =>
                        update('proxyTimeoutSeconds', Number(event.target.value))
                      }
                    />
                  </Field>
                  <Field label="Client max body">
                    <Input
                      value={site.clientMaxBodySize}
                      onChange={(event) => update('clientMaxBodySize', event.target.value)}
                    />
                  </Field>
                  <Field label="Proxy headers (Name: Value)">
                    <Textarea
                      value={site.headers
                        .map((header) => `${header.name}: ${header.value}`)
                        .join('\n')}
                      onChange={(event) => update('headers', parseHeaders(event.target.value))}
                    />
                  </Field>
                  <Field label="Location blocks (JSON)">
                    <Textarea
                      key={`${site.domain}-${site.lastModified ?? 'new'}-locations`}
                      defaultValue={JSON.stringify(site.locations, null, 2)}
                      onBlur={(event) => {
                        try {
                          const parsed: unknown = JSON.parse(event.target.value);
                          if (Array.isArray(parsed))
                            update('locations', parsed as ManagedNginxSite['locations']);
                        } catch {
                          toast.error('Location blocks must be a JSON array');
                        }
                      }}
                    />
                  </Field>
                  <Field label="Extra directives (one per line)">
                    <Textarea
                      value={site.extraDirectives.join('\n')}
                      onChange={(event) => update('extraDirectives', lines(event.target.value))}
                    />
                  </Field>
                  <Field label="Custom snippets (one directive per line)">
                    <Textarea
                      value={site.customSnippets.join('\n')}
                      onChange={(event) => update('customSnippets', lines(event.target.value))}
                    />
                  </Field>
                  <div className="col-span-full flex flex-wrap gap-6">
                    <Toggle
                      label="Enabled"
                      checked={site.enabled}
                      onChange={(value) => update('enabled', value)}
                    />
                    <Toggle
                      label="WebSocket"
                      checked={site.websocket}
                      onChange={(value) => update('websocket', value)}
                    />
                    <Toggle
                      label="SSL"
                      checked={site.ssl}
                      onChange={(value) => update('ssl', value)}
                    />
                    <Toggle
                      label="Redirect HTTP"
                      checked={site.httpRedirect}
                      onChange={(value) => update('httpRedirect', value)}
                    />
                    <Toggle
                      label="Compression"
                      checked={site.compression}
                      onChange={(value) => update('compression', value)}
                    />
                    <Toggle
                      label="Cache"
                      checked={site.cache}
                      onChange={(value) => update('cache', value)}
                    />
                  </div>
                  <div className="col-span-full flex gap-2">
                    <Button disabled={busy || !site.domain} onClick={saveSite}>
                      <Save className="mr-2 h-4 w-4" />
                      Validate and apply
                    </Button>
                    <Button variant="outline" onClick={() => setSite(NEW_SITE)}>
                      Clear
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="config">
              <Card>
                <CardHeader>
                  <CardTitle>nginx.conf</CardTitle>
                  <CardDescription>
                    Advanced editor. A backup and syntax test are mandatory before reload.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      disabled={nginx.readConfig.isPending}
                      onClick={() =>
                        nginx.readConfig.mutate(undefined, {
                          onSuccess: ({ content }) => {
                            setConfig(content);
                            setOriginalConfig(content);
                          },
                          onError: fail,
                        })
                      }
                    >
                      <FileCode2 className="mr-2 h-4 w-4" />
                      Load
                    </Button>
                    <Button
                      disabled={!config || busy}
                      onClick={() =>
                        nginx.saveConfig.mutate(config, {
                          onSuccess: ({ summary }) => toast.success(summary),
                          onError: fail,
                        })
                      }
                    >
                      <Save className="mr-2 h-4 w-4" />
                      Validate and save
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        nginx.reload.mutate(undefined, {
                          onSuccess: ({ summary }) => toast.success(summary),
                          onError: fail,
                        })
                      }
                    >
                      <RefreshCw className="mr-2 h-4 w-4" />
                      Test and reload
                    </Button>
                  </div>
                  <div className="grid gap-3 xl:grid-cols-2">
                    <Textarea
                      className="min-h-[480px] font-mono text-xs"
                      spellCheck={false}
                      value={config}
                      onChange={(event) => setConfig(event.target.value)}
                    />
                    <NginxSyntaxPreview content={config} />
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {config === originalConfig
                      ? 'No local changes.'
                      : `${changedLineCount(originalConfig, config)} changed line positions. Saving will create a backup before validation.`}
                  </p>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="status">
              <Card>
                <CardHeader>
                  <CardTitle>Live status</CardTitle>
                  <CardDescription>
                    Polled every 15 seconds. Connection counters require nginx stub_status at
                    /nginx_status.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-4">
                  <Metric
                    icon={Activity}
                    label="Workers"
                    value={String(nginx.status.data?.workers ?? 'Unavailable')}
                  />
                  <Metric
                    icon={Activity}
                    label="Connections"
                    value={String(nginx.status.data?.activeConnections ?? 'Unavailable')}
                  />
                  <Metric
                    icon={Activity}
                    label="Requests"
                    value={String(nginx.status.data?.requests ?? 'Unavailable')}
                  />
                  <Metric
                    icon={XCircle}
                    label="Recent errors"
                    value={String(nginx.status.data?.recentErrors ?? 0)}
                  />
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="logs">
              <Card>
                <CardHeader>
                  <CardTitle>Log viewer</CardTitle>
                  <CardDescription>
                    Read, filter, search, and export access or error logs.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex gap-2">
                    <Select
                      className="w-40"
                      value={logKind}
                      onChange={(event) => setLogKind(event.target.value as 'access' | 'error')}
                    >
                      <option value="error">Error log</option>
                      <option value="access">Access log</option>
                    </Select>
                    <Input
                      placeholder="Filter"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                    <Button
                      onClick={() =>
                        nginx.logs.mutate({ kind: logKind, search, limit: 1000 }, { onError: fail })
                      }
                    >
                      Load
                    </Button>
                    <label className="flex items-center gap-2 text-sm">
                      <Switch checked={liveTail} onCheckedChange={setLiveTail} /> Live tail
                    </label>
                    <Button
                      variant="outline"
                      disabled={!nginx.logs.data}
                      onClick={() => downloadLog(nginx.logs.data?.lines ?? [], logKind)}
                    >
                      Export
                    </Button>
                  </div>
                  <LogTerminal lines={liveTail ? liveLogLines : (nginx.logs.data?.lines ?? [])} />
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="backups">
              <Card>
                <CardHeader>
                  <CardTitle>Automatic backups</CardTitle>
                  <CardDescription>
                    Restore validates the recovered configuration before reloading.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {nginx.backups.data?.map((backup) => (
                    <div
                      key={backup.id}
                      className="flex items-center justify-between rounded-md border p-3"
                    >
                      <div>
                        <div className="font-medium">{backup.reason}</div>
                        <div className="text-muted-foreground text-xs">{backup.createdAt}</div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          disabled={nginx.readBackupConfig.isPending}
                          onClick={() =>
                            nginx.readBackupConfig.mutate(backup.id, {
                              onSuccess: ({ content: backupContent }) =>
                                nginx.readConfig.mutate(undefined, {
                                  onSuccess: ({ content: currentContent }) =>
                                    setBackupComparison({
                                      id: backup.id,
                                      changedLines: changedLineCount(backupContent, currentContent),
                                    }),
                                  onError: fail,
                                }),
                              onError: fail,
                            })
                          }
                        >
                          Compare
                        </Button>
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            window.confirm(`Restore ${backup.id}?`) &&
                            nginx.restore.mutate(backup.id, {
                              onSuccess: ({ summary }) => toast.success(summary),
                              onError: fail,
                            })
                          }
                        >
                          <ArchiveRestore className="mr-2 h-4 w-4" />
                          Restore
                        </Button>
                      </div>
                    </div>
                  ))}
                  {backupComparison && (
                    <p className="text-muted-foreground text-xs">
                      Backup {backupComparison.id} differs from the current nginx.conf at{' '}
                      {backupComparison.changedLines} line positions.
                    </p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
          {events.lines.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Operation output</CardTitle>
              </CardHeader>
              <CardContent>
                <LogTerminal lines={events.lines} />
              </CardContent>
            </Card>
          )}
        </>
      )}
      {nginx.overview.error && (
        <Card className="border-destructive/50">
          <CardContent className="py-4 text-sm">
            Target offline: {nginx.overview.error.message}. If OCI replaced the instance or changed
            its public IP, update and re-verify the saved VPS target before making Nginx changes.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Server;
  label: string;
  value: string;
}): JSX.Element {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-5">
        <Icon className="text-muted-foreground h-5 w-5" />
        <div>
          <div className="text-muted-foreground text-xs">{label}</div>
          <div className="font-semibold capitalize">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}): JSX.Element {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Switch checked={checked} onCheckedChange={onChange} />
      {label}
    </label>
  );
}
function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
function parseHeaders(value: string): ManagedNginxSite['headers'] {
  return lines(value).flatMap((line) => {
    const separator = line.indexOf(':');
    return separator > 0
      ? [{ name: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() }]
      : [];
  });
}
function changedLineCount(before: string, after: string): number {
  const left = before.split('\n');
  const right = after.split('\n');
  return Array.from({ length: Math.max(left.length, right.length) }).filter(
    (_, index) => left[index] !== right[index],
  ).length;
}
function NginxSyntaxPreview({ content }: { content: string }): JSX.Element {
  return (
    <pre className="bg-muted/40 max-h-[480px] min-h-[480px] overflow-auto rounded-md border p-3 font-mono text-xs leading-5">
      {content.split('\n').map((line, index) => {
        const match = /^(\s*)([a-z_]+)(.*)$/i.exec(line);
        return (
          <span className="block" key={`${index}-${line}`}>
            <span className="text-muted-foreground mr-3 inline-block w-8 select-none text-right">
              {index + 1}
            </span>
            {line.trimStart().startsWith('#') || !match ? (
              <span className="text-muted-foreground">{line || ' '}</span>
            ) : (
              <>
                {match[1]}
                <span className="text-primary font-semibold">{match[2]}</span>
                <span className="text-foreground">{match[3]}</span>
              </>
            )}
          </span>
        );
      })}
    </pre>
  );
}
function downloadLog(linesValue: string[], kind: string): void {
  const url = URL.createObjectURL(new Blob([linesValue.join('\n')], { type: 'text/plain' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `nginx-${kind}-${new Date().toISOString().slice(0, 10)}.log`;
  anchor.click();
  URL.revokeObjectURL(url);
}
