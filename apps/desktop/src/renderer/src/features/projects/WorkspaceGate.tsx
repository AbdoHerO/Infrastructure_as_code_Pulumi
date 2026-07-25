import { useState, type ReactNode } from 'react';
import {
  ArrowRight,
  Boxes,
  CalendarClock,
  Cloud,
  FolderLock,
  LoaderCircle,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { Button, Card, Input, Label, Select, Textarea, toast } from '@cloudforge/ui';
import type { CreateProjectInput, ProjectPickerDto } from '@cloudforge/core';
import { IpcCallError } from '../../lib/ipc.js';
import { useWorkspace } from './WorkspaceContext.js';

/** Prevents all workspace-scoped routes from mounting until a project is unlocked. */
export function WorkspaceGate({ children }: { children: ReactNode }): JSX.Element {
  const { loading, session } = useWorkspace();
  if (loading) return <WorkspaceLoading />;
  if (!session) return <ProjectPicker />;
  return <>{children}</>;
}

function WorkspaceLoading(): JSX.Element {
  return (
    <div className="bg-background text-foreground grid h-full place-items-center">
      <div className="flex items-center gap-3 text-sm">
        <LoaderCircle className="text-primary size-5 animate-spin" />
        Loading CloudForge workspaces…
      </div>
    </div>
  );
}

function ProjectPicker(): JSX.Element {
  const { projects } = useWorkspace();
  const [creating, setCreating] = useState(projects.length === 0);

  return (
    <div className="bg-background text-foreground h-full overflow-y-auto">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="bg-primary/10 absolute -top-40 left-1/3 size-[34rem] rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-0 size-[28rem] rounded-full bg-sky-500/10 blur-3xl" />
      </div>
      <main className="relative mx-auto flex min-h-full w-full max-w-6xl flex-col px-8 py-12">
        <header className="mb-10 flex items-start justify-between gap-6">
          <div className="flex items-center gap-4">
            <div className="bg-primary text-primary-foreground grid size-12 place-items-center rounded-2xl shadow-lg">
              <span className="text-sm font-bold">CF</span>
            </div>
            <div>
              <p className="text-muted-foreground text-sm">Modern Infrastructure Platform</p>
              <h1 className="text-3xl font-semibold tracking-tight">Welcome to CloudForge</h1>
            </div>
          </div>
          {projects.length > 0 && !creating ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> New project
            </Button>
          ) : null}
        </header>

        {creating ? (
          <CreateWorkspace
            first={projects.length === 0}
            onCancel={projects.length === 0 ? undefined : () => setCreating(false)}
          />
        ) : (
          <div className="space-y-5">
            <div>
              <h2 className="text-xl font-semibold">Choose a project</h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Each project is an isolated workspace with its own infrastructure, secrets and
                runtime.
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {projects.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function ProjectCard({ project }: { project: ProjectPickerDto }): JSX.Element {
  const { unlock } = useWorkspace();
  const [passkey, setPasskey] = useState('');
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');

  const open = async (): Promise<void> => {
    setOpening(true);
    setError('');
    try {
      await unlock(project.id, passkey);
    } catch (cause) {
      setError(cause instanceof IpcCallError ? cause.message : 'Could not open this project');
    } finally {
      setOpening(false);
    }
  };

  return (
    <Card className="group relative overflow-hidden p-5 transition-shadow hover:shadow-md">
      <div
        className="absolute inset-x-0 top-0 h-1"
        style={{ backgroundColor: project.color || 'hsl(var(--primary))' }}
      />
      <div className="mb-5 flex items-start gap-3">
        <div
          className="bg-secondary grid size-11 shrink-0 place-items-center rounded-xl text-xl"
          style={project.color ? { color: project.color } : undefined}
        >
          {project.icon || <Boxes className="size-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold">{project.name}</h3>
          <p className="text-muted-foreground mt-0.5 line-clamp-2 min-h-10 text-sm">
            {project.description || 'Infrastructure workspace'}
          </p>
        </div>
        <LockKeyhole className="text-muted-foreground size-4" />
      </div>

      <div className="text-muted-foreground mb-4 grid grid-cols-2 gap-2 text-xs">
        <span className="bg-secondary/60 flex items-center gap-1.5 rounded-md px-2 py-1.5">
          <Cloud className="size-3" /> {project.environment}
        </span>
        <span className="bg-secondary/60 truncate rounded-md px-2 py-1.5">{project.region}</span>
        <span className="col-span-2 flex items-center gap-1.5">
          <CalendarClock className="size-3" />
          {project.lastOpenedAt
            ? `Opened ${new Date(project.lastOpenedAt).toLocaleString()}`
            : 'Never opened'}
        </span>
      </div>
      <div className="bg-muted/50 text-muted-foreground mb-4 rounded-lg px-3 py-2 text-xs">
        {project.summary.infrastructureConfigured ? 'Infrastructure configured' : 'No plan yet'}
        {' · '}
        {project.summary.targetCount} target{project.summary.targetCount === 1 ? '' : 's'}
        {' · '}
        {project.summary.pipelineCount} pipeline
        {project.summary.pipelineCount === 1 ? '' : 's'}
        {' · '}
        {project.summary.deploymentCount} deployment
        {project.summary.deploymentCount === 1 ? '' : 's'}
      </div>

      {project.hasPasskey ? (
        <Input
          type="password"
          value={passkey}
          autoComplete="current-password"
          placeholder="Project passkey"
          aria-label={`Passkey for ${project.name}`}
          onChange={(event) => setPasskey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void open();
          }}
        />
      ) : (
        <div className="border-border bg-secondary/40 text-muted-foreground flex h-9 items-center gap-2 rounded-md border px-3 text-xs">
          <ShieldCheck className="size-3.5" /> Migrated workspace · no passkey yet
        </div>
      )}
      {error ? <p className="text-destructive mt-2 text-xs">{error}</p> : null}
      <Button
        className="mt-3 w-full"
        disabled={opening || (project.hasPasskey && passkey.length === 0)}
        onClick={() => void open()}
      >
        {opening ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <ArrowRight className="size-4" />
        )}
        {opening ? 'Opening…' : 'Open project'}
      </Button>
    </Card>
  );
}

function CreateWorkspace({
  first,
  onCancel,
}: {
  first: boolean;
  onCancel?: (() => void) | undefined;
}): JSX.Element {
  const { create, unlock } = useWorkspace();
  const [form, setForm] = useState({
    name: '',
    description: '',
    environment: 'development',
    region: 'af-casablanca-1',
    icon: '☁️',
    color: '#5146e5',
    passkey: '',
    confirmation: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (): Promise<void> => {
    if (!form.name.trim()) return setError('Project name is required');
    if (!form.region.trim()) return setError('Region is required');
    if (form.passkey.length < 8) return setError('Passkey must contain at least 8 characters');
    if (form.passkey !== form.confirmation) return setError('Passkeys do not match');
    setSaving(true);
    setError('');
    try {
      const input: CreateProjectInput = {
        name: form.name,
        description: form.description,
        environment: form.environment,
        region: form.region,
        icon: form.icon,
        color: form.color,
        passkey: form.passkey,
      };
      const project = await create(input);
      await unlock(project.id, form.passkey);
      toast.success(`Project “${project.name}” created`);
    } catch (cause) {
      setError(cause instanceof IpcCallError ? cause.message : 'Could not create the project');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-8 lg:grid-cols-[0.8fr_1.2fr]">
      <section className="space-y-5 pt-4">
        <div className="bg-primary/10 text-primary grid size-11 place-items-center rounded-xl">
          <Sparkles className="size-5" />
        </div>
        <div>
          <h2 className="text-2xl font-semibold">
            {first ? 'Create your first project' : 'Create another project'}
          </h2>
          <p className="text-muted-foreground mt-2 leading-6">
            A project isolates providers, credentials, VPS targets, deployments, DNS, certificates,
            logs and runtime state.
          </p>
        </div>
        <div className="text-muted-foreground space-y-3 text-sm">
          <p className="flex items-center gap-2">
            <FolderLock className="text-primary size-4" /> Encrypted, project-scoped secrets
          </p>
          <p className="flex items-center gap-2">
            <ShieldCheck className="text-primary size-4" /> Clean teardown when switching
          </p>
          <p className="flex items-center gap-2">
            <Boxes className="text-primary size-4" /> Independent runtime topology
          </p>
        </div>
      </section>

      <Card className="p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Project name">
            <Input
              value={form.name}
              placeholder="HanoutPlus Production"
              autoFocus
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <Field label="Environment">
            <Select
              value={form.environment}
              onChange={(event) => setForm({ ...form, environment: event.target.value })}
            >
              <option value="development">development</option>
              <option value="staging">staging</option>
              <option value="production">production</option>
            </Select>
          </Field>
          <Field label="Region">
            <Input
              value={form.region}
              placeholder="af-casablanca-1"
              onChange={(event) => setForm({ ...form, region: event.target.value })}
            />
          </Field>
          <div className="grid grid-cols-[1fr_2fr] gap-3">
            <Field label="Icon">
              <Input
                value={form.icon}
                maxLength={8}
                onChange={(event) => setForm({ ...form, icon: event.target.value })}
              />
            </Field>
            <Field label="Color">
              <Input
                type="color"
                value={form.color}
                onChange={(event) => setForm({ ...form, color: event.target.value })}
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Description (optional)">
              <Textarea
                value={form.description}
                placeholder="What infrastructure belongs to this workspace?"
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </Field>
          </div>
          <Field label="Project passkey">
            <Input
              type="password"
              autoComplete="new-password"
              value={form.passkey}
              placeholder="At least 8 characters"
              onChange={(event) => setForm({ ...form, passkey: event.target.value })}
            />
          </Field>
          <Field label="Confirm passkey">
            <Input
              type="password"
              autoComplete="new-password"
              value={form.confirmation}
              onChange={(event) => setForm({ ...form, confirmation: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
              }}
            />
          </Field>
        </div>
        <p className="text-muted-foreground mt-3 text-xs">
          The passkey is hashed locally and never stored in plaintext. It protects only this
          project.
        </p>
        {error ? <p className="text-destructive mt-3 text-sm">{error}</p> : null}
        <div className="mt-6 flex justify-end gap-2">
          {onCancel ? (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button disabled={saving} onClick={() => void submit()}>
            {saving ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            {saving ? 'Creating…' : 'Create and open'}
          </Button>
        </div>
      </Card>
    </div>
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
