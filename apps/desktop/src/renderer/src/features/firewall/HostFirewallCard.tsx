import { useEffect, useMemo, useState } from 'react';
import { Lock, LockOpen, RefreshCw, ShieldCheck } from 'lucide-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  hostFirewallAllows,
  type HostFirewallPort,
  type HostFirewallState,
  type LiveFirewallRule,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@cloudforge/ui';
import { useConfirmation } from '../../components/ConfirmationDialogProvider.js';
import { invoke } from '../../lib/ipc.js';

/** Ports most often needed on a web server, one click each. */
const QUICK: readonly { label: string; port: number }[] = [
  { label: 'HTTPS', port: 443 },
  { label: 'HTTP', port: 80 },
];

/**
 * The VPS's own firewall, next to the cloud security list.
 *
 * A port is reachable from the internet only when both allow it, and they are
 * independent: Oracle's Ubuntu images, for one, reject everything but SSH in
 * iptables even when the security list allows 443. This card reads the server's
 * firewall over SSH (the saved target matching the instance's public IP) and
 * opens or closes single ports on it — for software CloudForge does not model,
 * such as a hosting layer serving HTTPS on 443, with no Nginx route needed.
 */
export function HostFirewallCard({
  publicIp,
  providerRules,
}: {
  publicIp: string | null;
  providerRules: readonly LiveFirewallRule[];
}): JSX.Element {
  const confirm = useConfirmation();
  const targets = useQuery({
    queryKey: ['ansible:targets'],
    queryFn: () => invoke('ansible:targets', undefined),
  });
  const [targetId, setTargetId] = useState('');
  const [state, setState] = useState<HostFirewallState | null>(null);
  const [customPort, setCustomPort] = useState('');
  const [customProtocol, setCustomProtocol] = useState<'tcp' | 'udp'>('tcp');

  // The saved target whose host is this instance's public IP, when there is one.
  useEffect(() => {
    if (targetId || !targets.data) return;
    const match = targets.data.find((t) => publicIp !== null && t.host === publicIp);
    if (match) setTargetId(match.id);
  }, [publicIp, targetId, targets.data]);

  const sshPort = targets.data?.find((t) => t.id === targetId)?.port ?? 22;

  const inspect = useMutation({
    mutationFn: () => invoke('hostFirewall:inspect', { targetId }),
    onSuccess: setState,
    onError: (error) => toast.error(error.message),
  });
  const open = useMutation({
    mutationFn: (ports: HostFirewallPort[]) => invoke('hostFirewall:open', { targetId, ports }),
    onSuccess: (value, ports) => {
      setState(value);
      toast.success(`Opened ${describe(ports)} on the VPS firewall`);
    },
    onError: (error) => toast.error(error.message),
  });
  const close = useMutation({
    mutationFn: (ports: HostFirewallPort[]) => invoke('hostFirewall:close', { targetId, ports }),
    onSuccess: (value, ports) => {
      setState(value);
      toast.success(`Closed ${describe(ports)} on the VPS firewall`);
    },
    onError: (error) => toast.error(error.message),
  });

  useEffect(() => {
    setState(null);
    if (targetId) inspect.mutate();
    // Re-read whenever another target is chosen; the mutation object is stable enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId]);

  const busy = inspect.isPending || open.isPending || close.isPending;
  const askOpen = (ports: HostFirewallPort[]): void => {
    void confirm({
      title: `Open ${describe(ports)} on the VPS firewall?`,
      description:
        'Adds an ACCEPT rule for this port on the server’s own firewall (marked as CloudForge’s, saved so it survives a reboot). Nothing else is changed. The cloud security list above must also allow the port for traffic to arrive.',
      confirmLabel: 'Open port',
      destructive: false,
    }).then((confirmed) => {
      if (confirmed) open.mutate(ports);
    });
  };
  const askClose = (port: HostFirewallPort): void => {
    void confirm({
      title: `Close ${describe([port])} on the VPS firewall?`,
      description:
        state?.backend === 'ufw' || state?.backend === 'firewalld'
          ? `${state.backend} cannot tell who added a rule: closing removes the rule for this port whoever created it. Services using it stop being reachable.`
          : 'Removes CloudForge’s rule for this port. Services using it stop being reachable from the internet.',
      confirmLabel: 'Close port',
    }).then((confirmed) => {
      if (confirmed) close.mutate([port]);
    });
  };

  const reachability = useMemo(
    () =>
      state
        ? QUICK.map(({ label, port }) => ({
            label,
            port,
            cloud: cloudAllows(providerRules, port),
            host: hostFirewallAllows(state, port, 'tcp'),
          }))
        : [],
    [providerRules, state],
  );

  const custom = Number(customPort);
  const customValid = Number.isInteger(custom) && custom >= 1 && custom <= 65_535;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" />
          VPS firewall (inside the server)
        </CardTitle>
        <CardDescription>
          A port is reachable only when both the cloud security list above and the server’s own
          firewall allow it. Open a port here directly — no Nginx domain or runtime route needed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <div>
            <Label>Saved VPS target (SSH)</Label>
            <Select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              <option value="">Select the server</option>
              {targets.data?.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name} · {target.host}
                  {publicIp !== null && target.host === publicIp ? ' (this instance)' : ''}
                </option>
              ))}
            </Select>
          </div>
          <Button
            variant="outline"
            className="self-end"
            disabled={!targetId || busy}
            onClick={() => inspect.mutate()}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Read VPS firewall
          </Button>
        </div>
        {targets.data && targets.data.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No saved VPS target yet: add this server in Ansible → Targets to manage its firewall.
          </p>
        )}

        {state && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="secondary">backend: {state.backend}</Badge>
              <Badge variant={state.active ? 'success' : 'secondary'}>
                {state.active ? 'filtering' : 'inactive (allows everything)'}
              </Badge>
              {state.indeterminate && <Badge variant="warning">could not be read</Badge>}
            </div>

            <div className="grid gap-2 md:grid-cols-2">
              {reachability.map((r) => (
                <div key={r.port} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      {r.label} ({r.port}/tcp)
                    </span>
                    <Badge
                      variant={
                        r.cloud && r.host ? 'success' : r.host === null ? 'secondary' : 'warning'
                      }
                    >
                      {r.cloud && r.host
                        ? 'reachable'
                        : r.host === null
                          ? 'unknown'
                          : !r.host && !r.cloud
                            ? 'blocked by both'
                            : !r.host
                              ? 'blocked by the VPS firewall'
                              : 'blocked by the cloud security list'}
                    </Badge>
                  </div>
                  <div className="text-muted-foreground mt-1 text-xs">
                    Cloud security list: {r.cloud ? 'allows' : 'blocks'} · VPS firewall:{' '}
                    {r.host === null ? 'unknown' : r.host ? 'allows' : 'blocks'}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-end gap-2">
              {QUICK.map(({ label, port }) => (
                <Button
                  key={port}
                  size="sm"
                  disabled={busy || hostFirewallAllows(state, port, 'tcp') === true}
                  onClick={() => askOpen([{ port, protocol: 'tcp' }])}
                >
                  <LockOpen className="mr-1 h-3 w-3" />
                  Open {label} ({port})
                </Button>
              ))}
              <div>
                <Label>Port</Label>
                <Input
                  className="w-28"
                  type="number"
                  min={1}
                  max={65535}
                  value={customPort}
                  onChange={(event) => setCustomPort(event.target.value)}
                />
              </div>
              <div>
                <Label>Protocol</Label>
                <Select
                  value={customProtocol}
                  onChange={(event) => setCustomProtocol(event.target.value as 'tcp' | 'udp')}
                >
                  <option value="tcp">TCP</option>
                  <option value="udp">UDP</option>
                </Select>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !customValid}
                onClick={() => askOpen([{ port: custom, protocol: customProtocol }])}
              >
                <LockOpen className="mr-1 h-3 w-3" />
                Open port
              </Button>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Port</TableHead>
                  <TableHead>Protocol</TableHead>
                  <TableHead>Added by</TableHead>
                  <TableHead>Rule</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.rules.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground">
                      No port rule found.
                    </TableCell>
                  </TableRow>
                ) : (
                  state.rules.map((rule) => {
                    const ssh = rule.protocol === 'tcp' && rule.port === sshPort;
                    const closable =
                      !ssh &&
                      (rule.managed || state.backend === 'ufw' || state.backend === 'firewalld');
                    return (
                      <TableRow key={`${rule.port}/${rule.protocol}/${rule.raw}`}>
                        <TableCell>{rule.port}</TableCell>
                        <TableCell>{rule.protocol.toUpperCase()}</TableCell>
                        <TableCell>
                          {rule.managed ? 'CloudForge' : ssh ? 'system (SSH)' : 'other'}
                        </TableCell>
                        <TableCell className="text-muted-foreground max-w-md truncate font-mono text-xs">
                          {rule.raw}
                        </TableCell>
                        <TableCell>
                          {closable && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => askClose({ port: rule.port, protocol: rule.protocol })}
                            >
                              <Lock className="mr-1 h-3 w-3" />
                              Close
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function describe(ports: readonly HostFirewallPort[]): string {
  return ports.map((p) => `${String(p.port)}/${p.protocol}`).join(', ');
}

/** Whether the cloud security list lets the internet reach a TCP port. */
function cloudAllows(rules: readonly LiveFirewallRule[], port: number): boolean {
  return rules.some(
    (rule) =>
      rule.direction === 'ingress' &&
      (rule.protocol === 'tcp' || rule.protocol === 'all') &&
      (rule.cidr === '0.0.0.0/0' || rule.cidr === '::/0') &&
      (rule.portFrom === null || rule.portFrom <= port) &&
      (rule.portTo === null || port <= rule.portTo),
  );
}
