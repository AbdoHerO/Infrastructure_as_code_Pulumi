import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookmarkPlus, Eye, Hammer, Loader2, Plus, Save, ServerCog, Trash } from 'lucide-react';
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
  type ProjectDto,
  type ResourceKind,
  type ResourceSpec,
  validatePlan,
} from '@cloudforge/core';
import { IpcCallError } from '../../lib/ipc.js';
import { PageHeader } from '../../components/PageHeader.js';
import { useProjects } from '../projects/useProjects.js';
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
  useSavePlan,
  useShapes,
} from './useInfrastructure.js';

/** The Infrastructure module: compose a plan and preview/apply/destroy it. */
export function InfrastructurePage(): JSX.Element {
  const { data: projects } = useProjects();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [resources, setResources] = useState<ResourceSpec[]>([]);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [streamId] = useState(() => crypto.randomUUID());
  const [savingTemplate, setSavingTemplate] = useState(false);

  const credentialId = projects?.find((p) => p.id === projectId)?.providerId ?? null;
  const shapes = useShapes(credentialId);
  const availabilityDomains = useAvailabilityDomains(credentialId);

  const { data: plan } = usePlan(projectId);
  const savePlan = useSavePlan();
  const preview = usePreview();
  const apply = useApply();
  const destroy = useDestroy();
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
  const { lines, clear } = useEngineLogs(streamId);

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
  const issues = useMemo(() => validatePlan(currentPlan), [currentPlan]);
  const busy =
    preview.isPending ||
    apply.isPending ||
    destroy.isPending ||
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

  const runOperation = async (operation: 'preview' | 'apply' | 'destroy'): Promise<void> => {
    if (!projectId) return;
    if (
      operation === 'destroy' &&
      !window.confirm('Destroy every cloud resource in this project stack? This cannot be undone.')
    ) {
      return;
    }
    clear();
    if (operation !== 'destroy' && !(await persist())) return;
    const mutation = operation === 'preview' ? preview : operation === 'apply' ? apply : destroy;
    mutation.mutate(
      { projectId, streamId },
      {
        onSuccess: () => toast.success(`${operation} complete`),
        onError: (error) =>
          toast.error(error instanceof IpcCallError ? error.message : `${operation} failed`),
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
        <Button disabled={busy || issues.length > 0} onClick={() => void runOperation('apply')}>
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
