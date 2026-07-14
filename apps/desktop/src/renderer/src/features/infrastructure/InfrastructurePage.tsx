import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  BookmarkPlus,
  CheckCircle2,
  Copy,
  Eye,
  Hammer,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  ServerCog,
  Terminal,
  Trash,
  XCircle,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  LogTerminal,
  Select,
  toast,
} from '@cloudforge/ui';
import {
  type InfrastructurePlan,
  type ManagedStackSummary,
  type PreviewResult,
  type ProjectDto,
  type ResourceKind,
  type ResourceSpec,
  extractSshConnectionHints,
  formatSshCommand,
  validatePlan,
} from '@cloudforge/core';
import { IpcCallError } from '../../lib/ipc.js';
import { PageHeader } from '../../components/PageHeader.js';
import { useProjects } from '../projects/useProjects.js';
import { useSettings } from '../settings/useSettings.js';
import { ResourceEditor, type EditorContext } from './ResourceEditor.js';
import { SaveTemplateDialog } from './SaveTemplateDialog.js';
import { ADDABLE_KINDS, createResource, uniqueName } from './resource-templates.js';
import {
  useApply,
  useAvailabilityDomains,
  useDestroy,
  useDestroyManagedStack,
  useEngineLogs,
  useManagedStacks,
  useOutputs,
  usePlan,
  usePreview,
  useRefresh,
  useSavePlan,
  useShapes,
  type InfrastructureProgressState,
  type InfrastructureResourceProgress,
} from './useInfrastructure.js';

/** The Infrastructure module: compose a plan and preview/apply/destroy it. */
export function InfrastructurePage(): JSX.Element {
  const { data: projects } = useProjects();
  const { data: settings } = useSettings();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [resources, setResources] = useState<ResourceSpec[]>([]);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [streamId] = useState(() => crypto.randomUUID());
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [approvedPreview, setApprovedPreview] = useState<{
    fingerprint: string;
    result: PreviewResult;
  } | null>(null);

  const credentialId = projects?.find((p) => p.id === projectId)?.providerId ?? null;
  const shapes = useShapes(credentialId);
  const availabilityDomains = useAvailabilityDomains(credentialId);

  const { data: plan } = usePlan(projectId);
  const savePlan = useSavePlan();
  const preview = usePreview();
  const apply = useApply();
  const destroy = useDestroy();
  const refresh = useRefresh();
  const destroyManagedStack = useDestroyManagedStack();
  const managedStacks = useManagedStacks();
  const currentProject = projects?.find((project) => project.id === projectId);
  const currentRef = currentProject ? stackReference(currentProject) : null;
  const currentStackExists =
    currentRef !== null &&
    (managedStacks.data ?? []).some(
      ({ ref }) => ref.project === currentRef.project && ref.stack === currentRef.stack,
    );
  const outputs = useOutputs(projectId, currentStackExists);
  const sshConnections = useMemo(
    () => extractSshConnectionHints(outputs.data ?? {}),
    [outputs.data],
  );
  const { lines, progress, resources: resourceProgress, clear } = useEngineLogs(streamId);

  // Default to the first project and hydrate local state from its stored plan.
  useEffect(() => {
    if (projectId === null && projects && projects.length > 0) setProjectId(projects[0]!.id);
  }, [projects, projectId]);
  useEffect(() => {
    if (plan) {
      setResources([...plan.resources]);
      setConfig({ ...plan.config });
    } else {
      setResources([]);
      setConfig({});
    }
  }, [plan]);

  const currentPlan: InfrastructurePlan = useMemo(
    () => ({ providerKind: plan?.providerKind ?? 'oracle', config, resources }),
    [plan?.providerKind, config, resources],
  );
  const planFingerprint = useMemo(() => JSON.stringify(currentPlan), [currentPlan]);
  const currentPreview =
    approvedPreview?.fingerprint === planFingerprint ? approvedPreview.result : null;
  const issues = useMemo(() => validatePlan(currentPlan), [currentPlan]);
  const busy =
    preview.isPending ||
    apply.isPending ||
    destroy.isPending ||
    refresh.isPending ||
    destroyManagedStack.isPending ||
    savePlan.isPending;

  const editorContext: EditorContext = useMemo(
    () => ({
      networks: resources.filter((r) => r.kind === 'network').map((r) => r.name),
      subnets: resources.filter((r) => r.kind === 'subnet').map((r) => r.name),
      instances: resources.filter((r) => r.kind === 'compute').map((r) => r.name),
      shapes: shapes.data ?? [],
      availabilityDomains: availabilityDomains.data ?? [],
      liveLoading: shapes.isFetching || availabilityDomains.isFetching,
    }),
    [
      resources,
      shapes.data,
      shapes.isFetching,
      availabilityDomains.data,
      availabilityDomains.isFetching,
    ],
  );

  if (projects?.length === 0) {
    return (
      <>
        <PageHeader title="Infrastructure" description="Compose and provision cloud resources." />
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="font-medium">Create a project first</p>
            <Button asChild>
              <Link to="/projects">Go to Projects</Link>
            </Button>
          </CardContent>
        </Card>
        <ManagedStacksPanel
          stacks={managedStacks.data ?? []}
          projects={projects ?? []}
          busy={destroyManagedStack.isPending}
          onDestroy={(stack) => {
            if (!confirmDestroy(stack)) return;
            clear();
            destroyManagedStack.mutate(
              { ref: stack.ref, streamId },
              {
                onSuccess: () => toast.success('Managed cloud resources destroyed'),
                onError: (error) =>
                  toast.error(error instanceof IpcCallError ? error.message : 'Destroy failed'),
              },
            );
          }}
        />
      </>
    );
  }

  const addResource = (kind: ResourceKind): void => {
    setResources((prev) => [...prev, createResource(kind, uniqueName(prev, kind))]);
  };

  const persist = async (): Promise<boolean> => {
    if (!projectId) return false;
    try {
      await savePlan.mutateAsync({ projectId, plan: currentPlan });
      return true;
    } catch (error) {
      toast.error(error instanceof IpcCallError ? error.message : 'Failed to save plan');
      return false;
    }
  };

  const runOperation = async (
    operation: 'preview' | 'apply' | 'destroy' | 'refresh',
  ): Promise<void> => {
    if (!projectId) return;
    if (
      operation === 'destroy' &&
      (settings?.deployment.confirmDestructive ?? true) &&
      !window.confirm(
        'Destroy every cloud resource in this project stack and permanently remove its saved infrastructure plan? This cannot be undone.',
      )
    ) {
      return;
    }
    clear();
    if (operation !== 'destroy' && operation !== 'refresh' && !(await persist())) return;
    const onError = (error: Error): void => {
      toast.error(error instanceof IpcCallError ? error.message : `${operation} failed`);
    };
    if (operation === 'preview') {
      preview.mutate(
        { projectId, streamId },
        {
          onSuccess: (result) => {
            setApprovedPreview({ fingerprint: planFingerprint, result });
            toast.success('Preview complete');
          },
          onError,
        },
      );
      return;
    }
    if (operation === 'apply') {
      if (!currentPreview) {
        toast.error('Run Preview for the current plan before Apply.');
        return;
      }
      if (
        (currentPreview.hasReplacements || currentPreview.hasDeletes) &&
        !confirmDestructivePreview(currentPreview)
      )
        return;
      apply.mutate(
        { projectId, streamId, previewToken: currentPreview.previewToken },
        {
          onSuccess: () => {
            setApprovedPreview(null);
            toast.success('Apply complete');
          },
          onError,
        },
      );
      return;
    }
    if (operation === 'refresh') {
      refresh.mutate(
        { projectId, streamId },
        { onSuccess: () => toast.success('Refresh complete'), onError },
      );
      return;
    }
    destroy.mutate(
      { projectId, streamId },
      {
        onSuccess: () => {
          setResources([]);
          setConfig({});
          setApprovedPreview(null);
          toast.success('Cloud resources destroyed and saved plan removed');
        },
        onError,
      },
    );
  };

  return (
    <>
      <PageHeader
        title="Infrastructure"
        description="Compose a declarative plan, then preview, apply or destroy it."
        actions={
          <Select
            className="w-56"
            value={projectId ?? ''}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {projects?.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              <Plus className="size-4" /> Add resource
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {ADDABLE_KINDS.map(({ kind, label }) => (
              <DropdownMenuItem key={kind} onSelect={() => addResource(kind)}>
                {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="secondary" disabled={busy} onClick={() => void persist()}>
          <Save className="size-4" /> Save plan
        </Button>
        <Button
          variant="secondary"
          disabled={busy || resources.length === 0}
          onClick={() => setSavingTemplate(true)}
        >
          <BookmarkPlus className="size-4" /> Save as template
        </Button>
        <div className="bg-border mx-1 h-6 w-px" />
        <Button variant="outline" disabled={busy} onClick={() => void runOperation('preview')}>
          {preview.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Eye className="size-4" />
          )}
          Preview
        </Button>
        <Button
          disabled={busy || issues.length > 0 || !currentPreview}
          onClick={() => void runOperation('apply')}
        >
          {apply.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Hammer className="size-4" />
          )}
          Apply
        </Button>
        <Button variant="destructive" disabled={busy} onClick={() => void runOperation('destroy')}>
          <Trash className="size-4" /> Destroy
        </Button>
        <Button
          variant="outline"
          disabled={busy || !currentStackExists}
          onClick={() => void runOperation('refresh')}
        >
          {refresh.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          Refresh / detect drift
        </Button>
      </div>

      {issues.length > 0 ? (
        <Card className="border-destructive/40 mb-4">
          <CardContent className="py-3 text-sm">
            <p className="text-destructive mb-1 font-medium">Plan has issues</p>
            <ul className="text-muted-foreground list-inside list-disc">
              {issues.map((issue, index) => (
                <li key={index}>
                  <span className="text-foreground">{issue.resource}</span>: {issue.message}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          {resources.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="text-muted-foreground py-12 text-center text-sm">
                No resources yet. Use “Add resource” to compose your infrastructure.
              </CardContent>
            </Card>
          ) : (
            resources.map((resource, index) => (
              <ResourceEditor
                key={`${resource.kind}-${index}`}
                resource={resource}
                context={editorContext}
                onChange={(updated) =>
                  setResources((prev) => prev.map((r, i) => (i === index ? updated : r)))
                }
                onRemove={() => setResources((prev) => prev.filter((_, i) => i !== index))}
              />
            ))
          )}
        </div>

        <div className="space-y-2">
          <PreviewPanel preview={currentPreview} />
          <InfrastructureProgress progress={progress} resources={resourceProgress} />
          <p className="text-sm font-medium">Engine output</p>
          <LogTerminal lines={lines} emptyMessage="Run a preview or apply to see engine output." />
          {outputs.data ? (
            <Card>
              <CardContent className="py-4">
                <p className="mb-2 text-sm font-medium">Stack outputs</p>
                <dl className="space-y-2 text-sm">
                  {Object.entries(outputs.data).map(([key, value]) => (
                    <div key={key} className="flex flex-wrap justify-between gap-2">
                      <dt className="text-muted-foreground">{key}</dt>
                      <dd className="font-mono">{String(value)}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          ) : null}
          <SshConnectionPanel connections={sshConnections} />
        </div>
      </div>

      <ManagedStacksPanel
        stacks={managedStacks.data ?? []}
        projects={projects ?? []}
        busy={destroyManagedStack.isPending}
        onDestroy={(stack) => {
          if (!confirmDestroy(stack)) return;
          clear();
          destroyManagedStack.mutate(
            { ref: stack.ref, streamId },
            {
              onSuccess: () => toast.success('Managed cloud resources destroyed'),
              onError: (error) =>
                toast.error(error instanceof IpcCallError ? error.message : 'Destroy failed'),
            },
          );
        }}
      />

      <SaveTemplateDialog
        open={savingTemplate}
        onOpenChange={setSavingTemplate}
        plan={currentPlan}
      />
    </>
  );
}

function SshConnectionPanel({
  connections,
}: {
  connections: ReturnType<typeof extractSshConnectionHints>;
}): JSX.Element | null {
  if (connections.length === 0) return null;

  const copy = async (command: string): Promise<void> => {
    await navigator.clipboard.writeText(command);
    toast.success('SSH command copied');
  };

  return (
    <Card className="border-success/40">
      <CardContent className="space-y-4 py-4">
        <div className="flex items-start gap-2">
          <Terminal className="text-success mt-0.5 size-4 shrink-0" />
          <div>
            <p className="text-sm font-medium">Connect with SSH</p>
            <p className="text-muted-foreground text-xs">
              Use the private key matching the public key configured on this instance.
            </p>
          </div>
        </div>
        {connections.map((connection) => {
          const defaultCommand = formatSshCommand(connection);
          const identityCommand = formatSshCommand(connection, true);
          return (
            <div key={connection.resourceName} className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{connection.resourceName}</p>
                <Badge variant="success">{connection.user}</Badge>
              </div>
              <div className="bg-foreground text-background flex items-center gap-2 rounded-md px-3 py-2">
                <code className="min-w-0 flex-1 overflow-x-auto text-xs">{defaultCommand}</code>
                <Button
                  variant="secondary"
                  size="icon"
                  title="Copy SSH command"
                  onClick={() => void copy(defaultCommand)}
                >
                  <Copy className="size-4" />
                </Button>
              </div>
              <div className="bg-secondary flex items-center gap-2 rounded-md px-3 py-2">
                <code className="min-w-0 flex-1 overflow-x-auto text-xs">{identityCommand}</code>
                <Button
                  variant="outline"
                  size="icon"
                  title="Copy SSH command with private-key path"
                  onClick={() => void copy(identityCommand)}
                >
                  <Copy className="size-4" />
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                Replace <code>&lt;private-key-path&gt;</code> when the key is not loaded in your SSH
                agent. You can manage encrypted keys under{' '}
                <Link className="text-primary underline" to="/ssh-keys">
                  SSH Keys
                </Link>
                .
              </p>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function PreviewPanel({ preview }: { preview: PreviewResult | null }): JSX.Element | null {
  if (!preview) return null;
  const destructive = preview.hasReplacements || preview.hasDeletes;
  return (
    <Card className={destructive ? 'border-destructive/50' : 'border-success/40'}>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-medium">Preview changes</p>
            <p className="text-muted-foreground text-xs">
              This exact preview authorizes the next Apply. Editing the plan requires a new preview.
            </p>
          </div>
          <Badge variant={destructive ? 'destructive' : 'success'}>
            {destructive ? 'Destructive changes' : 'Safe to review'}
          </Badge>
        </div>
        {destructive ? (
          <div className="bg-destructive/10 text-destructive flex gap-2 rounded-md p-3 text-xs">
            <AlertTriangle className="size-4 shrink-0" />
            Replaced or deleted resources may lose data and public IP addresses.
          </div>
        ) : null}
        <div className="space-y-1.5">
          {preview.resources.length === 0 ? (
            <p className="text-muted-foreground text-sm">No changes.</p>
          ) : (
            preview.resources.map((change) => (
              <div
                key={change.urn}
                className="bg-secondary/50 flex items-start justify-between gap-3 rounded-md px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {change.type} · {change.name}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    {(change.replacementProperties.length
                      ? change.replacementProperties
                      : change.changedProperties
                    ).join(', ') || 'resource lifecycle'}
                  </p>
                </div>
                <Badge variant={change.destructive ? 'destructive' : 'secondary'}>
                  {change.operation}
                </Badge>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function confirmDestructivePreview(preview: PreviewResult): boolean {
  const destructive = preview.resources
    .filter((resource) => resource.destructive)
    .map((resource) => `${resource.operation.toUpperCase()}: ${resource.type} ${resource.name}`)
    .join('\n');
  return window.confirm(
    `This plan contains destructive infrastructure changes:\n\n${destructive}\n\nReplaced resources may be destroyed, public IPs may change, and data may be lost. Continue with this exact preview?`,
  );
}

function InfrastructureProgress({
  progress,
  resources,
}: {
  progress: InfrastructureProgressState | null;
  resources: readonly InfrastructureResourceProgress[];
}): JSX.Element | null {
  if (!progress) return null;
  const running = progress.status === 'preparing' || progress.status === 'in-progress';
  const ready = progress.status === 'ready';
  const failed = progress.status === 'failed';
  const destroyed = ready && progress.label.startsWith('Infrastructure destroyed');
  const completedLabel = destroyed ? 'Destroyed' : 'Ready';

  return (
    <Card
      className={
        failed ? 'border-destructive/40' : ready ? 'border-success/40' : 'border-primary/40'
      }
      aria-live="polite"
    >
      <CardContent className="space-y-3 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            {failed ? (
              <XCircle className="text-destructive mt-0.5 size-4 shrink-0" />
            ) : ready ? (
              <CheckCircle2 className="text-success mt-0.5 size-4 shrink-0" />
            ) : (
              <Loader2 className="text-primary mt-0.5 size-4 shrink-0 animate-spin" />
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {failed
                  ? 'Failed'
                  : ready
                    ? completedLabel
                    : 'Infrastructure operation in progress'}
              </p>
              <p className="text-muted-foreground truncate text-xs">{progress.label}</p>
            </div>
          </div>
          <Badge variant={failed ? 'destructive' : ready ? 'success' : 'default'}>
            {failed ? 'Failed' : ready ? completedLabel : 'In progress'}
          </Badge>
        </div>

        <div className="bg-secondary h-1.5 overflow-hidden rounded-full" role="progressbar">
          {running ? (
            <div className="progress-indeterminate bg-primary h-full w-1/3 rounded-full" />
          ) : (
            <div
              className={`h-full w-full rounded-full ${failed ? 'bg-destructive' : 'bg-success'}`}
            />
          )}
        </div>

        {resources.length > 0 ? (
          <div className="grid gap-1.5 sm:grid-cols-2">
            {resources.map((resource) => (
              <div
                key={`${resource.type}:${resource.name}`}
                className="bg-secondary/50 flex items-center gap-2 rounded-md px-2.5 py-2 text-xs"
              >
                {resource.status === 'failed' ? (
                  <XCircle className="text-destructive size-3.5 shrink-0" />
                ) : resource.status === 'ready' ? (
                  <CheckCircle2 className="text-success size-3.5 shrink-0" />
                ) : (
                  <Loader2 className="text-primary size-3.5 shrink-0 animate-spin" />
                )}
                <span className="truncate">
                  {resource.type} · {resource.name}
                </span>
                <span className="text-muted-foreground ml-auto capitalize">
                  {resource.status === 'ready'
                    ? resource.operation.startsWith('delete')
                      ? 'Deleted'
                      : 'Ready'
                    : resource.status}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {destroyed ? (
          <p className="text-muted-foreground text-xs">
            All managed cloud resources and the saved infrastructure plan are gone. Add resources or
            apply a template when you are ready to start again.
          </p>
        ) : null}

        {running ? (
          <p className="text-muted-foreground text-xs">
            Waiting for Oracle Cloud and Pulumi. Keep CloudForge open.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ManagedStacksPanel({
  stacks,
  projects,
  busy,
  onDestroy,
}: {
  stacks: readonly ManagedStackSummary[];
  projects: readonly ProjectDto[];
  busy: boolean;
  onDestroy: (stack: ManagedStackSummary) => void;
}): JSX.Element {
  if (stacks.length === 0) return <></>;
  const projectRefs = new Set(
    projects.map((project) => {
      const ref = stackReference(project);
      return `${ref.project}/${ref.stack}`;
    }),
  );

  return (
    <div className="mt-6 space-y-3">
      <div>
        <p className="font-medium">Managed cloud stacks</p>
        <p className="text-muted-foreground text-sm">
          Resources tracked by CloudForge, including stacks whose project record was removed.
        </p>
      </div>
      {stacks.map((stack) => {
        const key = `${stack.ref.project}/${stack.ref.stack}`;
        const orphaned = !projectRefs.has(key);
        return (
          <Card key={key} className={orphaned ? 'border-amber-500/40' : undefined}>
            <CardContent className="py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <ServerCog className="size-4" />
                    <span className="font-mono text-sm">{key}</span>
                    {orphaned ? <Badge variant="warning">Orphaned</Badge> : null}
                  </div>
                  <div className="text-muted-foreground mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    {stack.resources.map((resource) => (
                      <span key={`${resource.type}:${resource.name}`}>
                        {resource.name} · {resource.type}
                      </span>
                    ))}
                  </div>
                </div>
                <Button variant="destructive" disabled={busy} onClick={() => onDestroy(stack)}>
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash className="size-4" />
                  )}
                  Destroy stack
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function stackReference(project: ProjectDto): { project: string; stack: string } {
  const slug = project.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return {
    project: `${slug || 'project'}-${project.id.slice(0, 8)}`,
    stack: project.environment,
  };
}

function confirmDestroy(stack: ManagedStackSummary): boolean {
  const names = stack.resources.map((resource) => resource.name).join(', ');
  return window.confirm(
    `Destroy stack ${stack.ref.project}/${stack.ref.stack} and all ${stack.resources.length} tracked resources?\n\n${names}\n\nThis cannot be undone.`,
  );
}
