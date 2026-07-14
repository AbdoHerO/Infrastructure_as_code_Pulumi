import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Boxes, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Card, CardContent, Label, Select, toast } from '@cloudforge/ui';
import { isProvisioningProviderKind, PROVIDER_LABELS, type ProjectDto } from '@cloudforge/core';
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
function ProviderLink({ project }: { project: ProjectDto }): JSX.Element {
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
      <Label className="text-muted-foreground text-[11px] uppercase tracking-wide">
        Cloud provider
      </Label>
      <Select
        className="h-9 w-56"
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
