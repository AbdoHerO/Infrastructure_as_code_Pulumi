import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Boxes, Loader2, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Label,
  Select,
  Textarea,
  toast,
} from '@cloudforge/ui';
import {
  ENVIRONMENTS,
  isProvisioningProviderKind,
  PROVIDER_LABELS,
  type Environment,
  type ProjectDto,
} from '@cloudforge/core';
import { PageHeader } from '../../components/PageHeader.js';
import { IpcCallError } from '../../lib/ipc.js';
import { useCredentials } from '../secrets/useCredentials.js';
import { CreateProjectForm } from './CreateProjectForm.js';
import { statusVariant } from './project-status.js';
import { useDeleteProject, useProjects, useUpdateProject } from './useProjects.js';

/** The Projects module: create, list and delete infrastructure projects. */
export function ProjectsPage(): JSX.Element {
  const [creating, setCreating] = useState(false);
  const { data: projects, isLoading, isError } = useProjects();

  return (
    <>
      <PageHeader
        title="Projects"
        description="Each project represents one managed infrastructure."
        actions={
          !creating ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> New Project
            </Button>
          ) : undefined
        }
      />

      <AnimatePresence initial={false}>
        {creating ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-6 overflow-hidden"
          >
            <CreateProjectForm
              onCreated={() => setCreating(false)}
              onCancel={() => setCreating(false)}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading projects…</p>
      ) : isError ? (
        <p className="text-destructive text-sm">Failed to load projects.</p>
      ) : !projects || projects.length === 0 ? (
        <EmptyState onCreate={() => setCreating(true)} hidden={creating} />
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {projects.map((project) => (
            <ProjectRow key={project.id} project={project} />
          ))}
        </div>
      )}
    </>
  );
}

function ProjectRow({ project }: { project: ProjectDto }): JSX.Element {
  const deleteProject = useDeleteProject();
  const updateProject = useUpdateProject();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [region, setRegion] = useState(project.region);
  const [environment, setEnvironment] = useState<Environment>(project.environment);
  const [description, setDescription] = useState(project.description);

  const cancel = (): void => {
    setName(project.name);
    setRegion(project.region);
    setEnvironment(project.environment);
    setDescription(project.description);
    setEditing(false);
  };
  const save = (): void => {
    if (!name.trim()) {
      toast.error('Project name is required');
      return;
    }
    if (!region.trim()) {
      toast.error('Project region is required');
      return;
    }
    updateProject.mutate(
      {
        id: project.id,
        changes: {
          name: name.trim(),
          region: region.trim(),
          environment,
          description: description.trim(),
        },
      },
      {
        onSuccess: () => {
          setEditing(false);
          toast.success('Project configuration updated');
        },
        onError: (error) =>
          toast.error(error instanceof Error ? error.message : 'Failed to update project'),
      },
    );
  };

  if (editing) {
    return (
      <Card>
        <CardContent className="space-y-4 py-5">
          <div className="grid gap-4 md:grid-cols-2">
            <ProjectField label="Name">
              <Input
                value={name}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
              />
            </ProjectField>
            <ProjectField label="Region">
              <Input
                value={region}
                placeholder="af-casablanca-1"
                onChange={(event) => setRegion(event.target.value)}
              />
            </ProjectField>
            <ProjectField label="Environment">
              <Select
                value={environment}
                onChange={(event) => setEnvironment(event.target.value as Environment)}
              >
                {ENVIRONMENTS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </Select>
            </ProjectField>
            <ProjectField label="Cloud provider">
              <ProviderLink project={project} compact />
            </ProjectField>
          </div>
          <ProjectField label="Description">
            <Textarea
              value={description}
              placeholder="What does this infrastructure host?"
              onChange={(event) => setDescription(event.target.value)}
            />
          </ProjectField>
          <p className="text-muted-foreground text-xs">
            For projects without provisioned infrastructure, region changes are synchronized to the
            saved infrastructure plan. Stack identity and provider fields are protected after
            resources are created.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={updateProject.isPending} onClick={cancel}>
              <X className="size-4" /> Cancel
            </Button>
            <Button disabled={updateProject.isPending} onClick={save}>
              {updateProject.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              Save changes
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
        <div className="flex items-center gap-4">
          <div className="bg-secondary text-muted-foreground flex size-10 items-center justify-center rounded-lg">
            <Boxes className="size-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="font-medium">{project.name}</p>
              <Badge variant={statusVariant(project.status)}>{project.status}</Badge>
            </div>
            <p className="text-muted-foreground text-xs">
              {project.environment} · {project.region}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <ProviderLink project={project} />
          <Button variant="ghost" size="icon" title="Edit project" onClick={() => setEditing(true)}>
            <Pencil className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Delete project"
            disabled={deleteProject.isPending}
            onClick={() =>
              deleteProject.mutate(project.id, {
                onSuccess: () => toast.success(`Project "${project.name}" deleted`),
                onError: () => toast.error('Failed to delete project'),
              })
            }
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Inline selector that links (or clears) the cloud-provider credential a
 * project uses for provisioning. Required before Preview / Apply can run.
 */
function ProviderLink({
  project,
  compact = false,
}: {
  project: ProjectDto;
  compact?: boolean;
}): JSX.Element {
  const { data: credentials } = useCredentials();
  const updateProject = useUpdateProject();
  const providerCredentials = (credentials ?? []).filter((c) => isProvisioningProviderKind(c.kind));

  const change = (providerId: string): void => {
    updateProject.mutate(
      { id: project.id, changes: { providerId: providerId || null } },
      {
        onSuccess: () =>
          toast.success(providerId ? 'Cloud provider linked' : 'Cloud provider unlinked'),
        onError: (error) =>
          toast.error(error instanceof IpcCallError ? error.message : 'Failed to update project'),
      },
    );
  };

  return (
    <div className="flex flex-col gap-1">
      {!compact ? (
        <Label className="text-muted-foreground text-[11px] uppercase tracking-wide">
          Cloud provider
        </Label>
      ) : null}
      <Select
        className={compact ? 'h-9 w-full' : 'h-9 w-56'}
        value={project.providerId ?? ''}
        disabled={updateProject.isPending || providerCredentials.length === 0}
        onChange={(event) => change(event.target.value)}
      >
        <option value="">
          {providerCredentials.length === 0 ? 'Add one in Cloud Providers' : 'None (not linked)'}
        </option>
        {providerCredentials.map((credential) => (
          <option key={credential.id} value={credential.id}>
            {credential.name} ({PROVIDER_LABELS[credential.kind as keyof typeof PROVIDER_LABELS]})
          </option>
        ))}
      </Select>
    </div>
  );
}

function ProjectField({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function EmptyState({ onCreate, hidden }: { onCreate: () => void; hidden: boolean }): JSX.Element {
  if (hidden) return <></>;
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <div className="bg-secondary text-muted-foreground flex size-14 items-center justify-center rounded-2xl">
          <Boxes className="size-7" />
        </div>
        <div className="space-y-1">
          <p className="font-medium">No projects yet</p>
          <p className="text-muted-foreground text-sm">
            Create your first project to start managing infrastructure.
          </p>
        </div>
        <Button onClick={onCreate}>
          <Plus className="size-4" /> New Project
        </Button>
      </CardContent>
    </Card>
  );
}
