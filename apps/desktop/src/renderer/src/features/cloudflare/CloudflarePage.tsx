import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, Save, Shield, Trash2, Zap } from 'lucide-react';
import type {
  CloudflareDnsRecord,
  CloudflareDnsBatchAction,
  CloudflareDnsRecordInput,
  CloudflareDnsType,
  CloudflarePageRule,
  CloudflareRedirectRule,
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
  toast,
} from '@cloudforge/ui';
import { PageHeader } from '../../components/PageHeader.js';
import { invoke, subscribe } from '../../lib/ipc.js';
import { useCredentials } from '../secrets/useCredentials.js';
import { useSettings } from '../settings/useSettings.js';
import {
  cloudflareKey,
  useCloudflareDashboard,
  useCloudflareDns,
  useCloudflareZoneSettings,
  useCloudflareZones,
  useDeleteCloudflareDns,
  useSaveCloudflareDns,
  useUpdateCloudflareZoneSettings,
} from './useCloudflare.js';

const DNS_TYPES: readonly CloudflareDnsType[] = [
  'A',
  'AAAA',
  'CNAME',
  'TXT',
  'MX',
  'SRV',
  'CAA',
  'NS',
  'PTR',
  'HTTPS',
  'TLSA',
  'SSHFP',
  'URI',
  'SVCB',
];
const EMPTY_RECORD: CloudflareDnsRecordInput = {
  type: 'A',
  name: '',
  content: '',
  ttl: 1,
  proxied: true,
};

export function CloudflarePage(): JSX.Element {
  const allCredentials = useCredentials();
  const credentials = useMemo(
    () => allCredentials.data?.filter((item) => item.kind === 'cloudflare') ?? [],
    [allCredentials.data],
  );
  const [credentialId, setCredentialId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const zones = useCloudflareZones(credentialId);
  const dashboard = useCloudflareDashboard(credentialId, zoneId, zones.isSuccess);
  const client = useQueryClient();
  useEffect(() => {
    if (!credentialId && credentials[0]) setCredentialId(credentials[0].id);
  }, [credentialId, credentials]);
  useEffect(() => {
    if (zoneId && zones.data?.some((zone) => zone.id === zoneId)) return;
    setZoneId(zones.data?.[0]?.id ?? '');
  }, [zoneId, zones.data]);
  useEffect(
    () =>
      subscribe('cloudflare:changed', ({ reason }) => {
        void client.invalidateQueries({ queryKey: ['cloudflare'] });
        if (reason !== 'synchronized') toast.info('Cloudflare changed; live data was refreshed');
      }),
    [client],
  );
  return (
    <div className="space-y-6">
      <PageHeader
        title="Cloudflare"
        description="Manage account zones, DNS, security, SSL, caching and edge services without exposing API tokens."
      />
      <Card>
        <CardContent className="grid gap-4 pt-6 md:grid-cols-[1fr_1fr_auto]">
          <div>
            <Label>Cloudflare credential</Label>
            <Select
              value={credentialId}
              onChange={(event) => {
                setCredentialId(event.target.value);
                setZoneId('');
              }}
            >
              <option value="">Select credential</option>
              {credentials.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Zone</Label>
            <Select value={zoneId} onChange={(event) => setZoneId(event.target.value)}>
              <option value="">All zones</option>
              {zones.data?.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.name}
                </option>
              ))}
            </Select>
          </div>
          <Button
            className="mt-6"
            variant="outline"
            disabled={!credentialId}
            onClick={() => {
              void invoke('cloudflare:test', { credentialId })
                .then((value) => toast.success(value.message))
                .catch((error: Error) => toast.error(error.message));
            }}
          >
            <Zap className="size-4" /> Test connection
          </Button>
        </CardContent>
      </Card>
      {!credentialId ? (
        <Empty />
      ) : (
        <Tabs defaultValue="dashboard">
          <TabsList className="flex h-auto flex-wrap justify-start">
            <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
            <TabsTrigger value="zones">Zones</TabsTrigger>
            <TabsTrigger value="dns">DNS</TabsTrigger>
            <TabsTrigger value="ssl">SSL & Cache</TabsTrigger>
            <TabsTrigger value="security">Security</TabsTrigger>
            <TabsTrigger value="analytics">Analytics</TabsTrigger>
            <TabsTrigger value="rules">Page Rules</TabsTrigger>
            <TabsTrigger value="redirects">Redirect Rules</TabsTrigger>
            <TabsTrigger value="platform">Workers · R2 · Access</TabsTrigger>
          </TabsList>
          <TabsContent value="dashboard">
            <Dashboard data={dashboard.data} />
          </TabsContent>
          <TabsContent value="zones">
            <Zones credentialId={credentialId} zones={zones.data ?? []} onSelect={setZoneId} />
          </TabsContent>
          <TabsContent value="dns">
            <Dns
              credentialId={credentialId}
              zoneId={zoneId}
              zoneName={zones.data?.find((zone) => zone.id === zoneId)?.name ?? ''}
            />
          </TabsContent>
          <TabsContent value="ssl">
            <ZoneConfiguration credentialId={credentialId} zoneId={zoneId} />
          </TabsContent>
          <TabsContent value="security">
            <SecurityPanel credentialId={credentialId} zoneId={zoneId} />
          </TabsContent>
          <TabsContent value="analytics">
            <AnalyticsPanel credentialId={credentialId} zoneId={zoneId} />
          </TabsContent>
          <TabsContent value="rules">
            <PageRules credentialId={credentialId} zoneId={zoneId} />
          </TabsContent>
          <TabsContent value="redirects">
            <RedirectRules credentialId={credentialId} zoneId={zoneId} />
          </TabsContent>
          <TabsContent value="platform">
            <Platform
              credentialId={credentialId}
              zoneId={zoneId}
              accountId={zones.data?.find((zone) => zone.id === zoneId)?.accountId ?? ''}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function Empty(): JSX.Element {
  return (
    <Card>
      <CardContent className="flex min-h-60 flex-col items-center justify-center gap-3">
        <Cloud className="text-muted-foreground size-10" />
        <p className="font-medium">Add or select a Cloudflare credential</p>
        <p className="text-muted-foreground text-sm">
          Create an API Token credential under Secrets; the token never reaches this page.
        </p>
      </CardContent>
    </Card>
  );
}

function Dashboard({
  data,
}: {
  data: Awaited<ReturnType<typeof invoke<'cloudflare:dashboard'>>> | undefined;
}): JSX.Element {
  const metrics = data
    ? [
        ['Account', data.account.name],
        ['Email', data.account.email ?? 'Unavailable'],
        ['Connected', data.connected ? 'Yes' : 'No'],
        ['API', data.apiStatus],
        ['Plan', data.plan],
        ['Zones', data.zones],
        ['DNS records', data.dnsRecords ?? 'Unavailable'],
        ['Proxied', data.proxiedRecords ?? 'Unavailable'],
        ['SSL mode', data.sslMode],
        ['Firewall rules', data.firewallRules ?? 'Unavailable'],
        ['Page rules', data.pageRules ?? 'Unavailable'],
        ['Cache', data.cacheStatus],
        ['Last sync', new Date(data.lastSynchronization).toLocaleString()],
      ]
    : [];
  return (
    <div className="space-y-4">
      {data?.warnings.length ? (
        <Card className="border-amber-300 bg-amber-50/50">
          <CardHeader>
            <CardTitle className="text-base">Limited Cloudflare permissions</CardTitle>
            <CardDescription>
              The credential can connect, but some dashboard capabilities are unavailable.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {data.warnings.map((warning) => (
              <p key={warning}>• {warning}</p>
            ))}
          </CardContent>
        </Card>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {metrics.map(([label, value]) => (
          <Card key={String(label)}>
            <CardHeader className="pb-2">
              <CardDescription>{label}</CardDescription>
              <CardTitle className="text-lg">{String(value)}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  );
}

function Zones({
  credentialId,
  zones,
  onSelect,
}: {
  credentialId: string;
  zones: readonly {
    id: string;
    name: string;
    status: string;
    plan: string;
    developmentMode: number;
    nameServers: readonly string[];
    createdAt: string;
  }[];
  onSelect: (id: string) => void;
}): JSX.Element {
  const { data: settings } = useSettings();
  const client = useQueryClient();
  const [zoneName, setZoneName] = useState('');
  const create = useMutation({
    mutationFn: () => invoke('cloudflare:createZone', { credentialId, name: zoneName }),
    onSuccess: (zone) => {
      setZoneName('');
      onSelect(zone.id);
      void client.invalidateQueries({ queryKey: cloudflareKey(credentialId) });
      toast.success('Cloudflare zone added');
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (zoneId: string) => invoke('cloudflare:deleteZone', { credentialId, zoneId }),
    onSuccess: () => client.invalidateQueries({ queryKey: cloudflareKey(credentialId) }),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Zones</CardTitle>
        <CardDescription>Zones visible to the selected API token.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="border-border mb-5 grid gap-3 rounded-md border p-4 md:grid-cols-[1fr_auto]">
          <div>
            <Label>Add zone</Label>
            <Input
              placeholder="example.com"
              value={zoneName}
              onChange={(event) => setZoneName(event.target.value)}
            />
          </div>
          <Button
            className="mt-6"
            disabled={!zoneName || create.isPending}
            onClick={() => create.mutate()}
          >
            Add zone
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Domain</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Nameservers</TableHead>
              <TableHead>Created</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {zones.map((zone) => (
              <TableRow key={zone.id}>
                <TableCell className="font-medium">
                  {zone.name}
                  <p className="text-muted-foreground text-xs">{zone.id}</p>
                </TableCell>
                <TableCell>
                  <Badge variant={zone.status === 'active' ? 'success' : 'secondary'}>
                    {zone.status}
                  </Badge>
                </TableCell>
                <TableCell>{zone.plan}</TableCell>
                <TableCell className="max-w-60 text-xs">{zone.nameServers.join(', ')}</TableCell>
                <TableCell>
                  {zone.createdAt ? new Date(zone.createdAt).toLocaleDateString() : '—'}
                </TableCell>
                <TableCell className="space-x-2 text-right">
                  <Button size="sm" variant="outline" onClick={() => onSelect(zone.id)}>
                    Open
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      onSelect(zone.id);
                      void client.invalidateQueries({ queryKey: cloudflareKey(credentialId) });
                      toast.success(`${zone.name} synchronized`);
                    }}
                  >
                    Sync
                  </Button>
                  <Button
                    size="icon"
                    variant="destructive"
                    aria-label={`Delete ${zone.name}`}
                    onClick={() => {
                      if (
                        settings?.cloudflare.confirmDelete !== false &&
                        !window.confirm(
                          `Delete Cloudflare zone ${zone.name}? This removes it from Cloudflare.`,
                        )
                      )
                        return;
                      remove.mutate(zone.id);
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Dns({
  credentialId,
  zoneId,
  zoneName,
}: {
  credentialId: string;
  zoneId: string;
  zoneName: string;
}): JSX.Element {
  const { data: settings } = useSettings();
  const records = useCloudflareDns(credentialId, zoneId);
  const save = useSaveCloudflareDns(credentialId, zoneId);
  const remove = useDeleteCloudflareDns(credentialId, zoneId);
  const [draft, setDraft] = useState<CloudflareDnsRecordInput>(EMPTY_RECORD);
  const [editing, setEditing] = useState<string>();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'ALL' | CloudflareDnsType>('ALL');
  const [sort, setSort] = useState<'name' | 'type' | 'modified'>('name');
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [batchTtl, setBatchTtl] = useState(300);
  const [automaticDomain, setAutomaticDomain] = useState('');
  const [automaticIp, setAutomaticIp] = useState('');
  const automaticDns = useMutation({
    mutationFn: () =>
      invoke('cloudflare:ensureDns', {
        credentialId,
        zoneId,
        domain: automaticDomain,
        expectedIp: automaticIp,
      }),
    onSuccess: (status) => {
      void records.refetch();
      toast.success(
        status.status === 'propagated'
          ? 'DNS record created and propagated'
          : 'DNS record created; propagation is still pending',
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const batch = useMutation({
    mutationFn: (action: CloudflareDnsBatchAction) =>
      invoke('cloudflare:batchDnsRecords', { credentialId, zoneId, action }),
    onSuccess: ({ changed }) => {
      setSelected([]);
      void records.refetch();
      toast.success(`Updated ${changed} DNS record(s)`);
    },
    onError: (error) => toast.error(error.message),
  });
  const submit = (): void => {
    save.mutate(
      { ...(editing ? { recordId: editing } : {}), input: draft },
      {
        onSuccess: () => {
          toast.success(editing ? 'DNS record updated' : 'DNS record created');
          setDraft(EMPTY_RECORD);
          setEditing(undefined);
        },
        onError: (error) => toast.error(error.message),
      },
    );
  };
  const edit = (record: CloudflareDnsRecord): void => {
    setEditing(record.id);
    setDraft({
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: record.ttl,
      proxied: record.proxied,
      comment: record.comment,
      tags: record.tags,
      priority: record.priority,
    });
  };
  const filtered = [...(records.data ?? [])]
    .filter(
      (record) =>
        (typeFilter === 'ALL' || record.type === typeFilter) &&
        `${record.type} ${record.name} ${record.content} ${record.comment} ${record.tags.join(' ')}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((left, right) =>
      sort === 'modified'
        ? right.modifiedAt.localeCompare(left.modifiedAt)
        : String(left[sort]).localeCompare(String(right[sort])),
    );
  if (!zoneId) return <NeedZone />;
  return (
    <div className="space-y-4">
      {records.isError ? (
        <Card className="border-red-300 bg-red-50/50">
          <CardHeader>
            <CardTitle className="text-base">DNS access unavailable</CardTitle>
            <CardDescription>{records.error.message}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            Grant this token Zone → DNS → Read to list records and Zone → DNS → Edit to create,
            update, or delete them.
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Automatic DNS wizard</CardTitle>
          <CardDescription>
            Create or update the matching A/AAAA record, then wait for public propagation using your
            Cloudflare settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <div>
            <Label>Domain</Label>
            <Input
              placeholder="app.example.com"
              value={automaticDomain}
              onChange={(event) => setAutomaticDomain(event.target.value)}
            />
          </div>
          <div>
            <Label>VPS public IP</Label>
            <Input
              placeholder="203.0.113.10"
              value={automaticIp}
              onChange={(event) => setAutomaticIp(event.target.value)}
            />
          </div>
          <Button
            className="mt-6"
            disabled={automaticDns.isPending}
            onClick={() => automaticDns.mutate()}
          >
            {automaticDns.isPending ? 'Waiting for propagation…' : 'Create · verify · propagate'}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>DNS templates</CardTitle>
          <CardDescription>
            Start with a safe generic record, then review the generated name and destination.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {[
            ['Laravel', 'A', 'app', true],
            ['Node', 'A', 'node', true],
            ['Next.js', 'CNAME', 'www', true],
            ['WordPress', 'A', '', true],
            ['Mail', 'MX', '', false],
            ['API', 'A', 'api', true],
            ['Subdomain', 'CNAME', 'subdomain', true],
            ['Load Balancer', 'CNAME', 'app', true],
          ].map(([label, type, prefix, proxied]) => (
            <Button
              key={String(label)}
              size="sm"
              variant="outline"
              onClick={() =>
                setDraft({
                  type: type as CloudflareDnsType,
                  name: prefix ? `${prefix}.${zoneName}` : zoneName,
                  content:
                    type === 'MX' ? `mail.${zoneName}` : type === 'CNAME' ? zoneName : automaticIp,
                  ttl: 1,
                  proxied: Boolean(proxied),
                  comment: `${label} template managed by CloudForge`,
                  ...(type === 'MX' ? { priority: 10 } : {}),
                })
              }
            >
              {label}
            </Button>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{editing ? 'Edit DNS record' : 'Create DNS record'}</CardTitle>
          <CardDescription>
            Validated by the Cloudflare application service before it reaches the API.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-6">
          <div>
            <Label>Type</Label>
            <Select
              value={draft.type}
              onChange={(event) => {
                const type = event.target.value as CloudflareDnsType;
                const needsPriority = type === 'MX' || type === 'URI';
                setDraft({
                  ...draft,
                  type,
                  proxied: ['A', 'AAAA', 'CNAME'].includes(type) ? draft.proxied : false,
                  priority: needsPriority ? (draft.priority ?? 10) : null,
                });
              }}
            >
              {DNS_TYPES.map((type) => (
                <option key={type}>{type}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Name</Label>
            <Input
              value={draft.name}
              placeholder="@, www, or app.example.com"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="md:col-span-2">
            <Label>Content</Label>
            <Input
              value={draft.content}
              placeholder={dnsContentPlaceholder(draft.type)}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            />
          </div>
          <div>
            <Label>TTL</Label>
            <Input
              type="number"
              value={draft.ttl}
              onChange={(e) => setDraft({ ...draft, ttl: Number(e.target.value) })}
            />
          </div>
          <div>
            <Label>Priority</Label>
            <Input
              type="number"
              placeholder="Required for MX/URI"
              value={draft.priority ?? ''}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  priority: event.target.value ? Number(event.target.value) : null,
                })
              }
            />
          </div>
          <div className="flex items-end gap-3">
            <Switch
              checked={draft.proxied}
              onCheckedChange={(proxied) => setDraft({ ...draft, proxied })}
            />
            <Label className="pb-2">Proxied</Label>
          </div>
          <div className="md:col-span-2">
            <Label>Comment</Label>
            <Input
              value={draft.comment ?? ''}
              onChange={(e) => setDraft({ ...draft, comment: e.target.value })}
            />
          </div>
          <div className="md:col-span-2">
            <Label>Tags (comma separated)</Label>
            <Input
              value={draft.tags?.join(', ') ?? ''}
              onChange={(e) => setDraft({ ...draft, tags: e.target.value.split(',') })}
            />
          </div>
          <div className="flex items-end gap-2 md:col-span-2">
            <Button disabled={save.isPending || records.isError} onClick={submit}>
              <Save className="size-4" /> {editing ? 'Apply update' : 'Create'}
            </Button>
            {editing ? (
              <Button
                variant="outline"
                onClick={() => {
                  setDraft(EMPTY_RECORD);
                  setEditing(undefined);
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>DNS records</CardTitle>
            <CardDescription>{filtered.length} records</CardDescription>
          </div>
          <div className="flex gap-2">
            <Input
              className="w-64"
              placeholder="Search records"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select
              className="w-28"
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value as 'ALL' | CloudflareDnsType)}
            >
              <option value="ALL">All types</option>
              {DNS_TYPES.map((type) => (
                <option key={type}>{type}</option>
              ))}
            </Select>
            <Select
              className="w-32"
              value={sort}
              onChange={(event) => setSort(event.target.value as typeof sort)}
            >
              <option value="name">Sort: name</option>
              <option value="type">Sort: type</option>
              <option value="modified">Sort: modified</option>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{selected.length} selected</Badge>
            <Button
              size="sm"
              variant="outline"
              disabled={!selected.length}
              onClick={() => batch.mutate({ kind: 'proxy', recordIds: selected, enabled: true })}
            >
              Enable proxy
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!selected.length}
              onClick={() => batch.mutate({ kind: 'proxy', recordIds: selected, enabled: false })}
            >
              Disable proxy
            </Button>
            <Input
              className="w-24"
              type="number"
              value={batchTtl}
              onChange={(event) => setBatchTtl(Number(event.target.value))}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!selected.length}
              onClick={() => batch.mutate({ kind: 'ttl', recordIds: selected, ttl: batchTtl })}
            >
              Set TTL
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={!selected.length}
              onClick={() => {
                if (
                  settings?.cloudflare.confirmDelete !== false &&
                  !window.confirm(`Delete ${selected.length} Cloudflare DNS record(s)?`)
                )
                  return;
                batch.mutate({ kind: 'delete', recordIds: selected });
              }}
            >
              Delete selected
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void invoke('app:copyText', { text: JSON.stringify(filtered, null, 2) }).then(() =>
                  toast.success('DNS records exported to clipboard'),
                )
              }
            >
              Export JSON
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <input
                    aria-label="Select all DNS records"
                    type="checkbox"
                    checked={
                      filtered.length > 0 &&
                      filtered.every((record) => selected.includes(record.id))
                    }
                    onChange={(event) =>
                      setSelected(event.target.checked ? filtered.map((record) => record.id) : [])
                    }
                  />
                </TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Content</TableHead>
                <TableHead>TTL</TableHead>
                <TableHead>Proxy</TableHead>
                <TableHead>Modified</TableHead>
                <TableHead>Metadata</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((record) => (
                <TableRow key={record.id}>
                  <TableCell>
                    <input
                      aria-label={`Select ${record.name}`}
                      type="checkbox"
                      checked={selected.includes(record.id)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, record.id]
                            : current.filter((id) => id !== record.id),
                        )
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{record.type}</Badge>
                  </TableCell>
                  <TableCell>{record.name}</TableCell>
                  <TableCell className="max-w-72 truncate font-mono text-xs">
                    {record.content}
                  </TableCell>
                  <TableCell>{record.ttl === 1 ? 'Auto' : record.ttl}</TableCell>
                  <TableCell>{record.proxied ? 'Proxied' : 'DNS only'}</TableCell>
                  <TableCell>
                    {record.modifiedAt ? new Date(record.modifiedAt).toLocaleString() : '—'}
                  </TableCell>
                  <TableCell className="max-w-48 text-xs">
                    <p>{record.comment || '—'}</p>
                    <p className="text-muted-foreground">{record.tags.join(', ') || 'No tags'}</p>
                    <p className="text-muted-foreground">
                      Created {record.createdAt ? new Date(record.createdAt).toLocaleString() : '—'}
                    </p>
                  </TableCell>
                  <TableCell>
                    <Badge variant="success">active</Badge>
                  </TableCell>
                  <TableCell className="space-x-2 text-right">
                    <Button size="sm" variant="outline" onClick={() => edit(record)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditing(undefined);
                        setDraft({
                          type: record.type,
                          name: record.name,
                          content: record.content,
                          ttl: record.ttl,
                          proxied: record.proxied,
                          comment: record.comment,
                          tags: record.tags,
                          priority: record.priority,
                        });
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                    >
                      Duplicate
                    </Button>
                    <Button
                      size="icon"
                      variant="destructive"
                      onClick={() => {
                        if (
                          settings?.cloudflare.confirmDelete !== false &&
                          !window.confirm(`Delete DNS record ${record.name}?`)
                        )
                          return;
                        remove.mutate(record.id);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function ZoneConfiguration({
  credentialId,
  zoneId,
}: {
  credentialId: string;
  zoneId: string;
}): JSX.Element {
  const settings = useCloudflareZoneSettings(credentialId, zoneId);
  const update = useUpdateCloudflareZoneSettings(credentialId, zoneId);
  const purge = useMutation({
    mutationFn: () => invoke('cloudflare:purgeCache', { credentialId, zoneId }),
    onSuccess: () => toast.success('Cloudflare cache purged'),
    onError: (e) => toast.error(e.message),
  });
  if (!zoneId) return <NeedZone />;
  if (!settings.data)
    return (
      <Card>
        <CardContent className="p-6">Loading zone configuration…</CardContent>
      </Card>
    );
  const value = settings.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>SSL/TLS and caching</CardTitle>
        <CardDescription>Changes apply in place to the selected Cloudflare zone.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        <Control label="Encryption mode">
          <Select
            value={value.sslMode}
            onChange={(e) => update.mutate({ sslMode: e.target.value as typeof value.sslMode })}
          >
            <option value="off">Off</option>
            <option value="flexible">Flexible</option>
            <option value="full">Full</option>
            <option value="strict">Full (strict)</option>
          </Select>
        </Control>
        <Control label="Minimum TLS">
          <Select
            value={value.minimumTls}
            onChange={(e) =>
              update.mutate({ minimumTls: e.target.value as typeof value.minimumTls })
            }
          >
            <option>1.0</option>
            <option>1.1</option>
            <option>1.2</option>
            <option>1.3</option>
          </Select>
        </Control>
        <Toggle
          label="Always use HTTPS"
          value={value.alwaysHttps}
          change={(alwaysHttps) => update.mutate({ alwaysHttps })}
        />
        <Toggle label="TLS 1.3" value={value.tls13} change={(tls13) => update.mutate({ tls13 })} />
        <Toggle label="HSTS" value={value.hsts} change={(hsts) => update.mutate({ hsts })} />
        <Toggle
          label="Automatic HTTPS rewrites"
          value={value.automaticHttpsRewrites}
          change={(automaticHttpsRewrites) => update.mutate({ automaticHttpsRewrites })}
        />
        <Toggle
          label="Brotli compression"
          value={value.brotli}
          change={(brotli) => update.mutate({ brotli })}
        />
        <Toggle
          label="Development mode"
          value={value.developmentMode}
          change={(developmentMode) => update.mutate({ developmentMode })}
        />
        <div>
          <Button variant="destructive" disabled={purge.isPending} onClick={() => purge.mutate()}>
            Purge entire cache
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SecurityPanel({
  credentialId,
  zoneId,
}: {
  credentialId: string;
  zoneId: string;
}): JSX.Element {
  const query = useQuery({
    queryKey: [...cloudflareKey(credentialId), 'security', zoneId],
    queryFn: () => invoke('cloudflare:security', { credentialId, zoneId }),
    enabled: Boolean(zoneId),
  });
  if (!zoneId) return <NeedZone />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Shield className="mr-2 inline size-5" />
          Security (read only)
        </CardTitle>
        <CardDescription>WAF, managed rules, bot and zone security posture.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-3">
          {[
            ['WAF', query.data?.wafStatus],
            ['Security level', query.data?.securityLevel],
            ['Bot protection', query.data?.botProtection],
            [
              'Browser integrity',
              query.data ? (query.data.browserIntegrityCheck ? 'enabled' : 'disabled') : undefined,
            ],
            [
              'Under Attack Mode',
              query.data ? (query.data.underAttackMode ? 'enabled' : 'disabled') : undefined,
            ],
            ['DDoS protection', query.data?.ddosStatus],
            ['Rate limits', query.data?.rateLimits],
            ['IP lists', query.data?.ipLists],
            ['Country blocks', query.data?.countryBlocks],
          ].map(([label, value]) => (
            <div key={String(label)} className="border-border rounded-md border p-3">
              <p className="text-muted-foreground text-xs">{label}</p>
              <p className="font-medium">{value ?? 'Loading…'}</p>
            </div>
          ))}
        </div>
        {query.data?.rules.map((rule) => (
          <div key={rule.id} className="border-border rounded-md border p-3">
            <b>{rule.name}</b>
            <p className="text-muted-foreground text-sm">
              {rule.phase} · {rule.status}
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function AnalyticsPanel({
  credentialId,
  zoneId,
}: {
  credentialId: string;
  zoneId: string;
}): JSX.Element {
  const [range, setRange] = useState<'today' | 'yesterday' | '7d' | '30d'>('7d');
  const dates = analyticsDates(range);
  const query = useQuery({
    queryKey: [...cloudflareKey(credentialId), 'analytics', zoneId, range],
    queryFn: () =>
      invoke('cloudflare:analytics', {
        credentialId,
        zoneId,
        since: dates.since,
        until: dates.until,
      }),
    enabled: Boolean(zoneId),
  });
  if (!zoneId) return <NeedZone />;
  const data = query.data;
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Select
          className="w-40"
          value={range}
          onChange={(event) => setRange(event.target.value as typeof range)}
        >
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="7d">7 days</option>
          <option value="30d">30 days</option>
        </Select>
      </div>
      <div className="grid gap-4 md:grid-cols-5">
        {[
          ['Visitors', data?.visitors],
          ['Requests', data?.requests],
          ['Cached', data?.cachedRequests],
          ['Bandwidth', data ? `${(data.bandwidth / 1_000_000).toFixed(1)} MB` : undefined],
          ['Threats', data?.threats],
        ].map(([name, value]) => (
          <Card key={String(name)}>
            <CardHeader>
              <CardDescription>{name}</CardDescription>
              <CardTitle>{value ?? '—'}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Requests over time</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-44 items-end gap-2">
            {data?.series.map((item) => {
              const max = Math.max(...data.series.map((point) => point.requests), 1);
              return (
                <div key={item.date} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                  <div
                    className="bg-primary w-full rounded-t"
                    style={{ height: `${Math.max(2, (item.requests / max) * 140)}px` }}
                    title={`${item.requests} requests`}
                  />
                  <span className="text-muted-foreground truncate text-[10px]">
                    {item.date.slice(5)}
                  </span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-3">
        <Summary
          title="Countries"
          values={data?.countries.map((item) => `${item.name} · ${item.requests}`) ?? []}
        />
        <Summary
          title="Top URLs"
          values={data?.topUrls.map((item) => `${item.path} · ${item.requests}`) ?? []}
        />
        <Summary
          title="Status codes"
          values={data?.statusCodes.map((item) => `${item.status} · ${item.requests}`) ?? []}
        />
      </div>
    </div>
  );
}

function analyticsDates(range: 'today' | 'yesterday' | '7d' | '30d'): {
  since: string;
  until: string;
} {
  const now = new Date();
  if (range === 'today')
    return {
      since: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
      until: now.toISOString(),
    };
  if (range === 'yesterday')
    return {
      since: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString(),
      until: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
    };
  return {
    since: new Date(now.getTime() - (range === '30d' ? 30 : 7) * 86400000).toISOString(),
    until: now.toISOString(),
  };
}

function PageRules({
  credentialId,
  zoneId,
}: {
  credentialId: string;
  zoneId: string;
}): JSX.Element {
  const { data: settings } = useSettings();
  const client = useQueryClient();
  const [target, setTarget] = useState('');
  const [priority, setPriority] = useState(1);
  const [editing, setEditing] = useState<CloudflarePageRule>();
  const query = useQuery({
    queryKey: [...cloudflareKey(credentialId), 'pageRules', zoneId],
    queryFn: () => invoke('cloudflare:pageRules', { credentialId, zoneId }),
    enabled: Boolean(zoneId),
  });
  const save = useMutation({
    mutationFn: () =>
      invoke('cloudflare:savePageRule', {
        credentialId,
        zoneId,
        rule: {
          ...(editing ? { id: editing.id } : {}),
          target,
          priority,
          status: editing?.status ?? 'active',
          actions: editing?.actions ?? [{ id: 'always_use_https', value: 'on' }],
        },
      }),
    onSuccess: () => {
      setTarget('');
      setEditing(undefined);
      void client.invalidateQueries({ queryKey: cloudflareKey(credentialId) });
      toast.success(editing ? 'Page Rule updated' : 'Page Rule created');
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (ruleId: string) =>
      invoke('cloudflare:deletePageRule', { credentialId, zoneId, ruleId }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: cloudflareKey(credentialId) });
      toast.success('Page Rule deleted');
    },
    onError: (error) => toast.error(error.message),
  });
  if (!zoneId) return <NeedZone />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Page Rules</CardTitle>
        <CardDescription>Existing Page Rules and their priority.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="border-border mb-5 grid gap-3 rounded-md border p-4 md:grid-cols-[1fr_8rem_auto]">
          <div>
            <Label>URL pattern</Label>
            <Input
              placeholder="example.com/*"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            />
          </div>
          <div>
            <Label>Priority</Label>
            <Input
              type="number"
              min={1}
              value={priority}
              onChange={(event) => setPriority(Number(event.target.value) || 1)}
            />
          </div>
          <Button
            className="mt-6"
            disabled={!target || save.isPending}
            onClick={() => save.mutate()}
          >
            {editing ? 'Update rule' : 'Create HTTPS rule'}
          </Button>
        </div>
        {query.data?.length ? (
          query.data.map((rule) => (
            <div
              key={rule.id}
              className="border-border mb-2 flex items-center justify-between rounded-md border p-3"
            >
              <div>
                <b>{rule.target}</b>
                <p className="text-muted-foreground text-sm">
                  Priority {rule.priority} · {rule.actions.map((a) => a.id).join(', ')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={rule.status === 'active' ? 'success' : 'secondary'}>
                  {rule.status}
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditing(rule);
                    setTarget(rule.target);
                    setPriority(rule.priority);
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="icon"
                  variant="destructive"
                  onClick={() => {
                    if (
                      settings?.cloudflare.confirmDelete !== false &&
                      !window.confirm(`Delete Page Rule ${rule.target}?`)
                    )
                      return;
                    remove.mutate(rule.id);
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ))
        ) : (
          <p className="text-muted-foreground">No Page Rules found.</p>
        )}
      </CardContent>
    </Card>
  );
}

function RedirectRules({
  credentialId,
  zoneId,
}: {
  credentialId: string;
  zoneId: string;
}): JSX.Element {
  const { data: settings } = useSettings();
  const client = useQueryClient();
  const [draft, setDraft] = useState<Omit<CloudflareRedirectRule, 'id'>>({
    source: '(http.host eq "example.com")',
    destination: 'https://www.example.com',
    status: 'active',
    priority: 1,
    statusCode: 301,
    preserveQueryString: true,
  });
  const [editingId, setEditingId] = useState<string>();
  const query = useQuery({
    queryKey: [...cloudflareKey(credentialId), 'redirectRules', zoneId],
    queryFn: () => invoke('cloudflare:redirectRules', { credentialId, zoneId }),
    enabled: Boolean(zoneId),
  });
  const save = useMutation({
    mutationFn: () =>
      invoke('cloudflare:saveRedirectRule', {
        credentialId,
        zoneId,
        rule: editingId ? { ...draft, id: editingId } : draft,
      }),
    onSuccess: () => {
      setEditingId(undefined);
      void client.invalidateQueries({ queryKey: cloudflareKey(credentialId) });
      toast.success('Redirect Rule saved');
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (ruleId: string) =>
      invoke('cloudflare:deleteRedirectRule', { credentialId, zoneId, ruleId }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: cloudflareKey(credentialId) });
      toast.success('Redirect Rule deleted');
    },
    onError: (error) => toast.error(error.message),
  });
  if (!zoneId) return <NeedZone />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Redirect Rules</CardTitle>
        <CardDescription>
          Manage zone-level single redirects through the Cloudflare Rulesets API.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="border-border grid gap-3 rounded-md border p-4 md:grid-cols-2">
          <Control label="Source expression">
            <Input
              value={draft.source}
              onChange={(event) => setDraft({ ...draft, source: event.target.value })}
            />
          </Control>
          <Control label="Destination URL">
            <Input
              value={draft.destination}
              onChange={(event) => setDraft({ ...draft, destination: event.target.value })}
            />
          </Control>
          <Control label="HTTP status">
            <Select
              value={draft.statusCode}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  statusCode: Number(event.target.value) as 301 | 302 | 307 | 308,
                })
              }
            >
              <option value={301}>301</option>
              <option value={302}>302</option>
              <option value={307}>307</option>
              <option value={308}>308</option>
            </Select>
          </Control>
          <div className="flex items-center gap-5 pt-6">
            <Toggle
              label="Enabled"
              value={draft.status === 'active'}
              change={(enabled) => setDraft({ ...draft, status: enabled ? 'active' : 'disabled' })}
            />
            <Toggle
              label="Preserve query"
              value={draft.preserveQueryString}
              change={(preserveQueryString) => setDraft({ ...draft, preserveQueryString })}
            />
          </div>
          <div className="flex gap-2 md:col-span-2">
            <Button
              disabled={!draft.source.trim() || !draft.destination.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              <Save className="size-4" /> {editingId ? 'Apply update' : 'Create redirect'}
            </Button>
            {editingId ? (
              <Button variant="outline" onClick={() => setEditingId(undefined)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
        {query.data?.map((rule) => (
          <div
            key={rule.id}
            className="border-border flex items-center justify-between gap-4 rounded-md border p-3"
          >
            <div className="min-w-0">
              <p className="truncate font-mono text-xs">{rule.source}</p>
              <p className="truncate text-sm">→ {rule.destination}</p>
              <p className="text-muted-foreground text-xs">
                HTTP {rule.statusCode} ·{' '}
                {rule.preserveQueryString ? 'preserve query' : 'drop query'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant={rule.status === 'active' ? 'success' : 'secondary'}>
                {rule.status}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const { id, ...value } = rule;
                  setEditingId(id);
                  setDraft(value);
                }}
              >
                Edit
              </Button>
              <Button
                size="icon"
                variant="destructive"
                onClick={() => {
                  if (
                    settings?.cloudflare.confirmDelete !== false &&
                    !window.confirm(`Delete redirect to ${rule.destination}?`)
                  )
                    return;
                  remove.mutate(rule.id);
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Platform({
  credentialId,
  zoneId,
  accountId,
}: {
  credentialId: string;
  zoneId: string;
  accountId: string;
}): JSX.Element {
  const query = useQuery({
    queryKey: [...cloudflareKey(credentialId), 'platform', zoneId, accountId],
    queryFn: () => invoke('cloudflare:platform', { credentialId, zoneId, accountId }),
    enabled: Boolean(zoneId && accountId),
  });
  if (!zoneId) return <NeedZone />;
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Summary
        title="Workers"
        values={query.data?.workers.map((worker) => `${worker.id} · ${worker.status}`) ?? []}
      />
      <Summary
        title="Worker routes"
        values={
          query.data?.workerRoutes.map(
            (route) => `${route.pattern} · ${route.script ?? 'unassigned'}`,
          ) ?? []
        }
      />
      <Summary
        title="R2 buckets"
        values={
          query.data?.r2Buckets.map(
            (bucket) =>
              `${bucket.name} · ${bucket.objectCount ?? 'unknown'} objects · ${bucket.sizeBytes ?? 'unknown'} bytes`,
          ) ?? []
        }
      />
      <Summary
        title="Zero Trust applications"
        values={query.data?.accessApplications.map((x) => `${x.name} · ${x.domain}`) ?? []}
      />
      <Summary
        title="Zero Trust policies"
        values={
          query.data?.accessPolicies.map((policy) => `${policy.name} · ${policy.decision}`) ?? []
        }
      />
      <Summary
        title="Gateway rules"
        values={
          query.data?.gatewayRules.map(
            (rule) => `${rule.name} · ${rule.enabled ? 'enabled' : 'disabled'}`,
          ) ?? []
        }
      />
    </div>
  );
}
function Summary({ title, values }: { title: string; values: readonly string[] }): JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>Read only</CardDescription>
      </CardHeader>
      <CardContent>
        {values.length ? (
          values.map((v) => (
            <p key={v} className="border-border border-b py-2 text-sm">
              {v}
            </p>
          ))
        ) : (
          <p className="text-muted-foreground text-sm">No resources or insufficient scope.</p>
        )}
      </CardContent>
    </Card>
  );
}
function NeedZone(): JSX.Element {
  return (
    <Card>
      <CardContent className="p-8 text-center">
        <p className="font-medium">Select a zone first</p>
      </CardContent>
    </Card>
  );
}

function dnsContentPlaceholder(type: CloudflareDnsType): string {
  const placeholders: Record<CloudflareDnsType, string> = {
    A: '203.0.113.10',
    AAAA: '2001:db8::10',
    CNAME: 'target.example.com',
    TXT: 'Text or verification value',
    MX: 'mail.example.com',
    SRV: '10 5 443 target.example.com',
    CAA: '0 issue "letsencrypt.org"',
    NS: 'ns1.example.net',
    PTR: 'host.example.com',
    HTTPS: '1 . alpn="h2,h3"',
    TLSA: '3 1 1 certificate-association-data',
    SSHFP: '4 2 fingerprint',
    URI: '10 1 "https://example.com/"',
    SVCB: '1 target.example.com alpn="h2"',
  };
  return placeholders[type];
}
function Control({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  );
}
function Toggle({
  label,
  value,
  change,
}: {
  label: string;
  value: boolean;
  change: (value: boolean) => void;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between rounded-md border p-3">
      <Label>{label}</Label>
      <Switch checked={value} onCheckedChange={change} />
    </div>
  );
}
