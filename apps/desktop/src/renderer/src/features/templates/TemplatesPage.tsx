import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Boxes, Cpu, Database, Network, Rocket } from 'lucide-react';
import { Badge, Button, Card, CardContent, Select, toast } from '@cloudforge/ui';
import type { InfrastructureTemplateSummary } from '@cloudforge/core';
import { invoke, IpcCallError } from '../../lib/ipc.js';
import { PageHeader } from '../../components/PageHeader.js';
import { useProjects } from '../projects/useProjects.js';

const CATEGORY_ICON = {
  compute: Cpu,
  data: Database,
  ai: Boxes,
  network: Network,
} as const;

/** The Templates module: infrastructure and deployment templates. */
export function TemplatesPage(): JSX.Element {
  const navigate = useNavigate();
  const { data: projects } = useProjects();
  const [projectId, setProjectId] = useState('');

  const infraTemplates = useQuery({
    queryKey: ['infra', 'templates'],
    queryFn: () => invoke('infra:templates', undefined),
    staleTime: Infinity,
  });
  const deployTemplates = useQuery({
    queryKey: ['deploy', 'templates'],
    queryFn: () => invoke('deploy:templates', undefined),
    staleTime: Infinity,
  });
  const applyTemplate = useMutation({
    mutationFn: (args: { projectId: string; templateId: string }) =>
      invoke('infra:applyTemplate', args),
  });

  useEffect(() => {
    if (!projectId && projects && projects.length > 0) setProjectId(projects[0]!.id);
  }, [projects, projectId]);

  const apply = (template: InfrastructureTemplateSummary): void => {
    if (!projectId) {
      toast.error('Create a project first');
      return;
    }
    applyTemplate.mutate(
      { projectId, templateId: template.id },
      {
        onSuccess: () => {
          toast.success(`Applied "${template.name}" to the project`);
          navigate('/infrastructure');
        },
        onError: (error) =>
          toast.error(error instanceof IpcCallError ? error.message : 'Failed to apply template'),
      },
    );
  };

  return (
    <>
      <PageHeader
        title="Templates"
        description="Reusable infrastructure and deployment blueprints."
        actions={
          projects && projects.length > 0 ? (
            <Select
              className="w-56"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          ) : undefined
        }
      />

      <h2 className="text-muted-foreground mb-3 text-sm font-semibold">Infrastructure</h2>
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {infraTemplates.data?.map((template) => {
          const Icon = CATEGORY_ICON[template.category];
          return (
            <Card key={template.id}>
              <CardContent className="space-y-3 py-5">
                <div className="flex items-center gap-3">
                  <div className="bg-secondary text-muted-foreground flex size-10 items-center justify-center rounded-lg">
                    <Icon className="size-5" />
                  </div>
                  <div>
                    <p className="font-medium">{template.name}</p>
                    <Badge variant="secondary">{template.category}</Badge>
                  </div>
                </div>
                <p className="text-muted-foreground text-sm">{template.description}</p>
                <Button
                  className="w-full"
                  variant="outline"
                  disabled={applyTemplate.isPending}
                  onClick={() => apply(template)}
                >
                  Apply to project
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <h2 className="text-muted-foreground mb-3 text-sm font-semibold">Deployment</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {deployTemplates.data?.map((template) => (
          <Card key={template.id}>
            <CardContent className="space-y-3 py-5">
              <div className="flex items-center gap-3">
                <div className="bg-secondary text-muted-foreground flex size-10 items-center justify-center rounded-lg">
                  <Rocket className="size-5" />
                </div>
                <p className="font-medium">{template.name}</p>
              </div>
              <p className="text-muted-foreground text-sm">{template.description}</p>
              <Button className="w-full" variant="ghost" onClick={() => navigate('/deployments')}>
                Use in Deployments
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
