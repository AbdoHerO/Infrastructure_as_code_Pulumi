import { useEffect, useState } from 'react';
import { AlertTriangle, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import type {
  ActivityDto,
  CloudInstance,
  InstanceFirewall,
  LiveFirewallRule,
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
  toast,
} from '@cloudforge/ui';
import { PageHeader } from '../../components/PageHeader.js';
import { useConfirmation } from '../../components/ConfirmationDialogProvider.js';
import { invoke } from '../../lib/ipc.js';
import { useProviderCredentials } from '../providers/useProviders.js';

const TEMPLATES: Record<
  string,
  { protocol: LiveFirewallRule['protocol']; from: number; to: number }
> = {
  SSH: { protocol: 'tcp', from: 22, to: 22 },
  HTTP: { protocol: 'tcp', from: 80, to: 80 },
  HTTPS: { protocol: 'tcp', from: 443, to: 443 },
  Docker: { protocol: 'tcp', from: 2376, to: 2376 },
  Kubernetes: { protocol: 'tcp', from: 6443, to: 6443 },
  MySQL: { protocol: 'tcp', from: 3306, to: 3306 },
  Postgres: { protocol: 'tcp', from: 5432, to: 5432 },
  Redis: { protocol: 'tcp', from: 6379, to: 6379 },
  Mongo: { protocol: 'tcp', from: 27017, to: 27017 },
};

export function FirewallPage(): JSX.Element {
  const confirm = useConfirmation();
  const providers = useProviderCredentials();
  const [credentialId, setCredentialId] = useState('');
  const [instanceId, setInstanceId] = useState('');
  const [instances, setInstances] = useState<CloudInstance[]>([]);
  const [firewall, setFirewall] = useState<InstanceFirewall | null>(null);
  const [draft, setDraft] = useState<LiveFirewallRule[]>([]);
  const [history, setHistory] = useState<ActivityDto[]>([]);
  const load = useMutation({
    mutationFn: () => invoke('firewall:get', { credentialId, instanceId }),
    onSuccess: (value) => {
      setFirewall(value);
      setDraft([...value.rules]);
      void invoke('activity:list', { limit: 500 }).then((items) =>
        setHistory(
          items.filter(
            (item) =>
              item.type === 'firewall.rules.updated' &&
              item.metadata.instanceId === value.instanceId,
          ),
        ),
      );
    },
  });
  const apply = useMutation({
    mutationFn: () =>
      invoke('firewall:update', {
        credentialId,
        instanceId,
        expectedRules: [...(firewall?.rules ?? [])],
        rules: draft,
      }),
    onSuccess: (value) => {
      setFirewall(value);
      setDraft([...value.rules]);
      toast.success('Firewall updated in place');
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });
  useEffect(() => {
    if (!credentialId && providers.data?.[0]) setCredentialId(providers.data[0].id);
  }, [credentialId, providers.data]);
  useEffect(() => {
    if (!credentialId) return;
    void invoke('providers:listInstances', { credentialId })
      .then(setInstances)
      .catch((error: Error) => toast.error(error.message));
  }, [credentialId]);
  const addTemplate = (name: string): void => {
    const template = TEMPLATES[name];
    if (!template) return;
    setDraft((rules) => [
      ...rules,
      {
        id: crypto.randomUUID(),
        direction: 'ingress',
        protocol: template.protocol,
        cidr: '0.0.0.0/0',
        portFrom: template.from,
        portTo: template.to,
        description: name,
        stateless: false,
      },
    ]);
  };
  const update = (id: string, patch: Partial<LiveFirewallRule>): void =>
    setDraft((rules) => rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  const warnings = firewallWarnings(draft);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Firewall"
        description="Synchronize and update per-instance cloud firewall rules without recreating infrastructure."
      />
      <Card>
        <CardContent className="grid gap-3 pt-6 md:grid-cols-3">
          <div>
            <Label>Cloud credential</Label>
            <Select
              value={credentialId}
              onChange={(event) => {
                setCredentialId(event.target.value);
                setInstanceId('');
                setFirewall(null);
              }}
            >
              <option value="">Select provider</option>
              {providers.data?.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Instance</Label>
            <Select
              value={instanceId}
              onChange={(event) => {
                setInstanceId(event.target.value);
                setFirewall(null);
              }}
            >
              <option value="">Select instance</option>
              {instances.map((instance) => (
                <option key={instance.id} value={instance.id}>
                  {instance.name} · {instance.state}
                </option>
              ))}
            </Select>
          </div>
          <Button
            className="self-end"
            disabled={!instanceId || load.isPending}
            onClick={() => load.mutate()}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Load live rules
          </Button>
        </CardContent>
      </Card>
      {firewall && (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <Info label="Instance" value={firewall.instanceName} />
            <Info label="Status" value={firewall.state} />
            <Info label="Subnet" value={firewall.subnetName} />
            <Info
              label="IPs"
              value={`${firewall.publicIp ?? 'No public IP'} / ${firewall.privateIp ?? '—'}`}
            />
          </div>
          {warnings.length > 0 && (
            <Card className="border-amber-300">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="h-4 w-4" />
                  Security warnings
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                {warnings.map((warning) => (
                  <div key={warning}>• {warning}</div>
                ))}
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Rules</CardTitle>
              <CardDescription>
                OCI Security List {firewall.securityListId}. Apply uses OCI UPDATE; the compute
                instance is not replaced.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {Object.keys(TEMPLATES).map((name) => (
                  <Button size="sm" variant="outline" key={name} onClick={() => addTemplate(name)}>
                    <Plus className="mr-1 h-3 w-3" />
                    {name}
                  </Button>
                ))}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Direction</TableHead>
                    <TableHead>Protocol</TableHead>
                    <TableHead>CIDR</TableHead>
                    <TableHead>Ports</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Stateless</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {draft.map((rule) => (
                    <TableRow key={rule.id}>
                      <TableCell>
                        <Select
                          value={rule.direction}
                          onChange={(event) =>
                            update(rule.id, {
                              direction: event.target.value as LiveFirewallRule['direction'],
                            })
                          }
                        >
                          <option value="ingress">Inbound</option>
                          <option value="egress">Outbound</option>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={rule.protocol}
                          onChange={(event) =>
                            update(rule.id, {
                              protocol: event.target.value as LiveFirewallRule['protocol'],
                            })
                          }
                        >
                          <option value="tcp">TCP</option>
                          <option value="udp">UDP</option>
                          <option value="icmp">ICMP</option>
                          <option value="all">All</option>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Input
                          value={rule.cidr}
                          onChange={(event) => update(rule.id, { cidr: event.target.value })}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Input
                            className="w-20"
                            type="number"
                            value={rule.portFrom ?? ''}
                            onChange={(event) =>
                              update(rule.id, {
                                portFrom: event.target.value ? Number(event.target.value) : null,
                              })
                            }
                          />
                          <Input
                            className="w-20"
                            type="number"
                            value={rule.portTo ?? ''}
                            onChange={(event) =>
                              update(rule.id, {
                                portTo: event.target.value ? Number(event.target.value) : null,
                              })
                            }
                          />
                        </div>
                      </TableCell>
                      <TableCell>
                        <Input
                          value={rule.description}
                          maxLength={255}
                          onChange={(event) => update(rule.id, { description: event.target.value })}
                        />
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={rule.stateless}
                          onCheckedChange={(value) => update(rule.id, { stateless: value })}
                        />
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setDraft((rules) => rules.filter((item) => item.id !== rule.id))
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex items-center justify-between">
                <Badge variant="secondary">
                  {draft.length} rules ·{' '}
                  {changed(firewall.rules, draft) ? 'Local changes' : 'Synchronized'}
                </Badge>
                <Button
                  disabled={!changed(firewall.rules, draft) || apply.isPending}
                  onClick={() => {
                    void confirm({
                      title: 'Apply live firewall rules?',
                      description:
                        'Replace the live cloud firewall rules with this exact validated set? Incorrect rules can interrupt SSH and application traffic.',
                      confirmLabel: 'Apply firewall update',
                    }).then((confirmed) => {
                      if (confirmed) apply.mutate();
                    });
                  }}
                >
                  <Save className="mr-2 h-4 w-4" />
                  Apply update
                </Button>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Change history</CardTitle>
              <CardDescription>
                Audited snapshots can be prepared for rollback through the same validated update.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {history.length === 0 ? (
                <p className="text-muted-foreground text-sm">No recorded changes.</p>
              ) : (
                history.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between rounded-md border p-3"
                  >
                    <div>
                      <div className="font-medium">
                        {typeof entry.metadata.actor === 'string'
                          ? entry.metadata.actor
                          : 'local-user'}{' '}
                        · {new Date(entry.createdAt).toLocaleString()}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {Array.isArray(entry.metadata.before) ? entry.metadata.before.length : 0} →{' '}
                        {Array.isArray(entry.metadata.after) ? entry.metadata.after.length : 0}{' '}
                        rules
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      disabled={!Array.isArray(entry.metadata.before)}
                      onClick={() => {
                        if (!Array.isArray(entry.metadata.before)) return;
                        void confirm({
                          title: 'Prepare firewall rollback?',
                          description:
                            'Load this historical snapshot into the editor for review? It will not affect the live firewall until you apply it.',
                          confirmLabel: 'Load snapshot',
                          destructive: false,
                        }).then((confirmed) => {
                          if (confirmed) setDraft(entry.metadata.before as LiveFirewallRule[]);
                        });
                      }}
                    >
                      Prepare rollback
                    </Button>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
function Info({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <Card>
      <CardContent className="py-5">
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className="truncate font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}
function changed(a: readonly LiveFirewallRule[], b: readonly LiveFirewallRule[]): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}
function firewallWarnings(rules: readonly LiveFirewallRule[]): string[] {
  const warnings: string[] = [];
  const keys = new Set<string>();
  for (const rule of rules) {
    const key = `${rule.direction}:${rule.protocol}:${rule.cidr}:${rule.portFrom}:${rule.portTo}`;
    if (keys.has(key)) warnings.push(`Duplicate rule: ${rule.description || key}`);
    keys.add(key);
    if (
      rule.direction === 'ingress' &&
      rule.cidr === '0.0.0.0/0' &&
      (rule.protocol === 'all' || rule.portFrom === 22)
    )
      warnings.push(
        rule.portFrom === 22
          ? 'SSH is open to the entire internet.'
          : 'All inbound traffic is open to the entire internet.',
      );
    if (
      rule.direction === 'ingress' &&
      rule.stateless &&
      (rule.protocol === 'tcp' || rule.protocol === 'udp')
    )
      warnings.push(
        `Stateless inbound ${rule.protocol.toUpperCase()} ${rule.portFrom ?? 'all ports'} requires a matching stateless outbound response rule. Use stateful for normal web services.`,
      );
  }
  for (let index = 0; index < rules.length; index += 1) {
    const left = rules[index];
    if (!left) continue;
    for (const right of rules.slice(index + 1)) {
      if (
        left.direction === right.direction &&
        left.protocol === right.protocol &&
        left.cidr === right.cidr &&
        rangesOverlap(left.portFrom, left.portTo, right.portFrom, right.portTo)
      )
        warnings.push(
          `Overlapping ${left.protocol.toUpperCase()} rules for ${left.cidr}: ${left.description || left.id} / ${right.description || right.id}.`,
        );
    }
  }
  return [...new Set(warnings)];
}
function rangesOverlap(
  leftFrom: number | null,
  leftTo: number | null,
  rightFrom: number | null,
  rightTo: number | null,
): boolean {
  if (leftFrom === null || leftTo === null || rightFrom === null || rightTo === null) return true;
  return leftFrom <= rightTo && rightFrom <= leftTo;
}
