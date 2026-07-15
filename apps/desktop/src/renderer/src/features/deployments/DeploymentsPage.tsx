import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Fingerprint, Loader2, Rocket, Square } from 'lucide-react';
import {
  Badge,
  type BadgeProps,
  Button,
  Card,
  CardContent,
  Input,
  Label,
  LogTerminal,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@cloudforge/ui';
import type { DeploymentDto } from '@cloudforge/core';
import { IpcCallError } from '../../lib/ipc.js';
import { PageHeader } from '../../components/PageHeader.js';
import { useVpsTargets } from '../ansible/useAnsible.js';
import { useProjects } from '../projects/useProjects.js';
import {
  useDeployLogs,
  useDeployments,
  useDeploymentTemplates,
  useInspectHostKey,
  useCancelDeployment,
  useRunDeployment,
  useSshCredentials,
} from './useDeployments.js';

function statusVariant(status: DeploymentDto['status']): BadgeProps['variant'] {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
      return 'destructive';
    case 'running':
      return 'warning';
    default:
      return 'secondary';
  }
}

/** The Deployments module: run a template on a host over SSH with live logs. */
export function DeploymentsPage(): JSX.Element {
  const { data: projects } = useProjects();
  const { data: templates } = useDeploymentTemplates();
  const sshCredentials = useSshCredentials();
  const targets = useVpsTargets();
  const run = useRunDeployment();
  const inspectHostKey = useInspectHostKey();
  const cancel = useCancelDeployment();
  const [streamId] = useState(() => crypto.randomUUID());
  const { lines, clear } = useDeployLogs(streamId);

  const [projectId, setProjectId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [host, setHost] = useState('');
  const [selectedTargetId, setSelectedTargetId] = useState('');
  const [username, setUsername] = useState('ubuntu');
  const [port, setPort] = useState(22);
  const [sshCredentialId, setSshCredentialId] = useState('');
  const [appImage, setAppImage] = useState('');
  const [hostKeySha256, setHostKeySha256] = useState('');

  const { data: history } = useDeployments(projectId || null);

  const selectTarget = useCallback(
    (id: string): void => {
      setSelectedTargetId(id);
      const selected = targets.data?.find((target) => target.id === id);
      if (!selected) {
        setHost('');
        setPort(22);
        setUsername('ubuntu');
        setHostKeySha256('');
        return;
      }
      setHost(selected.host);
      setPort(selected.port);
      setUsername(selected.username);
      setSshCredentialId(selected.sshCredentialId ?? '');
      setHostKeySha256(selected.hostKeySha256);
    },
    [targets.data],
  );

  useEffect(() => {
    if (!projectId && projects && projects.length > 0) setProjectId(projects[0]!.id);
  }, [projects, projectId]);
  useEffect(() => {
    if (!templateId && templates && templates.length > 0) setTemplateId(templates[0]!.id);
  }, [templates, templateId]);
  useEffect(() => {
    if (!sshCredentialId && sshCredentials.length > 0) setSshCredentialId(sshCredentials[0]!.id);
  }, [sshCredentials, sshCredentialId]);
  useEffect(() => {
    const selected = targets.data?.find((target) => target.id === selectedTargetId);
    if (selected?.managedProjectId === projectId) return;
    const managed = targets.data?.find((target) => target.managedProjectId === projectId);
    if (managed) selectTarget(managed.id);
    else if (selectedTargetId && !selected) selectTarget('');
  }, [projectId, selectedTargetId, selectTarget, targets.data]);

  if (projects?.length === 0) {
    return (
      <>
        <PageHeader title="Deployments" description="Provision and deploy applications." />
        <EmptyLink to="/projects" label="Create a project first" cta="Go to Projects" />
      </>
    );
  }

  const canRun =
    projectId &&
    templateId &&
    host &&
    username &&
    sshCredentialId &&
    hostKeySha256 &&
    !run.isPending;

  const launch = (): void => {
    clear();
    run.mutate(
      {
        projectId,
        templateId,
        host,
        port,
        username,
        sshCredentialId,
        hostKeySha256,
        streamId,
        ...(appImage ? { appImage } : {}),
      },
      {
        onSuccess: (dto) =>
          toast[dto.status === 'success' ? 'success' : 'error'](`Deployment ${dto.status}`),
        onError: (error) =>
          toast.error(error instanceof IpcCallError ? error.message : 'Deployment failed'),
      },
    );
  };

  return (
    <>
      <PageHeader title="Deployments" description="Run a deployment template on a host over SSH." />

      {sshCredentials.length === 0 ? (
        <Card className="border-warning/40 mb-4">
          <CardContent className="text-muted-foreground py-3 text-sm">
            Add an <span className="text-foreground">SSH Key</span> credential in{' '}
            <Link to="/secrets" className="text-primary underline-offset-2 hover:underline">
              Secrets
            </Link>{' '}
            to deploy.
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Project">
                <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  {projects?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Template">
                <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                  {templates?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="col-span-2">
                <Field label="Saved VPS target">
                  <Select
                    value={selectedTargetId}
                    onChange={(event) => selectTarget(event.target.value)}
                  >
                    <option value="">Manual connection…</option>
                    {(targets.data ?? []).map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.name} · {target.host}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Host">
                <Input
                  placeholder="203.0.113.10"
                  value={host}
                  onChange={(e) => {
                    setSelectedTargetId('');
                    setHost(e.target.value);
                    setHostKeySha256('');
                  }}
                />
              </Field>
              <Field label="Port">
                <Input
                  type="number"
                  value={port}
                  onChange={(e) => {
                    setSelectedTargetId('');
                    setPort(Number(e.target.value) || 22);
                    setHostKeySha256('');
                  }}
                />
              </Field>
              <Field label="SSH user">
                <Input
                  value={username}
                  onChange={(e) => {
                    setSelectedTargetId('');
                    setUsername(e.target.value);
                  }}
                />
              </Field>
              <Field label="SSH key">
                <Select
                  value={sshCredentialId}
                  onChange={(e) => {
                    setSelectedTargetId('');
                    setSshCredentialId(e.target.value);
                  }}
                >
                  {sshCredentials.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Container image (optional)">
              <Input
                placeholder="ghcr.io/acme/api:latest"
                value={appImage}
                onChange={(e) => setAppImage(e.target.value)}
              />
            </Field>
            <Field label="Trusted SSH host fingerprint">
              <div className="flex gap-2">
                <Input value={hostKeySha256} readOnly placeholder="Inspect the host first" />
                <Button
                  type="button"
                  variant="outline"
                  disabled={!host || inspectHostKey.isPending || run.isPending}
                  onClick={() =>
                    inspectHostKey.mutate(
                      { host, port },
                      {
                        onSuccess: ({ fingerprint }) => setHostKeySha256(fingerprint),
                        onError: (error) => toast.error(error.message),
                      },
                    )
                  }
                >
                  {inspectHostKey.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Fingerprint className="size-4" />
                  )}
                  Inspect
                </Button>
              </div>
              {hostKeySha256 ? (
                <p className="text-warning text-xs">
                  Verify this fingerprint with your server/provider before deploying.
                </p>
              ) : null}
            </Field>
            <div className="flex gap-2">
              <Button className="flex-1" disabled={!canRun} onClick={launch}>
                {run.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Rocket className="size-4" />
                )}
                Deploy
              </Button>
              {run.isPending ? (
                <Button
                  variant="destructive"
                  onClick={() => cancel.mutate(streamId)}
                  disabled={cancel.isPending}
                >
                  <Square className="size-4" />
                  Cancel
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-2">
          <p className="text-sm font-medium">Deployment output</p>
          <LogTerminal lines={lines} emptyMessage="Run a deployment to see output." />
        </div>
      </div>

      <div className="mt-6">
        <p className="mb-2 text-sm font-medium">History</p>
        {!history || history.length === 0 ? (
          <p className="text-muted-foreground text-sm">No deployments yet.</p>
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Template</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((deployment) => (
                  <TableRow key={deployment.id}>
                    <TableCell className="font-medium">{deployment.strategy}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(deployment.status)}>{deployment.status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(deployment.createdAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>
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

function EmptyLink({ to, label, cta }: { to: string; label: string; cta: string }): JSX.Element {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="font-medium">{label}</p>
        <Button asChild>
          <Link to={to}>{cta}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
