import { useEffect, useState, type ReactNode } from 'react';
import { Boxes, KeyRound, Loader2, LockKeyhole, Save, Trash2 } from 'lucide-react';
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
} from '@cloudforge/core';
import { PageHeader } from '../../components/PageHeader.js';
import { NameConfirmationDialog } from '../../components/NameConfirmationDialog.js';
import { invoke, IpcCallError } from '../../lib/ipc.js';
import { useCredentials } from '../secrets/useCredentials.js';
import { statusVariant } from './project-status.js';
import { useUpdateProject } from './useProjects.js';
import { useWorkspace } from './WorkspaceContext.js';

/** Settings for the currently opened workspace; other projects remain locked. */
export function ProjectsPage(): JSX.Element {
  const { session, refreshSession, deleteCurrent, lock } = useWorkspace();
  const project = session!.project;
  const { data: credentials } = useCredentials();
  const updateProject = useUpdateProject();
  const providerCredentials = (credentials ?? []).filter((credential) =>
    isProvisioningProviderKind(credential.kind),
  );
  const [name, setName] = useState(project.name);
  const [region, setRegion] = useState(project.region);
  const [environment, setEnvironment] = useState<Environment>(project.environment);
  const [description, setDescription] = useState(project.description);
  const [icon, setIcon] = useState(project.icon);
  const [color, setColor] = useState(project.color || '#5146e5');
  const [providerId, setProviderId] = useState(project.providerId ?? '');
  const [currentPasskey, setCurrentPasskey] = useState('');
  const [newPasskey, setNewPasskey] = useState('');
  const [confirmPasskey, setConfirmPasskey] = useState('');
  const [changingPasskey, setChangingPasskey] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setName(project.name);
    setRegion(project.region);
    setEnvironment(project.environment);
    setDescription(project.description);
    setIcon(project.icon);
    setColor(project.color || '#5146e5');
    setProviderId(project.providerId ?? '');
  }, [project]);

  const save = async (): Promise<void> => {
    if (!name.trim() || !region.trim()) {
      toast.error('Project name and region are required');
      return;
    }
    try {
      await updateProject.mutateAsync({
        id: project.id,
        changes: {
          name: name.trim(),
          region: region.trim(),
          environment,
          description: description.trim(),
          icon,
          color,
          providerId: providerId || null,
        },
      });
      await refreshSession();
      toast.success('Project settings saved');
    } catch (error) {
      toast.error(error instanceof IpcCallError ? error.message : 'Failed to update project');
    }
  };

  const changePasskey = async (): Promise<void> => {
    if (newPasskey.length < 8) {
      toast.error('New passkey must contain at least 8 characters');
      return;
    }
    if (newPasskey !== confirmPasskey) {
      toast.error('New passkeys do not match');
      return;
    }
    setChangingPasskey(true);
    try {
      await invoke('projects:changePasskey', { currentPasskey, newPasskey });
      setCurrentPasskey('');
      setNewPasskey('');
      setConfirmPasskey('');
      await refreshSession();
      toast.success('Project passkey changed');
    } catch (error) {
      toast.error(error instanceof IpcCallError ? error.message : 'Failed to change passkey');
    } finally {
      setChangingPasskey(false);
    }
  };

  const remove = async (): Promise<void> => {
    setDeleting(true);
    try {
      await deleteCurrent();
      toast.success(`Project “${project.name}” deleted`);
    } catch (error) {
      toast.error(error instanceof IpcCallError ? error.message : 'Failed to delete project');
      setDeleting(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Project Settings"
        description="Configure the currently opened, isolated workspace."
        actions={
          <Button variant="outline" onClick={() => void lock()}>
            <LockKeyhole className="size-4" /> Lock / switch
          </Button>
        }
      />

      <Card className="mb-5 overflow-hidden">
        <div className="h-1.5" style={{ backgroundColor: project.color || color }} />
        <CardContent className="flex items-center gap-4 py-5">
          <div className="bg-secondary grid size-12 place-items-center rounded-xl text-xl">
            {project.icon || <Boxes className="size-5" />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-semibold">{project.name}</h2>
              <Badge variant={statusVariant(project.status)}>{project.status}</Badge>
            </div>
            <p className="text-muted-foreground text-sm">
              {project.environment} · {project.region} · created{' '}
              {new Date(project.createdAt).toLocaleDateString()}
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardContent className="space-y-4 py-6">
            <div>
              <h2 className="font-semibold">Workspace details</h2>
              <p className="text-muted-foreground text-sm">
                These values belong only to this project.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Region">
                <Input value={region} onChange={(e) => setRegion(e.target.value)} />
              </Field>
              <Field label="Environment">
                <Select
                  value={environment}
                  onChange={(e) => setEnvironment(e.target.value as Environment)}
                >
                  {ENVIRONMENTS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Cloud provider">
                <Select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                  <option value="">None</option>
                  {providerCredentials.map((credential) => (
                    <option key={credential.id} value={credential.id}>
                      {credential.name} (
                      {PROVIDER_LABELS[credential.kind as keyof typeof PROVIDER_LABELS]})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Icon">
                <Input value={icon} maxLength={8} onChange={(e) => setIcon(e.target.value)} />
              </Field>
              <Field label="Color">
                <Input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
              </Field>
            </div>
            <Field label="Description">
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <div className="flex justify-end">
              <Button disabled={updateProject.isPending} onClick={() => void save()}>
                {updateProject.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
                Save settings
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardContent className="space-y-4 py-6">
              <div className="flex gap-3">
                <KeyRound className="text-muted-foreground mt-0.5 size-5" />
                <div>
                  <h2 className="font-semibold">Change passkey</h2>
                  <p className="text-muted-foreground text-sm">
                    Unlocking this project never unlocks any other workspace.
                  </p>
                </div>
              </div>
              {project.hasPasskey ? (
                <Field label="Current passkey">
                  <Input
                    type="password"
                    autoComplete="current-password"
                    value={currentPasskey}
                    onChange={(e) => setCurrentPasskey(e.target.value)}
                  />
                </Field>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="New passkey">
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={newPasskey}
                    onChange={(e) => setNewPasskey(e.target.value)}
                  />
                </Field>
                <Field label="Confirm new passkey">
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={confirmPasskey}
                    onChange={(e) => setConfirmPasskey(e.target.value)}
                  />
                </Field>
              </div>
              <Button
                variant="outline"
                disabled={changingPasskey}
                onClick={() => void changePasskey()}
              >
                {changingPasskey ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <KeyRound className="size-4" />
                )}
                Update passkey
              </Button>
            </CardContent>
          </Card>

          <Card className="border-destructive/30">
            <CardContent className="space-y-3 py-6">
              <h2 className="text-destructive font-semibold">Danger zone</h2>
              <p className="text-muted-foreground text-sm">
                Delete this workspace only after destroying its managed cloud stack. The exact
                project name is required for confirmation.
              </p>
              <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="size-4" /> Delete project
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
      <NameConfirmationDialog
        open={deleteOpen}
        title="Delete this project?"
        description={`Permanently delete “${project.name}” and all of its CloudForge configuration? Managed cloud resources must be destroyed first. Other projects are not affected.`}
        expectedName={project.name}
        confirmLabel="Delete project"
        pending={deleting}
        onOpenChange={setDeleteOpen}
        onConfirm={() => void remove()}
      />
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
