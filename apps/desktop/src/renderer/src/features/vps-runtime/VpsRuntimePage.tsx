/**
 * The VPS runtime: what CloudForge believes a target's topology is, what the
 * target actually looks like, and the gap between the two.
 *
 * Everything on this page is read-only except one button, and that button cannot
 * do anything without a preview taken seconds earlier and, for anything
 * destructive, the resource's exact name typed by hand.
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, Check, Play, RefreshCw, ShieldCheck, Unlink } from 'lucide-react';
import type {
  ConnectivityFinding,
  RuntimeDriftEntry,
  RuntimeMode,
  RuntimeOperation,
  RuntimePreview,
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
import { PageHeader } from '../../components/PageHeader.js';
import { useConfirmation } from '../../components/ConfirmationDialogProvider.js';
import { useVpsTargets } from '../ansible/useAnsible.js';
import {
  useRuntimeActions,
  useRuntimeConnectivity,
  useRuntimeDrift,
  useRuntimePlan,
} from './useRuntime.js';

const MODES: readonly { value: RuntimeMode; label: string; blurb: string }[] = [
  {
    value: 'legacy',
    label: 'Legacy — change nothing',
    blurb:
      'CloudForge reads this VPS and never writes to it. Every target starts here, including ones that have been running for years.',
  },
  {
    value: 'hybrid',
    label: 'Hybrid — manage what is adopted',
    blurb:
      'CloudForge manages only the resources you have explicitly adopted. Anything else on the VPS is left exactly as it is.',
  },
  {
    value: 'managed',
    label: 'Managed — the plan is the truth',
    blurb:
      'CloudForge keeps the VPS matching this plan. Resources it does not own are still never touched.',
  },
];

function severityVariant(severity: RuntimeDriftEntry['severity']): 'default' | 'secondary' {
  return severity === 'error' ? 'default' : 'secondary';
}

function findingTone(state: ConnectivityFinding['state']): string {
  if (state === 'reachable') return 'text-success';
  if (state === 'unknown') return 'text-muted-foreground';
  return 'text-warning';
}

function isAdoptableDockerKind(
  kind: RuntimeDriftEntry['resourceKind'],
): kind is 'container' | 'network' | 'volume' {
  return kind === 'container' || kind === 'network' || kind === 'volume';
}

export function VpsRuntimePage(): JSX.Element {
  const confirm = useConfirmation();
  const targets = useVpsTargets();
  const [targetId, setTargetId] = useState('');
  const [inspected, setInspected] = useState(false);
  const [preview, setPreview] = useState<RuntimePreview | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});

  const plan = useRuntimePlan(targetId);
  const drift = useRuntimeDrift(targetId, inspected);
  const connectivity = useRuntimeConnectivity(targetId, inspected);
  const actions = useRuntimeActions(targetId);

  const mode = plan.data?.plan.mode ?? 'legacy';
  const legacy = mode === 'legacy';

  // A preview is a statement about the VPS at one instant. Any write invalidates
  // it, and the main process re-derives the change at apply time and refuses a
  // token that no longer matches — this only stops the UI showing a stale plan
  // as though it were still on offer.
  const dropPreview = (): void => {
    setPreview(null);
    setTyped({});
  };

  const destructive = useMemo(
    () => (preview?.operations ?? []).filter((operation) => operation.risk === 'destructive'),
    [preview],
  );
  const confirmedAll = destructive.every(
    (operation) => typed[operation.id]?.trim() === operation.resource,
  );

  const runPreview = async (): Promise<void> => {
    try {
      const next = await actions.preview.mutateAsync(undefined);
      setPreview(next);
      setTyped({});
      if (next.operations.length === 0) toast.success('Nothing to apply: the VPS matches the plan');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not preview');
    }
  };

  const runApply = async (): Promise<void> => {
    if (!preview) return;
    const ok = await confirm({
      title: `Apply ${String(preview.operations.length)} operation(s)?`,
      description:
        destructive.length > 0
          ? `${String(destructive.length)} of these permanently remove something. This runs against ${targets.data?.find((entry) => entry.id === targetId)?.name ?? 'the VPS'} now.`
          : 'This changes the VPS now. Nothing here removes a resource.',
      confirmLabel: 'Apply',
      destructive: destructive.length > 0,
    });
    if (!ok) return;
    try {
      const report = await actions.apply.mutateAsync({
        streamId: `runtime-apply-${targetId}-${String(preview.planVersion)}`,
        previewToken: preview.token,
        confirmations: destructive.map((operation) => operation.resource),
      });
      toast.success(`Applied ${String(report.applied)}, failed ${String(report.failed)}`);
      dropPreview();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Apply failed');
      dropPreview();
    }
  };

  const adopt = async (entry: RuntimeDriftEntry): Promise<void> => {
    if (!isAdoptableDockerKind(entry.resourceKind)) return;
    const ok = await confirm({
      title: `Adopt ${entry.dockerName}?`,
      description:
        'CloudForge records that it owns this resource and will manage it from now on. Nothing on the VPS is labelled, restarted or disconnected by this — it only changes what the plan says.',
      confirmLabel: 'Adopt',
    });
    if (!ok) return;
    try {
      await actions.adopt.mutateAsync({
        resourceKind: entry.resourceKind,
        dockerName: entry.dockerName,
      });
      toast.success(`Adopted ${entry.dockerName}`);
      dropPreview();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not adopt');
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="VPS Runtime"
        description="The declared topology for a VPS, what is actually on it, and whether its ports can carry traffic."
      />

      <Card>
        <CardHeader>
          <CardTitle>Target</CardTitle>
          <CardDescription>
            Reading a target opens an SSH connection and inspects Docker. Nothing is changed.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <Label>VPS target</Label>
            <Select
              value={targetId}
              onChange={(event) => {
                setTargetId(event.target.value);
                setInspected(false);
                dropPreview();
              }}
            >
              <option value="">Select a saved target…</option>
              {(targets.data ?? []).map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name}
                </option>
              ))}
            </Select>
          </div>
          <Button
            variant="secondary"
            disabled={!targetId}
            onClick={() => {
              setInspected(true);
              void drift.refetch();
              void connectivity.refetch();
            }}
          >
            <RefreshCw className="mr-2 h-4 w-4" /> Inspect VPS
          </Button>
        </CardContent>
      </Card>

      {targetId && (
        <Card>
          <CardHeader>
            <CardTitle>Mode</CardTitle>
            <CardDescription>
              How much of this VPS CloudForge is allowed to change. Plan version{' '}
              {String(plan.data?.plan.version ?? 0)}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Select
              value={mode}
              onChange={(event) => {
                dropPreview();
                actions.setMode.mutate(event.target.value as RuntimeMode, {
                  onSuccess: () => toast.success('Runtime mode saved'),
                  onError: (error) => toast.error(error.message),
                });
              }}
            >
              {MODES.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </Select>
            <p className="text-muted-foreground text-xs">
              {MODES.find((entry) => entry.value === mode)?.blurb}
            </p>
            {(plan.data?.issues.length ?? 0) > 0 && (
              <div className="border-warning/40 bg-warning/10 space-y-1 rounded-md border px-3 py-2">
                {plan.data?.issues.map((issue) => (
                  <p key={issue.id} className="text-warning text-xs">
                    <strong>{issue.id}</strong> — {issue.message}
                  </p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {targetId && plan.data && (
        <Card>
          <CardHeader>
            <CardTitle>Authoritative topology</CardTitle>
            <CardDescription>
              Applications, routes, certificates and managed DNS synchronized by the existing
              CloudForge workflows.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Applications', plan.data.plan.applications.length],
              ['Routes', plan.data.plan.routes.length],
              ['Certificates', plan.data.plan.certificates.length],
              ['Managed DNS', plan.data.plan.dnsRecords.length],
            ].map(([label, count]) => (
              <div key={String(label)} className="border-border rounded-md border px-3 py-3">
                <p className="text-muted-foreground text-xs">{label}</p>
                <p className="mt-1 text-xl font-semibold">{count}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {inspected && (
        <Card>
          <CardHeader>
            <CardTitle>Drift</CardTitle>
            <CardDescription>
              {legacy
                ? 'This target is in legacy mode, so there is nothing to drift from. CloudForge is not managing anything here.'
                : 'What the plan says, against what is on the VPS. A resource CloudForge does not own is never drift.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {drift.error && (
              <p className="text-warning text-sm">Could not read the VPS: {drift.error.message}</p>
            )}
            {drift.data?.inSync && (
              <p className="text-success flex items-center gap-2 text-sm">
                <Check className="h-4 w-4" /> The VPS matches the plan.
              </p>
            )}
            {(drift.data?.entries.length ?? 0) > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Resource</TableHead>
                    <TableHead>What</TableHead>
                    <TableHead>Ownership</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {drift.data?.entries.map((entry) => (
                    <TableRow key={`${entry.id}:${entry.dockerName}`}>
                      <TableCell className="font-mono text-xs">{entry.dockerName || '—'}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Badge variant={severityVariant(entry.severity)}>{entry.kind}</Badge>
                          <span className="text-xs">{entry.message}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {entry.ownership}
                      </TableCell>
                      <TableCell className="text-right">
                        {entry.kind === 'adoptable' &&
                          isAdoptableDockerKind(entry.resourceKind) && (
                            <Button size="sm" variant="secondary" onClick={() => void adopt(entry)}>
                              Adopt
                            </Button>
                          )}
                        {entry.ownership === 'adopted' &&
                          entry.kind !== 'adoptable' &&
                          isAdoptableDockerKind(entry.resourceKind) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                actions.release.mutate(
                                  {
                                    resourceKind: entry.resourceKind as
                                      'container' | 'network' | 'volume',
                                    dockerName: entry.dockerName,
                                  },
                                  {
                                    onSuccess: () => toast.success(`Released ${entry.dockerName}`),
                                    onError: (error) => toast.error(error.message),
                                  },
                                )
                              }
                            >
                              <Unlink className="mr-1 h-3 w-3" /> Release
                            </Button>
                          )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {inspected && (
        <Card>
          <CardHeader>
            <CardTitle>Connectivity</CardTitle>
            <CardDescription>
              A port carries traffic only when the VPS firewall and the cloud provider both allow
              it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {connectivity.error && (
              <p className="text-warning text-sm">
                Could not read the firewall: {connectivity.error.message}
              </p>
            )}
            {connectivity.data?.providerUnknown && (
              <p className="text-muted-foreground text-xs">
                This target has no resolvable managed project/provider binding, so no port can
                honestly be called reachable. Managed targets load their provider firewall
                automatically; standalone VPS targets remain unknown.
              </p>
            )}
            {connectivity.data?.host.indeterminate && (
              <p className="text-warning text-xs">
                The VPS firewall could not be read. This is not the same as “no firewall”.
              </p>
            )}
            {(connectivity.data?.findings.length ?? 0) === 0 && !connectivity.error && (
              <p className="text-muted-foreground text-sm">This target needs no ports open.</p>
            )}
            {connectivity.data?.findings.map((finding) => (
              <div
                key={`${String(finding.port)}/${finding.protocol}`}
                className="border-border flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <div>
                  <p className="font-mono text-sm">
                    {finding.port}/{finding.protocol}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {finding.message}
                    {finding.requiredBy.length > 0 &&
                      ` — needed by ${finding.requiredBy.join(', ')}`}
                  </p>
                </div>
                <span className={`text-xs font-medium ${findingTone(finding.state)}`}>
                  {finding.state}
                </span>
              </div>
            ))}
            {!legacy && (connectivity.data?.findings.length ?? 0) > 0 && (
              <Button
                variant="secondary"
                disabled={actions.openFirewall.isPending}
                onClick={() =>
                  actions.openFirewall.mutate(undefined, {
                    onSuccess: () => toast.success('Required ports are open on the VPS firewall'),
                    onError: (error) => toast.error(error.message),
                  })
                }
              >
                <ShieldCheck className="mr-2 h-4 w-4" /> Open required ports
              </Button>
            )}
            <p className="text-muted-foreground text-xs">
              Opening is additive and never closes anything, so it cannot take away access that
              already works.
            </p>
          </CardContent>
        </Card>
      )}

      {inspected && !legacy && (
        <Card>
          <CardHeader>
            <CardTitle>Apply</CardTitle>
            <CardDescription>
              The only thing on this page that changes the VPS, and it needs a preview first.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              variant="secondary"
              disabled={actions.preview.isPending}
              onClick={() => void runPreview()}
            >
              <RefreshCw className="mr-2 h-4 w-4" /> Preview changes
            </Button>

            {preview?.blockers.map((blocker) => (
              <div
                key={blocker}
                className="border-warning/40 bg-warning/10 flex items-start gap-2 rounded-md border px-3 py-2"
              >
                <AlertTriangle className="text-warning mt-0.5 h-4 w-4 shrink-0" />
                <p className="text-warning text-xs">{blocker}</p>
              </div>
            ))}

            {preview && preview.operations.length > 0 && (
              <div className="space-y-2">
                {preview.operations.map((operation: RuntimeOperation) => (
                  <div key={operation.id} className="border-border rounded-md border px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Badge variant={operation.risk === 'safe' ? 'secondary' : 'default'}>
                        {operation.risk}
                      </Badge>
                      <span className="font-mono text-xs">{operation.id}</span>
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs">{operation.summary}</p>
                    {operation.risk === 'destructive' && (
                      <div className="mt-2">
                        <Label className="text-xs">
                          Type <code className="font-semibold">{operation.resource}</code> to
                          confirm
                        </Label>
                        <Input
                          value={typed[operation.id] ?? ''}
                          placeholder={operation.resource}
                          onChange={(event) =>
                            setTyped({ ...typed, [operation.id]: event.target.value })
                          }
                        />
                      </div>
                    )}
                  </div>
                ))}
                <Button
                  disabled={!preview.applyable || !confirmedAll || actions.apply.isPending}
                  onClick={() => void runApply()}
                >
                  <Play className="mr-2 h-4 w-4" /> Apply {preview.operations.length} operation(s)
                </Button>
                {!preview.applyable && (
                  <p className="text-warning text-xs">
                    Resolve the blockers above before applying.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
