import { useState, type ReactNode } from 'react';
import {
  Activity,
  FileText,
  Fingerprint,
  Loader2,
  Play,
  RefreshCw,
  RotateCw,
  Square,
  Trash2,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Label,
  LogTerminal,
  Select,
  Textarea,
  toast,
} from '@cloudforge/ui';
import type { ContainerAction, RemoteContainer } from '@cloudforge/core';
import type { ContainerTargetRequest } from '@shared/ipc/contract.js';
import { PageHeader } from '../../components/PageHeader.js';
import { useInspectHostKey, useSshCredentials } from '../deployments/useDeployments.js';
import {
  useContainerAction,
  useContainerLogs,
  useContainerStats,
  useDeployCompose,
  useListContainers,
} from './useContainers.js';

export function ContainersPage(): JSX.Element {
  const credentials = useSshCredentials();
  const inspect = useInspectHostKey();
  const list = useListContainers();
  const action = useContainerAction();
  const logs = useContainerLogs();
  const stats = useContainerStats();
  const compose = useDeployCompose();
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState('opc');
  const [sshCredentialId, setSshCredentialId] = useState('');
  const [hostKeySha256, setHostKeySha256] = useState('');
  const [projectName, setProjectName] = useState('');
  const [composeYaml, setComposeYaml] = useState(
    'services:\n  app:\n    image: nginx:1.27-alpine\n    ports:\n      - "80:80"\n',
  );

  const target: ContainerTargetRequest = { host, port, username, sshCredentialId, hostKeySha256 };
  const ready = host && username && sshCredentialId && hostKeySha256;
  const reload = (): void =>
    list.mutate(target, { onError: (error) => toast.error(error.message) });
  const perform = (container: RemoteContainer, operation: ContainerAction): void => {
    if (
      (operation === 'remove' || operation === 'stop') &&
      !window.confirm(`${operation} container "${container.name}"?`)
    )
      return;
    action.mutate(
      { ...target, containerId: container.id, action: operation },
      { onSuccess: reload, onError: (error) => toast.error(error.message) },
    );
  };

  return (
    <>
      <PageHeader
        title="Containers"
        description="Manage Docker and Compose securely over a verified SSH connection."
        actions={
          <Button variant="outline" disabled={!ready || list.isPending} onClick={reload}>
            {list.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Load containers
          </Button>
        }
      />

      <Card className="mb-5">
        <CardContent className="grid gap-3 pt-6 md:grid-cols-2 xl:grid-cols-5">
          <Field label="Host">
            <Input
              value={host}
              onChange={(event) => {
                setHost(event.target.value);
                setHostKeySha256('');
              }}
            />
          </Field>
          <Field label="Port">
            <Input
              type="number"
              value={port}
              onChange={(event) => {
                setPort(Number(event.target.value) || 22);
                setHostKeySha256('');
              }}
            />
          </Field>
          <Field label="SSH user">
            <Input value={username} onChange={(event) => setUsername(event.target.value)} />
          </Field>
          <Field label="SSH key">
            <Select
              value={sshCredentialId}
              onChange={(event) => setSshCredentialId(event.target.value)}
            >
              <option value="">Select a key…</option>
              {credentials.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credential.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Host fingerprint">
            <Button
              className="w-full"
              variant="outline"
              disabled={!host || inspect.isPending}
              onClick={() =>
                inspect.mutate(
                  { host, port },
                  {
                    onSuccess: ({ fingerprint }) => setHostKeySha256(fingerprint),
                    onError: (error) => toast.error(error.message),
                  },
                )
              }
            >
              {inspect.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Fingerprint className="size-4" />
              )}
              {hostKeySha256 ? 'Fingerprint trusted' : 'Inspect host'}
            </Button>
          </Field>
          {hostKeySha256 ? (
            <p className="text-warning break-all text-xs md:col-span-2 xl:col-span-5">
              Verify before use: {hostKeySha256}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
        <div className="space-y-3">
          {list.data?.map((container) => (
            <Card key={container.id}>
              <CardContent className="space-y-3 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{container.name}</p>
                    <p className="text-muted-foreground truncate text-xs">
                      {container.image} · {container.ports || 'no published ports'}
                    </p>
                  </div>
                  <Badge variant={container.state === 'running' ? 'success' : 'secondary'}>
                    {container.state}
                  </Badge>
                </div>
                <p className="text-muted-foreground text-xs">{container.status}</p>
                <div className="flex flex-wrap gap-2">
                  <Action
                    icon={<Play className="size-3.5" />}
                    label="Start"
                    onClick={() => perform(container, 'start')}
                  />
                  <Action
                    icon={<Square className="size-3.5" />}
                    label="Stop"
                    onClick={() => perform(container, 'stop')}
                  />
                  <Action
                    icon={<RotateCw className="size-3.5" />}
                    label="Restart"
                    onClick={() => perform(container, 'restart')}
                  />
                  <Action
                    icon={<FileText className="size-3.5" />}
                    label="Logs"
                    onClick={() => logs.mutate({ ...target, containerId: container.id })}
                  />
                  <Action
                    icon={<Activity className="size-3.5" />}
                    label="Stats"
                    onClick={() => stats.mutate({ ...target, containerId: container.id })}
                  />
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={action.isPending}
                    onClick={() => perform(container, 'remove')}
                  >
                    <Trash2 className="size-3.5" /> Remove
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
          {list.data?.length === 0 ? (
            <p className="text-muted-foreground text-sm">No containers found on this host.</p>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-3 py-5">
              <p className="font-medium">Deploy Compose project</p>
              <Input
                placeholder="project-name"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
              />
              <Textarea
                className="min-h-52 font-mono text-xs"
                value={composeYaml}
                onChange={(event) => setComposeYaml(event.target.value)}
              />
              <Button
                className="w-full"
                disabled={!ready || !projectName || !composeYaml || compose.isPending}
                onClick={() =>
                  compose.mutate(
                    { ...target, projectName, composeYaml },
                    {
                      onSuccess: () => {
                        toast.success('Compose project deployed');
                        reload();
                      },
                      onError: (error) => toast.error(error.message),
                    },
                  )
                }
              >
                {compose.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}{' '}
                Deploy Compose
              </Button>
            </CardContent>
          </Card>
          {stats.data ? (
            <Card>
              <CardContent className="grid grid-cols-2 gap-3 py-4 text-xs">
                <Metric label="CPU" value={stats.data.cpu} />
                <Metric label="Memory" value={stats.data.memory} />
                <Metric label="Network" value={stats.data.networkIo} />
                <Metric label="Block I/O" value={stats.data.blockIo} />
              </CardContent>
            </Card>
          ) : null}
          <LogTerminal
            lines={logs.data?.text.split('\n') ?? []}
            emptyMessage="Select Logs on a container."
          />
        </div>
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
function Action({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <Button size="sm" variant="outline" onClick={onClick}>
      {icon}
      {label}
    </Button>
  );
}
function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}
