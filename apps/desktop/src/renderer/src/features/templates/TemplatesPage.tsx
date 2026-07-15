import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Boxes, Bookmark, Cpu, Database, KeyRound, Network, Rocket, Trash2 } from 'lucide-react';
import { Badge, Button, Card, CardContent, Select, toast } from '@cloudforge/ui';
import type { CustomTemplateSummary, InfrastructureTemplateSummary } from '@cloudforge/core';
import { invoke, IpcCallError } from '../../lib/ipc.js';
import { PageHeader } from '../../components/PageHeader.js';
import { useConfirmation } from '../../components/ConfirmationDialogProvider.js';
import { useProjects } from '../projects/useProjects.js';
import { useCredentials } from '../secrets/useCredentials.js';
import {
  useApplyCustomTemplate,
  useCustomTemplates,
  useDeleteTemplate,
} from '../infrastructure/useInfrastructure.js';
import { useSshKeys } from '../ssh-keys/useSshKeys.js';

const CATEGORY_ICON = {
  compute: Cpu,
  data: Database,
  ai: Boxes,
  network: Network,
} as const;

/** The Templates module: infrastructure and deployment templates. */
export function TemplatesPage(): JSX.Element {
  const confirm = useConfirmation();
  const navigate = useNavigate();
  const { data: projects } = useProjects();
  const { data: credentials } = useCredentials();
  const sshKeys = useSshKeys();
  const [projectId, setProjectId] = useState('');
  const [sshKeyId, setSshKeyId] = useState('');
  const selectedProject = projects?.find((project) => project.id === projectId);
  const selectedProviderKind = credentials?.find(
    (credential) => credential.id === selectedProject?.providerId,
  )?.kind;
  const infraTemplates = useQuery({
    queryKey: ['infra', 'templates'],
    queryFn: () => invoke('infra:templates', undefined),
    staleTime: Infinity,
  });
  const visibleInfraTemplates = infraTemplates.data?.filter(
    (template) => !selectedProviderKind || template.providerKind === selectedProviderKind,
  );
  const deployTemplates = useQuery({
    queryKey: ['deploy', 'templates'],
    queryFn: () => invoke('deploy:templates', undefined),
    staleTime: Infinity,
  });
  const applyTemplate = useMutation({
    mutationFn: (args: {
      projectId: string;
      templateId: string;
      sshPublicKey: string;
      sshCredentialId: string;
    }) => invoke('infra:applyTemplate', args),
  });
  const customTemplates = useCustomTemplates();
  const applyCustom = useApplyCustomTemplate();
  const deleteCustom = useDeleteTemplate();

  useEffect(() => {
    if (!projectId && projects && projects.length > 0) setProjectId(projects[0]!.id);
  }, [projects, projectId]);
  useEffect(() => {
    if (!sshKeyId && sshKeys.data?.length) setSshKeyId(sshKeys.data[0]!.id);
  }, [sshKeys.data, sshKeyId]);

  const apply = (template: InfrastructureTemplateSummary): void => {
    if (!projectId) {
      toast.error('Create a project first');
      return;
    }
    const sshKey = sshKeys.data?.find((key) => key.id === sshKeyId);
    if (!sshKey) {
      toast.error('Select an SSH key before applying a VPS template');
      return;
    }
    applyTemplate.mutate(
      {
        projectId,
        templateId: template.id,
        sshPublicKey: sshKey.publicKey,
        sshCredentialId: sshKey.id,
      },
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

  const applyCustomTemplate = (template: CustomTemplateSummary): void => {
    if (!projectId) {
      toast.error('Create a project first');
      return;
    }
    applyCustom.mutate(
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

  const removeCustomTemplate = async (template: CustomTemplateSummary): Promise<void> => {
    if (
      !(await confirm({
        title: 'Delete template?',
        description: `Delete the reusable template “${template.name}”? Existing project plans are not changed.`,
        confirmLabel: 'Delete template',
      }))
    )
      return;
    deleteCustom.mutate(template.id, {
      onSuccess: () => toast.success(`Deleted "${template.name}"`),
      onError: () => toast.error('Failed to delete template'),
    });
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
      <Card className="mb-4">
        <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
          <div className="flex flex-1 items-center gap-3">
            <KeyRound className="text-muted-foreground size-5" />
            <div>
              <p className="text-sm font-medium">SSH access key</p>
              <p className="text-muted-foreground text-xs">
                Its public key enters the instance; the encrypted private key remains in CloudForge.
              </p>
            </div>
          </div>
          <Select
            className="sm:w-72"
            value={sshKeyId}
            onChange={(event) => setSshKeyId(event.target.value)}
          >
            <option value="">Select an SSH key…</option>
            {(sshKeys.data ?? []).map((key) => (
              <option key={key.id} value={key.id}>
                {key.name} · {key.algorithm}
              </option>
            ))}
          </Select>
          <Button variant="ghost" onClick={() => navigate('/ssh-keys')}>
            Manage keys
          </Button>
        </CardContent>
      </Card>
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {visibleInfraTemplates?.map((template) => {
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

      {customTemplates.data && customTemplates.data.length > 0 ? (
        <>
          <h2 className="text-muted-foreground mb-3 text-sm font-semibold">Your templates</h2>
          <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {customTemplates.data.map((template) => (
              <Card key={template.id}>
                <CardContent className="space-y-3 py-5">
                  <div className="flex items-center gap-3">
                    <div className="bg-secondary text-muted-foreground flex size-10 items-center justify-center rounded-lg">
                      <Bookmark className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate font-medium">{template.name}</p>
                      <Badge variant="secondary">custom</Badge>
                    </div>
                  </div>
                  <p className="text-muted-foreground line-clamp-2 text-sm">
                    {template.description || 'No description.'}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      className="flex-1"
                      variant="outline"
                      disabled={applyCustom.isPending}
                      onClick={() => applyCustomTemplate(template)}
                    >
                      Apply to project
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Delete template"
                      disabled={deleteCustom.isPending}
                      onClick={() => void removeCustomTemplate(template)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      ) : null}

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
