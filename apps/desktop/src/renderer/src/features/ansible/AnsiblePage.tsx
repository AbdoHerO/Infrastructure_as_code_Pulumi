import { useMemo, useState, type ReactNode } from 'react';
import { Fingerprint, Loader2, Play, RefreshCw, ServerCog, Square, Trash2 } from 'lucide-react';
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
import type { NginxSite } from '@cloudforge/core';
import type { SshTargetRequest } from '@shared/ipc/contract.js';
import { PageHeader } from '../../components/PageHeader.js';
import { useSshCredentials } from '../deployments/useDeployments.js';
import { useAnsibleActions, useAnsibleLogs, useAnsibleProfiles } from './useAnsible.js';

export function AnsiblePage(): JSX.Element {
  const streamId = useMemo(() => crypto.randomUUID(), []);
  const profiles = useAnsibleProfiles();
  const credentials = useSshCredentials();
  const actions = useAnsibleActions(streamId);
  const logs = useAnsibleLogs(streamId);
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState('opc');
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
    actions.bootstrap.isPending ||
    actions.run.isPending ||
    actions.upsert.isPending ||
    actions.remove.isPending;
  const fail = (error: Error): void => {
    toast.error(error.message);
  };
  const refreshSites = (): void => actions.sites.mutate(target, { onError: fail });

  const inspect = (): void =>
    actions.inspect.mutate(
      { host, port },
      {
        onSuccess: ({ fingerprint }) => setHostKeySha256(fingerprint),
        onError: fail,
      },
    );
  const checkRuntime = (): void => actions.status.mutate(target, { onError: fail });
  const bootstrap = (): void => {
    logs.clear();
    actions.bootstrap.mutate(target, {
      onSuccess: () => toast.success('Ansible is ready'),
      onError: fail,
    });
  };
  const runProfile = (): void => {
    if (!profile) return;
    logs.clear();
    const values = Object.fromEntries(
      profile.variables.map((spec) => [spec.key, variables[spec.key] ?? spec.defaultValue]),
    );
    actions.run.mutate(
      { ...target, profileId: profile.id, variables: values },
      {
        onSuccess: ({ summary }) => toast.success(summary),
        onError: fail,
      },
    );
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
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <Field label="Host">
            <Input
              value={host}
              onChange={(event) => {
                setHost(event.target.value);
                setHostKeySha256('');
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
              }}
            />
          </Field>
          <Field label="SSH user">
            <Input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="opc or ubuntu"
            />
          </Field>
          <Field label="SSH credential">
            <Select
              value={sshCredentialId}
              onChange={(event) => setSshCredentialId(event.target.value)}
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
          {hostKeySha256 ? (
            <p className="text-warning break-all text-xs md:col-span-2 xl:col-span-5">
              Confirm this fingerprint belongs to your VPS: {hostKeySha256}
            </p>
          ) : null}
        </CardContent>
      </Card>

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
                  Running a profile automatically installs an isolated Ansible runtime when needed.
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
                      onChange={(event) =>
                        setVariables((current) => ({
                          ...current,
                          [spec.key]:
                            spec.type === 'number'
                              ? Number(event.target.value)
                              : event.target.value,
                        }))
                      }
                    />
                    {spec.description ? (
                      <p className="text-muted-foreground text-xs">{spec.description}</p>
                    ) : null}
                  </Field>
                ))}
                <div className="flex flex-wrap gap-2">
                  <Button disabled={!connected || busy} onClick={runProfile}>
                    {actions.run.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Play className="size-4" />
                    )}
                    Run {profile?.name ?? 'profile'}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!connected || actions.status.isPending}
                    onClick={checkRuntime}
                  >
                    <ServerCog className="size-4" />
                    Check runtime
                  </Button>
                  {actions.status.data ? (
                    <Badge variant={actions.status.data.installed ? 'success' : 'secondary'}>
                      {actions.status.data.installed
                        ? actions.status.data.version
                        : 'Ansible not installed'}
                    </Badge>
                  ) : null}
                  {actions.status.data && !actions.status.data.installed ? (
                    <Button variant="outline" disabled={busy} onClick={bootstrap}>
                      Install Ansible
                    </Button>
                  ) : null}
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
                    <Button disabled={!connected || !domain || busy} onClick={saveSite}>
                      {actions.upsert.isPending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Play className="size-4" />
                      )}
                      Validate and apply
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
                      disabled={busy}
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
