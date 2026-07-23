import { useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  FileText,
  Loader2,
  Network,
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
import type { ContainerAction, ObservedContainer, RuntimeOwnership } from '@cloudforge/core';
import { PageHeader } from '../../components/PageHeader.js';
import { useConfirmation } from '../../components/ConfirmationDialogProvider.js';
import { useVpsTargets } from '../ansible/useAnsible.js';
import { ContainerPorts } from './ContainerPorts.js';
import {
  useContainerAction,
  useContainerLogs,
  useContainerStats,
  useDeployCompose,
  useRefreshRuntime,
  useRuntime,
} from './useContainers.js';

const OWNERSHIP_LABEL: Record<RuntimeOwnership, string> = {
  'cloudforge-managed': 'Managed',
  adopted: 'Adopted',
  'legacy-managed': 'Legacy',
  unmanaged: 'Unmanaged',
};

const OWNERSHIP_HINT: Record<RuntimeOwnership, string> = {
  'cloudforge-managed': 'Created by CloudForge and safe for it to change.',
  adopted: 'Pre-existing, and explicitly handed over to CloudForge.',
  'legacy-managed':
    'Created by an earlier CloudForge release, before ownership labels existed. Recognised, but not managed until you adopt it.',
  unmanaged: 'Not created by CloudForge. Reported only; CloudForge will not change it.',
};

const OWNERSHIP_VARIANT: Record<RuntimeOwnership, 'success' | 'secondary' | 'warning'> = {
  'cloudforge-managed': 'success',
  adopted: 'success',
  'legacy-managed': 'warning',
  unmanaged: 'secondary',
};

export function ContainersPage(): JSX.Element {
  const confirm = useConfirmation();
  const targets = useVpsTargets();
  const [targetId, setTargetId] = useState('');
  const runtime = useRuntime(targetId);
  const refreshRuntime = useRefreshRuntime(targetId);
  const action = useContainerAction();
  const logs = useContainerLogs();
  const stats = useContainerStats();
  const compose = useDeployCompose();
  const [projectName, setProjectName] = useState('');
  const [composeYaml, setComposeYaml] = useState(
    'services:\n  app:\n    image: nginx:1.27-alpine\n    ports:\n      - "80:80"\n',
  );

  useEffect(() => {
    if (!targets.data) return;
    if (!targets.data.some((target) => target.id === targetId))
      setTargetId(targets.data[0]?.id ?? '');
  }, [targetId, targets.data]);

  const containers = runtime.data?.containers ?? [];
  const networks = runtime.data?.networks ?? [];
  const reload = (): void => void refreshRuntime();

  const perform = async (
    container: ObservedContainer,
    operation: ContainerAction,
  ): Promise<void> => {
    if (operation === 'remove' || operation === 'stop') {
      const confirmed = await confirm({
        title: `${operation === 'remove' ? 'Remove' : 'Stop'} container?`,
        description:
          operation === 'remove'
            ? `Remove “${container.name}” from the VPS? Unsaved container data may be lost.`
            : `Stop “${container.name}”? Its service will become unavailable until restarted.`,
        confirmLabel: operation === 'remove' ? 'Remove container' : 'Stop container',
        destructive: operation === 'remove',
      });
      if (!confirmed) return;
    }
    action.mutate(
      { targetId, containerId: container.id, action: operation },
      { onSuccess: reload, onError: (error) => toast.error(error.message) },
    );
  };

  return (
    <>
      <PageHeader
        title="Containers"
        description="Inspect and manage Docker and Compose over a verified SSH connection."
        actions={
          <Button variant="outline" disabled={!targetId || runtime.isFetching} onClick={reload}>
            {runtime.isFetching ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Refresh
          </Button>
        }
      />

      <Card className="mb-5">
        <CardContent className="grid gap-3 pt-6 md:grid-cols-3">
          <Field label="VPS target">
            <Select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              <option value="">Select a saved target…</option>
              {(targets.data ?? []).map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name} · {target.host}
                </option>
              ))}
            </Select>
            <p className="text-muted-foreground text-xs">
              Save a target in Ansible first. CloudForge connects using its pinned host fingerprint.
            </p>
          </Field>
          {runtime.data ? (
            <>
              <Field label="Docker">
                <p className="text-sm">
                  {runtime.data.docker.available
                    ? `Engine ${runtime.data.docker.version ?? '—'}${
                        runtime.data.docker.composeVersion
                          ? ` · Compose ${runtime.data.docker.composeVersion}`
                          : ''
                      }`
                    : 'Not installed on this VPS'}
                </p>
              </Field>
              <Field label="Inventory">
                <p className="text-sm">
                  {containers.length} containers · {networks.length} networks ·{' '}
                  {runtime.data.volumes.length} volumes
                </p>
              </Field>
            </>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
        <div className="space-y-3">
          {runtime.isLoading ? (
            <Card>
              <CardContent className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
                <Loader2 className="size-4 animate-spin" /> Reading the runtime on the selected VPS…
              </CardContent>
            </Card>
          ) : null}
          {runtime.isError ? (
            <Card className="border-destructive/40">
              <CardContent className="text-destructive py-5 text-sm">
                The runtime could not be read: {runtime.error.message}
              </CardContent>
            </Card>
          ) : null}
          {containers.map((container) => (
            <Card key={container.id}>
              <CardContent className="space-y-3 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{container.name}</p>
                    <p className="text-muted-foreground truncate text-xs">
                      {container.image}
                      {container.composeProject ? ` · ${container.composeProject}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <Badge
                      variant={OWNERSHIP_VARIANT[container.ownership]}
                      title={OWNERSHIP_HINT[container.ownership]}
                    >
                      {OWNERSHIP_LABEL[container.ownership]}
                    </Badge>
                    <Badge variant={container.state === 'running' ? 'success' : 'secondary'}>
                      {container.health ?? container.state}
                    </Badge>
                  </div>
                </div>

                <ContainerPorts ports={container.ports} />

                {container.networks.length > 0 ? (
                  <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <Network className="size-3.5 shrink-0" />
                    {container.networks
                      .map((attachment) =>
                        attachment.aliases.length > 0
                          ? `${attachment.network} (${attachment.aliases.join(', ')})`
                          : attachment.network,
                      )
                      .join(' · ')}
                  </p>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <Action
                    icon={<Play className="size-3.5" />}
                    label="Start"
                    onClick={() => void perform(container, 'start')}
                  />
                  <Action
                    icon={<Square className="size-3.5" />}
                    label="Stop"
                    onClick={() => void perform(container, 'stop')}
                  />
                  <Action
                    icon={<RotateCw className="size-3.5" />}
                    label="Restart"
                    onClick={() => void perform(container, 'restart')}
                  />
                  <Action
                    icon={<FileText className="size-3.5" />}
                    label="Logs"
                    onClick={() => logs.mutate({ targetId, containerId: container.id })}
                  />
                  <Action
                    icon={<Activity className="size-3.5" />}
                    label="Stats"
                    onClick={() => stats.mutate({ targetId, containerId: container.id })}
                  />
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={action.isPending}
                    onClick={() => void perform(container, 'remove')}
                  >
                    <Trash2 className="size-3.5" /> Remove
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
          {runtime.data && containers.length === 0 ? (
            <p className="text-muted-foreground text-sm">No containers found on this host.</p>
          ) : null}
        </div>

        <div className="space-y-4">
          {networks.length > 0 ? (
            <Card>
              <CardContent className="space-y-2 py-4">
                <p className="font-medium">Networks</p>
                {networks.map((network) => (
                  <div key={network.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate">
                      {network.name}
                      <span className="text-muted-foreground">
                        {' '}
                        · {network.driver}
                        {network.internal ? ' · internal' : ''}
                      </span>
                    </span>
                    <Badge
                      variant={OWNERSHIP_VARIANT[network.ownership]}
                      title={OWNERSHIP_HINT[network.ownership]}
                    >
                      {network.containerNames.length}
                    </Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
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
                disabled={!targetId || !projectName || !composeYaml || compose.isPending}
                onClick={() =>
                  compose.mutate(
                    { targetId, projectName, composeYaml },
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
