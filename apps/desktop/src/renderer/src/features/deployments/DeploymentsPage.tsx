import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Rocket } from 'lucide-react';
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
import { useProjects } from '../projects/useProjects.js';
import {
  useDeployLogs,
  useDeployments,
  useDeploymentTemplates,
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
  const run = useRunDeployment();
  const [streamId] = useState(() => crypto.randomUUID());
  const { lines, clear } = useDeployLogs(streamId);

  const [projectId, setProjectId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('ubuntu');
  const [port, setPort] = useState(22);
  const [sshCredentialId, setSshCredentialId] = useState('');
  const [appImage, setAppImage] = useState('');

  const { data: history } = useDeployments(projectId || null);

  useEffect(() => {
    if (!projectId && projects && projects.length > 0) setProjectId(projects[0]!.id);
  }, [projects, projectId]);
  useEffect(() => {
    if (!templateId && templates && templates.length > 0) setTemplateId(templates[0]!.id);
  }, [templates, templateId]);
  useEffect(() => {
    if (!sshCredentialId && sshCredentials.length > 0) setSshCredentialId(sshCredentials[0]!.id);
  }, [sshCredentials, sshCredentialId]);

  if (projects?.length === 0) {
    return (
      <>
        <PageHeader title="Deployments" description="Provision and deploy applications." />
        <EmptyLink to="/projects" label="Create a project first" cta="Go to Projects" />
      </>
    );
  }

  const canRun = projectId && templateId && host && username && sshCredentialId && !run.isPending;

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
              <Field label="Host">
                <Input
                  placeholder="203.0.113.10"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                />
              </Field>
              <Field label="Port">
                <Input
                  type="number"
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value) || 22)}
                />
              </Field>
              <Field label="SSH user">
                <Input value={username} onChange={(e) => setUsername(e.target.value)} />
              </Field>
              <Field label="SSH key">
                <Select
                  value={sshCredentialId}
                  onChange={(e) => setSshCredentialId(e.target.value)}
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
            <Button className="w-full" disabled={!canRun} onClick={launch}>
              {run.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Rocket className="size-4" />
              )}
              Deploy
            </Button>
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
