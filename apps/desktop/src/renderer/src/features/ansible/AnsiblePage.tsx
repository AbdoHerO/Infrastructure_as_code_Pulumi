import { useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Fingerprint,
  Loader2,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  Square,
  Trash2,
  Wrench,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@cloudforge/ui';
import type {
  AnsibleProfileId,
  NginxSite,
  VpsPreflightReport,
  VpsTargetDto,
} from '@cloudforge/core';
import type { SshTargetRequest } from '@shared/ipc/contract.js';
import { PageHeader } from '../../components/PageHeader.js';
import { useSshCredentials } from '../deployments/useDeployments.js';
import {
  useAnsibleActions,
  useAnsibleLogs,
  useAnsibleProfiles,
  useVpsTargetActions,
  useVpsTargets,
} from './useAnsible.js';

export function AnsiblePage(): JSX.Element {
  const streamId = useMemo(() => crypto.randomUUID(), []);
  const profiles = useAnsibleProfiles();
  const credentials = useSshCredentials();
  const savedTargets = useVpsTargets();
  const targetActions = useVpsTargetActions();
  const actions = useAnsibleActions(streamId);
  const logs = useAnsibleLogs(streamId);
  const [selectedTargetId, setSelectedTargetId] = useState('');
  const [targetName, setTargetName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState('ubuntu');
  const [sshCredentialId, setSshCredentialId] = useState('');
  const [hostKeySha256, setHostKeySha256] = useState('');
  const [profileId, setProfileId] = useState('docker');
  const profile = profiles.data?.find((item) => item.id === profileId);
  const [variables, setVariables] = useState<Record<string, unknown>>({});
  const [domain, setDomain] = useState('');
  const [upstreamHost, setUpstreamHost] = useState('127.0.0.1');
  const [upstreamPort, setUpstreamPort] = useState(3000);
  const [websocket, setWebsocket] = useState(false);

  const target: SshTargetRequest = { host, port, username, sshCredentialId, hostKeySha256 };
  const connected = Boolean(host && username && sshCredentialId && hostKeySha256);
  const busy =
    actions.preflight.isPending ||
    actions.repair.isPending ||
    actions.run.isPending ||
    actions.upsert.isPending ||
    actions.remove.isPending;
  const report = actions.preflight.data;
  const profileReady = report?.status === 'ready' && report.profileId === profile?.id;
  const nginxReady = report?.status === 'ready' && report.profileId === 'nginx';
  const fail = (error: Error): void => {
    toast.error(error.message);
  };
  const refreshSites = (): void => actions.sites.mutate(target, { onError: fail });

  const inspect = (): void =>
    actions.inspect.mutate(
      { host, port },
      {
        onSuccess: ({ fingerprint }) => {
          setHostKeySha256(fingerprint);
          actions.preflight.reset();
        },
        onError: fail,
      },
    );
  const profileValues = (): Record<string, unknown> =>
    Object.fromEntries(
      (profile?.variables ?? []).map((spec) => [
        spec.key,
        variables[spec.key] ?? spec.defaultValue,
      ]),
    );
  const preflight = (requestedProfile: AnsibleProfileId = profile?.id ?? 'docker'): void => {
    logs.clear();
    actions.preflight.mutate(
      {
        ...target,
        ...(selectedTargetId ? { targetId: selectedTargetId } : {}),
        profileId: requestedProfile,
        variables: requestedProfile === profile?.id ? profileValues() : {},
      },
      {
        onSuccess: (result) =>
          result.status === 'ready'
            ? toast.success('VPS is ready for this playbook')
            : toast.warning('Review the VPS readiness report'),
        onError: fail,
      },
    );
  };
  const repair = (): void => {
    const packageList = report?.repairPackages.join(', ');
    let packages = 'required system packages';
    if (packageList) packages = packageList;
    if (!window.confirm(`CloudForge will install or update: ${packages}. Continue?`)) return;
    logs.clear();
    actions.repair.mutate(
      { ...target, ...(selectedTargetId ? { targetId: selectedTargetId } : {}) },
      {
        onSuccess: () => {
          toast.success('VPS prerequisites repaired; running final checks');
          preflight();
        },
        onError: fail,
      },
    );
  };
  const runProfile = (): void => {
    if (!profile) return;
    logs.clear();
    actions.run.mutate(
      { ...target, profileId: profile.id, variables: profileValues() },
      {
        onSuccess: ({ summary }) => toast.success(summary),
        onError: fail,
      },
    );
  };
  const selectTarget = (id: string): void => {
    setSelectedTargetId(id);
    actions.preflight.reset();
    const saved = savedTargets.data?.find((item) => item.id === id);
    if (!saved) {
      setTargetName('');
      setHost('');
      setPort(22);
      setUsername('ubuntu');
      setSshCredentialId('');
      setHostKeySha256('');
      return;
    }
    setTargetName(saved.name);
    setHost(saved.host);
    setPort(saved.port);
    setUsername(saved.username);
    setSshCredentialId(saved.sshCredentialId ?? '');
    setHostKeySha256(saved.hostKeySha256);
  };
  const saveTarget = (): void => {
    const request = { name: targetName, ...target };
    const callbacks = {
      onSuccess: (saved: VpsTargetDto) => {
        setSelectedTargetId(saved.id);
        toast.success('VPS target saved');
      },
      onError: fail,
    };
    if (selectedTargetId)
      targetActions.update.mutate({ id: selectedTargetId, ...request }, callbacks);
    else targetActions.create.mutate(request, callbacks);
  };
  const deleteTarget = (): void => {
    if (!selectedTargetId || !window.confirm(`Delete the saved target “${targetName}”?`)) return;
    targetActions.remove.mutate(selectedTargetId, {
      onSuccess: () => {
        selectTarget('');
        toast.success('VPS target deleted (the VPS itself was not changed)');
      },
      onError: fail,
    });
  };
  const saveSite = (): void => {
    logs.clear();
    const site: NginxSite = {
      domain: domain.trim().toLowerCase(),
      upstreamHost: upstreamHost.trim(),
      upstreamPort,
      websocket,
    };
    actions.upsert.mutate(
      { ...target, site },
      {
        onSuccess: ({ summary }) => {
          toast.success(summary);
          refreshSites();
        },
        onError: fail,
      },
    );
  };
  const removeSite = (site: NginxSite): void => {
    if (!window.confirm(`Remove the Nginx route for ${site.domain}?`)) return;
    logs.clear();
    actions.remove.mutate(
      { ...target, domain: site.domain },
      {
        onSuccess: ({ summary }) => {
          toast.success(summary);
          refreshSites();
        },
        onError: fail,
      },
    );
  };

  return (
    <>
      <PageHeader
        title="Ansible"
        description="Configure any Linux VPS through a verified SSH connection and reusable generic profiles."
      />
      <Card className="mb-5">
        <CardHeader>
          <CardTitle>Target VPS</CardTitle>
          <CardDescription>
            The private key or password stays encrypted in CloudForge and is never copied to the
            server.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <Field label="Saved target">
            <Select value={selectedTargetId} onChange={(event) => selectTarget(event.target.value)}>
              <option value="">New target…</option>
              {(savedTargets.data ?? []).map((saved) => (
                <option key={saved.id} value={saved.id}>
                  {saved.name} · {saved.host}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Target name">
            <Input
              value={targetName}
              onChange={(event) => setTargetName(event.target.value)}
              placeholder="Production VPS"
            />
          </Field>
          <Field label="Host">
            <Input
              value={host}
              onChange={(event) => {
                setHost(event.target.value);
                setHostKeySha256('');
                actions.preflight.reset();
              }}
              placeholder="203.0.113.10"
            />
          </Field>
          <Field label="Port">
            <Input
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(event) => {
                setPort(Number(event.target.value) || 22);
                setHostKeySha256('');
                actions.preflight.reset();
              }}
            />
          </Field>
          <Field label="SSH user">
            <Input
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                actions.preflight.reset();
              }}
              placeholder="opc or ubuntu"
            />
          </Field>
          <Field label="SSH credential">
            <Select
              value={sshCredentialId}
              onChange={(event) => {
                setSshCredentialId(event.target.value);
                actions.preflight.reset();
              }}
            >
              <option value="">Select a key or password…</option>
              {credentials.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credential.name} · {credential.kind === 'ssh' ? 'key' : 'password'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Server identity">
            <Button
              className="w-full"
              variant="outline"
              disabled={!host || actions.inspect.isPending}
              onClick={inspect}
            >
              {actions.inspect.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Fingerprint className="size-4" />
              )}
              {hostKeySha256 ? 'Fingerprint trusted' : 'Inspect host'}
            </Button>
          </Field>
          <div className="flex items-end gap-2">
            <Button
              className="flex-1"
              disabled={
                !connected ||
                !targetName ||
                targetActions.create.isPending ||
                targetActions.update.isPending
              }
              onClick={saveTarget}
            >
              <Save className="size-4" /> Save target
            </Button>
            {selectedTargetId ? (
              <Button
                variant="destructive"
                size="icon"
                onClick={deleteTarget}
                aria-label="Delete target"
              >
                <Trash2 className="size-4" />
              </Button>
            ) : null}
          </div>
          {hostKeySha256 ? (
            <div className="md:col-span-2 xl:col-span-6">
              <p className="text-warning break-all text-xs">
                Verify this fingerprint using the VPS provider console before trusting it:{' '}
                {hostKeySha256}
              </p>
              {selectedTargetId &&
              savedTargets.data?.find((item) => item.id === selectedTargetId)?.lastPreflightAt ? (
                <p className="text-muted-foreground mt-1 text-xs">
                  Last checked{' '}
                  {new Date(
                    savedTargets.data.find((item) => item.id === selectedTargetId)!
                      .lastPreflightAt!,
                  ).toLocaleString()}
                </p>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {report ? (
        <PreflightReport report={report} onRepair={repair} repairing={actions.repair.isPending} />
      ) : null}

      <Tabs defaultValue="profiles">
        <TabsList>
          <TabsTrigger value="profiles">Playbooks</TabsTrigger>
          <TabsTrigger value="nginx">Nginx domains</TabsTrigger>
        </TabsList>
        <TabsContent value="profiles">
          <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
            <Card>
              <CardHeader>
                <CardTitle>Generic profile</CardTitle>
                <CardDescription>
                  Check readiness, review any blockers, and explicitly prepare the VPS before a run.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2">
                  {(profiles.data ?? []).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setProfileId(item.id);
                        setVariables({});
                        actions.preflight.reset();
                      }}
                      className={`rounded-lg border p-4 text-left transition-colors ${item.id === profileId ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'}`}
                    >
                      <p className="font-medium">{item.name}</p>
                      <p className="text-muted-foreground mt-1 text-xs">{item.description}</p>
                    </button>
                  ))}
                </div>
                {profile?.variables.map((spec) => (
                  <Field key={spec.key} label={spec.label}>
                    <Input
                      type={spec.secret ? 'password' : spec.type === 'number' ? 'number' : 'text'}
                      value={displayValue(variables[spec.key] ?? spec.defaultValue)}
                      onChange={(event) => {
                        setVariables((current) => ({
                          ...current,
                          [spec.key]:
                            spec.type === 'number'
                              ? Number(event.target.value)
                              : event.target.value,
                        }));
                        actions.preflight.reset();
                      }}
                    />
                    {spec.description ? (
                      <p className="text-muted-foreground text-xs">{spec.description}</p>
                    ) : null}
                  </Field>
                ))}
                <div className="flex flex-wrap gap-2">
                  <Button disabled={!connected || busy || !profileReady} onClick={runProfile}>
                    {actions.run.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Play className="size-4" />
                    )}
                    Run {profile?.name ?? 'profile'}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!connected || busy}
                    onClick={() => preflight()}
                  >
                    {actions.preflight.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="size-4" />
                    )}
                    Check readiness
                  </Button>
                  <Badge variant={profileReady ? 'success' : 'secondary'}>
                    {profileReady ? 'Ready to run' : 'Readiness check required'}
                  </Badge>
                </div>
              </CardContent>
            </Card>
            <Output lines={logs.lines} busy={busy} cancel={() => actions.cancel.mutate()} />
          </div>
        </TabsContent>
        <TabsContent value="nginx">
          <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Add or update a domain</CardTitle>
                  <CardDescription>
                    CloudForge writes only its own config file, runs nginx -t, rolls back on
                    failure, and reloads on success.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 md:grid-cols-2">
                  <Field label="Domain">
                    <Input
                      value={domain}
                      onChange={(event) => setDomain(event.target.value)}
                      placeholder="app.example.com"
                    />
                  </Field>
                  <Field label="Upstream host">
                    <Input
                      value={upstreamHost}
                      onChange={(event) => setUpstreamHost(event.target.value)}
                    />
                  </Field>
                  <Field label="Upstream port">
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      value={upstreamPort}
                      onChange={(event) => setUpstreamPort(Number(event.target.value))}
                    />
                  </Field>
                  <div className="flex items-end gap-3 pb-2">
                    <Switch
                      checked={websocket}
                      onCheckedChange={setWebsocket}
                      id="nginx-websocket"
                    />
                    <Label htmlFor="nginx-websocket">WebSocket headers</Label>
                  </div>
                  <div className="flex gap-2 md:col-span-2">
                    <Button
                      disabled={!connected || !domain || busy || !nginxReady}
                      onClick={saveSite}
                    >
                      {actions.upsert.isPending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Play className="size-4" />
                      )}
                      Validate and apply
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!connected || busy}
                      onClick={() => preflight('nginx')}
                    >
                      <ShieldCheck className="size-4" />
                      Check Nginx readiness
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!connected || actions.sites.isPending}
                      onClick={refreshSites}
                    >
                      {actions.sites.isPending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <RefreshCw className="size-4" />
                      )}
                      Load managed sites
                    </Button>
                  </div>
                </CardContent>
              </Card>
              {(actions.sites.data ?? []).map((site) => (
                <Card key={site.domain}>
                  <CardContent className="flex items-center justify-between gap-3 py-4">
                    <div>
                      <p className="font-medium">{site.domain}</p>
                      <p className="text-muted-foreground text-xs">
                        → {site.upstreamHost}:{site.upstreamPort}
                        {site.websocket ? ' · WebSocket' : ''}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy || !nginxReady}
                      onClick={() => removeSite(site)}
                    >
                      <Trash2 className="size-4" />
                      Remove
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
            <Output lines={logs.lines} busy={busy} cancel={() => actions.cancel.mutate()} />
          </div>
        </TabsContent>
      </Tabs>
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function displayValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
}

function PreflightReport({
  report,
  onRepair,
  repairing,
}: {
  report: VpsPreflightReport;
  onRepair: () => void;
  repairing: boolean;
}): JSX.Element {
  const summary =
    report.status === 'ready'
      ? { label: 'Ready', variant: 'success' as const, icon: CheckCircle2 }
      : report.status === 'needs-repair'
        ? { label: 'Action required', variant: 'warning' as const, icon: AlertTriangle }
        : { label: 'Blocked', variant: 'destructive' as const, icon: XCircle };
  const SummaryIcon = summary.icon;
  return (
    <Card className="mb-5">
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            VPS readiness{' '}
            <Badge variant={summary.variant}>
              <SummaryIcon className="size-3" />
              {summary.label}
            </Badge>
          </CardTitle>
          <CardDescription>
            {report.facts.hostname} · {report.facts.osName} {report.facts.osVersion} ·{' '}
            {report.facts.architecture} · {report.facts.memoryMb} MB RAM · {report.facts.diskFreeMb}{' '}
            MB free
          </CardDescription>
        </div>
        {report.status === 'needs-repair' ? (
          <Button variant="outline" disabled={repairing} onClick={onRepair}>
            {repairing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Wrench className="size-4" />
            )}
            Prepare VPS
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {report.checks.map((check) => (
          <div key={check.id} className="rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{check.label}</p>
              <Badge variant={checkVariant(check.status)}>{check.status}</Badge>
            </div>
            <p className="text-muted-foreground mt-1 text-xs">{check.message}</p>
          </div>
        ))}
        {report.repairPackages.length ? (
          <p className="text-muted-foreground text-xs md:col-span-2 xl:col-span-3">
            Proposed packages: {report.repairPackages.join(', ')}. CloudForge asks for confirmation
            before making changes.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function checkVariant(
  status: VpsPreflightReport['checks'][number]['status'],
): 'success' | 'warning' | 'destructive' {
  if (status === 'ready') return 'success';
  if (status === 'blocked') return 'destructive';
  return 'warning';
}

function Output({
  lines,
  busy,
  cancel,
}: {
  lines: string[];
  busy: boolean;
  cancel: () => void;
}): JSX.Element {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>Live output</CardTitle>
          <CardDescription>Real Ansible and validation stages from the VPS.</CardDescription>
        </div>
        {busy ? (
          <Button size="sm" variant="outline" onClick={cancel}>
            <Square className="size-3.5" />
            Cancel
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        <LogTerminal
          lines={lines}
          className="h-[520px]"
          emptyMessage="Run a profile or Nginx operation to see progress."
        />
      </CardContent>
    </Card>
  );
}
