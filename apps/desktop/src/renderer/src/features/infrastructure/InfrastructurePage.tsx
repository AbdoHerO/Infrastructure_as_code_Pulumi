import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Eye, Hammer, Loader2, Plus, Save, Trash } from 'lucide-react';
import {
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
  type ResourceKind,
  type ResourceSpec,
  validatePlan,
} from '@cloudforge/core';
import { IpcCallError } from '../../lib/ipc.js';
import { PageHeader } from '../../components/PageHeader.js';
import { useProjects } from '../projects/useProjects.js';
import { ResourceEditor, type EditorContext } from './ResourceEditor.js';
import { ADDABLE_KINDS, createResource, uniqueName } from './resource-templates.js';
import {
  useApply,
  useAvailabilityDomains,
  useDestroy,
  useEngineLogs,
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

  const credentialId = projects?.find((p) => p.id === projectId)?.providerId ?? null;
  const shapes = useShapes(credentialId);
  const availabilityDomains = useAvailabilityDomains(credentialId);

  const { data: plan } = usePlan(projectId);
  const savePlan = useSavePlan();
  const preview = usePreview();
  const apply = useApply();
  const destroy = useDestroy();
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
  const busy = preview.isPending || apply.isPending || destroy.isPending || savePlan.isPending;

  const editorContext: EditorContext = useMemo(
    () => ({
      networks: resources.filter((r) => r.kind === 'network').map((r) => r.name),
      subnets: resources.filter((r) => r.kind === 'subnet').map((r) => r.name),
      instances: resources.filter((r) => r.kind === 'compute').map((r) => r.name),
      shapes: shapes.data ?? [],
      availabilityDomains: availabilityDomains.data ?? [],
      liveLoading: shapes.isFetching || availabilityDomains.isFetching,
    }),
    [resources, shapes.data, shapes.isFetching, availabilityDomains.data, availabilityDomains.isFetching],
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
        </div>
      </div>
    </>
  );
}
