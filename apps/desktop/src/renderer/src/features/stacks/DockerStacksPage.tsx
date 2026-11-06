import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Eye,
  EyeOff,
  FolderOpen,
  Layers,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  Trash2,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import {
  STACK_DEFAULT_BODY_SIZE,
  STACK_NAME_PATTERN,
  type ComposeAnalysis,
  type StackRecord,
  type StackRouteInput,
  type StackRuntimeStatus,
} from '@cloudforge/core';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  LogTerminal,
  Select,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  toast,
} from '@cloudforge/ui';
import {
  DomainPicker,
  NO_DOMAIN,
  SiteLink,
  type DomainSelection,
} from '../../components/DomainPicker.js';
import { PageHeader } from '../../components/PageHeader.js';
import { useConfirmation } from '../../components/ConfirmationDialogProvider.js';
import { invoke, subscribe } from '../../lib/ipc.js';
import { useVpsTargets } from '../ansible/useAnsible.js';

const STACKS_KEY = ['stacks', 'list'] as const;

interface RouteDraft {
  readonly key: string;
  readonly service: string;
  readonly containerPort: string;
  readonly proxied: boolean;
  readonly https: boolean;
  readonly clientMaxBodySize: string;
  readonly selection: DomainSelection;
}

function newRoute(service = ''): RouteDraft {
  return {
    key: crypto.randomUUID(),
    service,
    containerPort: '',
    proxied: true,
    https: true,
    clientMaxBodySize: STACK_DEFAULT_BODY_SIZE,
    selection: NO_DOMAIN,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
}

function statusBadge(stack: StackRecord): JSX.Element {
  if (stack.status === 'failed') return <Badge variant="destructive">Failed</Badge>;
  if (stack.status === 'deploying') return <Badge variant="secondary">Deploying</Badge>;
  return stack.warnings.length > 0 ? (
    <Badge variant="warning">
      Running · {stack.warnings.length} warning{stack.warnings.length === 1 ? '' : 's'}
    </Badge>
  ) : (
    <Badge variant="success">Running</Badge>
  );
}

/** Ask the main process what it understands of the file, shortly after typing stops. */
function useComposeAnalysis(composeYaml: string, environment: string): ComposeAnalysis | null {
  const [analysis, setAnalysis] = useState<ComposeAnalysis | null>(null);
  useEffect(() => {
    if (composeYaml.trim() === '') {
      setAnalysis(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void invoke('stacks:analyze', { composeYaml, environment })
        .then((result) => {
          if (current) setAnalysis(result);
        })
        .catch((error: Error) => {
          if (!current) return;
          setAnalysis({
            name: null,
            services: [],
            externalNetworks: [],
            externalVolumes: [],
            errors: [`The file could not be analyzed: ${error.message}`],
            warnings: [],
          });
        });
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [composeYaml, environment]);
  return analysis;
}

function AnalysisSummary({ analysis }: { analysis: ComposeAnalysis | null }): JSX.Element | null {
  if (!analysis) return null;
  return (
    <div className="space-y-2 text-sm md:col-span-2">
      {analysis.services.length > 0 ? (
        <p className="text-muted-foreground">
          {analysis.services.length} service{analysis.services.length === 1 ? '' : 's'}:{' '}
          {analysis.services
            .map((service) => `${service.name} (${service.image ?? 'no image'})`)
            .join(', ')}
        </p>
      ) : null}
      {analysis.externalNetworks.length + analysis.externalVolumes.length > 0 ? (
        <p className="text-muted-foreground">
          Created on the server if missing, and never deleted:{' '}
          {[
            ...analysis.externalNetworks.map((name) => `network ${name}`),
            ...analysis.externalVolumes.map((name) => `volume ${name}`),
          ].join(', ')}
        </p>
      ) : null}
      {analysis.errors.map((text) => (
        <p key={text} className="text-destructive flex items-start gap-2">
          <XCircle className="mt-0.5 size-4 shrink-0" /> {text}
        </p>
      ))}
      {analysis.warnings.map((text) => (
        <p key={text} className="text-warning flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {text}
        </p>
      ))}
    </div>
  );
}

function StackFileFields({
  idPrefix,
  composeYaml,
  environment,
  onComposeChange,
  onEnvironmentChange,
}: {
  idPrefix: string;
  composeYaml: string;
  environment: string;
  onComposeChange: (value: string) => void;
  onEnvironmentChange: (value: string) => void;
}): JSX.Element {
  const [showEnvironment, setShowEnvironment] = useState(false);
  return (
    <>
      <div className="space-y-2 md:col-span-2">
        <Label htmlFor={`${idPrefix}-compose`}>Compose file</Label>
        <Textarea
          id={`${idPrefix}-compose`}
          className="min-h-56 font-mono text-xs"
          spellCheck={false}
          value={composeYaml}
          placeholder={'services:\n  app:\n    image: nginx:stable'}
          onChange={(event) => onComposeChange(event.target.value)}
        />
      </div>
      <div className="space-y-2 md:col-span-2">
        <div className="flex items-center justify-between">
          <Label htmlFor={`${idPrefix}-environment`}>.env file (optional)</Label>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowEnvironment((current) => !current)}
          >
            {showEnvironment ? <EyeOff className="mr-1 size-3" /> : <Eye className="mr-1 size-3" />}
            {showEnvironment ? 'Hide values' : 'Show values'}
          </Button>
        </div>
        <Textarea
          id={`${idPrefix}-environment`}
          className={`min-h-24 font-mono text-xs ${showEnvironment ? '' : '[-webkit-text-security:disc]'}`}
          spellCheck={false}
          autoComplete="off"
          value={environment}
          placeholder="KEY=value"
          onChange={(event) => onEnvironmentChange(event.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          Saved encrypted in Secrets, and uploaded to the server as an owner-only file.
        </p>
      </div>
    </>
  );
}

function RouteFields({
  route,
  index,
  targetId,
  analysis,
  otherDomains,
  refreshKey,
  onChange,
  onRemove,
}: {
  route: RouteDraft;
  index: number;
  targetId: string;
  analysis: ComposeAnalysis | null;
  otherDomains: readonly string[];
  refreshKey: unknown;
  onChange: (change: Partial<RouteDraft>) => void;
  onRemove: () => void;
}): JSX.Element {
  const id = `route-${route.key}`;
  const service = analysis?.services.find((item) => item.name === route.service);
  const usesCloudflare = route.selection.cloudflareCredentialId !== null;
  return (
    <div className="border-border grid gap-4 rounded-lg border p-4 md:col-span-2 md:grid-cols-2">
      <div className="flex items-center justify-between md:col-span-2">
        <span className="text-sm font-medium">Domain {index + 1}</span>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          <X className="mr-1 size-3" /> Remove
        </Button>
      </div>
      <DomainPicker
        idPrefix={id}
        targetId={targetId}
        alsoTaken={otherDomains}
        refreshKey={refreshKey}
        onChange={(selection) => onChange({ selection })}
      />
      <div className="space-y-2">
        <Label htmlFor={`${id}-service`}>Goes to the service</Label>
        <Select
          id={`${id}-service`}
          value={route.service}
          onChange={(event) => onChange({ service: event.target.value })}
        >
          <option value="">Choose a service</option>
          {(analysis?.services ?? []).map((item) => (
            <option key={item.name} value={item.name} disabled={item.hostNetwork}>
              {item.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-port`}>Port inside the container</Label>
        <Input
          id={`${id}-port`}
          inputMode="numeric"
          list={`${id}-ports`}
          value={route.containerPort}
          placeholder="9001"
          onChange={(event) =>
            onChange({ containerPort: event.target.value.replace(/[^0-9]/g, '') })
          }
        />
        <datalist id={`${id}-ports`}>
          {(service?.ports ?? []).map((port) => (
            <option key={port} value={port} />
          ))}
        </datalist>
        {service?.ports.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            The file declares no port for this service: enter the one the application listens on.
          </p>
        ) : null}
      </div>
      {usesCloudflare ? (
        <div className="space-y-2">
          <Label htmlFor={`${id}-proxy`}>Traffic</Label>
          <Select
            id={`${id}-proxy`}
            value={route.proxied ? 'proxied' : 'direct'}
            onChange={(event) => onChange({ proxied: event.target.value === 'proxied' })}
          >
            <option value="proxied">Through the Cloudflare proxy (orange cloud)</option>
            <option value="direct">DNS only, straight to the server</option>
          </Select>
          <p className="text-muted-foreground text-xs">
            Cloudflare’s proxy limits each upload to 100 MB on the free plan. Use DNS only for large
            uploads, such as an S3 API.
          </p>
        </div>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor={`${id}-size`}>Largest upload</Label>
        <Input
          id={`${id}-size`}
          value={route.clientMaxBodySize}
          placeholder={STACK_DEFAULT_BODY_SIZE}
          onChange={(event) => onChange({ clientMaxBodySize: event.target.value.trim() })}
        />
      </div>
      <div className="flex items-center gap-3">
        <Switch
          id={`${id}-https`}
          checked={route.https}
          onCheckedChange={(https) => onChange({ https })}
        />
        <Label htmlFor={`${id}-https`}>HTTPS certificate</Label>
      </div>
    </div>
  );
}

export function DockerStacksPage(): JSX.Element {
  const confirm = useConfirmation();
  const client = useQueryClient();
  const targets = useVpsTargets();
  const stacks = useQuery({
    queryKey: STACKS_KEY,
    queryFn: () => invoke('stacks:list', undefined),
  });

  const [targetId, setTargetId] = useState('');
  const [name, setName] = useState('');
  const [composeYaml, setComposeYaml] = useState('');
  const [environment, setEnvironment] = useState('');
  const [certificateEmail, setCertificateEmail] = useState('');
  const [routes, setRoutes] = useState<RouteDraft[]>([newRoute()]);
  const [logs, setLogs] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<Record<string, StackRuntimeStatus>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    stack: StackRecord;
    composeYaml: string;
    environment: string;
  } | null>(null);
  const streamId = useMemo(() => crypto.randomUUID(), []);
  const analysis = useComposeAnalysis(composeYaml, environment);
  const editAnalysis = useComposeAnalysis(editing?.composeYaml ?? '', editing?.environment ?? '');

  useEffect(() => {
    if (!targetId && targets.data?.[0]) setTargetId(targets.data[0].id);
  }, [targetId, targets.data]);
  useEffect(
    () =>
      subscribe('stacks:log', (payload) => {
        if (payload.streamId !== streamId) return;
        const text = payload.event.message.trimEnd();
        if (!text) return;
        const line = payload.event.stream === 'step' ? `▶ ${text}` : text;
        setLogs((current) => [...current.slice(-800), line]);
      }),
    [streamId],
  );
  // With a single service there is nothing to choose: fill it in, and its port if it has one.
  const onlyService = analysis?.services.length === 1 ? analysis.services[0] : undefined;
  useEffect(() => {
    if (!onlyService || onlyService.hostNetwork) return;
    setRoutes((current) =>
      current.map((route) =>
        route.service === ''
          ? {
              ...route,
              service: onlyService.name,
              containerPort:
                route.containerPort === '' && onlyService.ports.length === 1
                  ? String(onlyService.ports[0])
                  : route.containerPort,
            }
          : route,
      ),
    );
  }, [onlyService]);
  useEffect(() => {
    if (analysis?.name && name === '') setName(slug(analysis.name));
    // Only when the file changes: clearing the name by hand must stay cleared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis?.name]);

  const refresh = (): Promise<void> => client.invalidateQueries({ queryKey: STACKS_KEY });
  const updateRoute = (key: string, change: Partial<RouteDraft>): void =>
    setRoutes((current) =>
      current.map((route) => (route.key === key ? { ...route, ...change } : route)),
    );
  const target = targets.data?.find((item) => item.id === targetId);

  const blockers: string[] = [];
  if (!targetId) blockers.push('Choose a server.');
  if (!STACK_NAME_PATTERN.test(name))
    blockers.push('Give the stack a name in lower-case letters, digits, - or _.');
  if (composeYaml.trim() === '') blockers.push('Add the Compose file.');
  if (analysis && analysis.errors.length > 0)
    blockers.push('Fix the problems in the Compose file.');
  routes.forEach((route, index) => {
    const label = `Domain ${String(index + 1)}`;
    if (route.selection.domain === '') blockers.push(`${label}: choose the domain.`);
    else if (!route.selection.ready)
      blockers.push(`${label}: ${route.selection.domain} is not confirmed free yet.`);
    if (route.service === '') blockers.push(`${label}: choose the service.`);
    const port = Number(route.containerPort);
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      blockers.push(`${label}: enter the port inside the container.`);
  });
  if (routes.some((route) => route.https) && !certificateEmail.includes('@'))
    blockers.push('Enter the email for the HTTPS certificates.');

  const routeInputs: StackRouteInput[] = routes.map((route) => ({
    domain: route.selection.domain,
    service: route.service,
    containerPort: Number(route.containerPort),
    cloudflareCredentialId: route.selection.cloudflareCredentialId,
    cloudflareZoneId: route.selection.cloudflareZoneId,
    proxied: route.selection.cloudflareCredentialId === null ? null : route.proxied,
    https: route.https,
    clientMaxBodySize: route.clientMaxBodySize,
  }));

  const create = useMutation({
    mutationFn: () =>
      invoke('stacks:create', {
        stack: {
          targetId,
          name,
          composeYaml,
          environment,
          routes: routeInputs,
          certificateEmail: certificateEmail.trim() || null,
        },
        streamId,
      }),
    onMutate: () => setLogs([]),
    onSuccess: (stack) => {
      setName('');
      setComposeYaml('');
      setEnvironment('');
      setRoutes([newRoute()]);
      if (stack.warnings.length > 0)
        toast.warning('The stack is running with warnings. See below.');
      else toast.success(`The stack ${stack.name} is running`);
    },
    onError: (error) => toast.error(message(error)),
    onSettled: () => void refresh(),
  });

  const chooseFolder = async (): Promise<void> => {
    try {
      const folder = await invoke('stacks:chooseFolder', undefined);
      if (!folder) return;
      setComposeYaml(folder.composeYaml);
      setEnvironment(folder.environment);
      if (name === '') setName(slug(folder.folderName));
      toast.success(
        `Loaded ${folder.composeFileName}${folder.hasEnvironment ? ' and .env' : ''} from ${folder.folderName}`,
      );
    } catch (error) {
      toast.error(message(error));
    }
  };

  const submit = (): void => {
    const steps = [
      `Starts the stack ${name} on ${target?.name ?? 'the server'} (${target?.host ?? ''}).`,
      analysis && analysis.externalNetworks.length + analysis.externalVolumes.length > 0
        ? `Creates what is missing: ${[...analysis.externalNetworks, ...analysis.externalVolumes].join(', ')}.`
        : '',
      ...routes.map(
        (route) =>
          `Publishes ${route.selection.domain} to ${route.service}:${route.containerPort}${
            route.selection.cloudflareCredentialId ? ', creates its Cloudflare record' : ''
          }${route.https ? ' and handles its HTTPS certificate' : ''}.`,
      ),
      'Nothing else on the server is changed.',
    ];
    void confirm({
      title: `Deploy the stack ${name}?`,
      description: steps.filter((step) => step !== '').join(' '),
      confirmLabel: 'Deploy stack',
      destructive: false,
    }).then((confirmed) => {
      if (confirmed) create.mutate();
    });
  };

  const run = async (id: string, action: string, work: () => Promise<unknown>): Promise<void> => {
    setBusy(`${id}:${action}`);
    if (action !== 'status') setLogs([]);
    try {
      await work();
    } catch (error) {
      toast.error(message(error));
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const checkStatus = (stack: StackRecord): Promise<void> =>
    run(stack.id, 'status', async () => {
      const status = await invoke('stacks:status', { id: stack.id });
      setStatuses((current) => ({ ...current, [stack.id]: status }));
      const running = status.containers.filter((item) => item.state === 'running').length;
      toast.success(`${stack.name}: ${running} of ${status.containers.length} containers running`);
    });

  const redeploy = (stack: StackRecord): void => {
    void confirm({
      title: `Redeploy ${stack.name}?`,
      description:
        'Downloads the latest images, restarts what changed, and runs DNS, Nginx and HTTPS again. Volumes are kept. Use it after fixing DNS, or when a step failed.',
      confirmLabel: 'Redeploy',
      destructive: false,
    }).then((confirmed) => {
      if (!confirmed) return;
      void run(stack.id, 'redeploy', async () => {
        const result = await invoke('stacks:redeploy', { id: stack.id, streamId });
        if (result.warnings.length > 0) toast.warning('Redeployed with warnings');
        else toast.success(`${stack.name} is running`);
      });
    });
  };

  const openEditor = (stack: StackRecord): Promise<void> =>
    run(stack.id, 'edit', async () => {
      const files = await invoke('stacks:reveal', { id: stack.id });
      setEditing({ stack, ...files });
    });

  const saveEdit = (): void => {
    if (!editing) return;
    const { stack, composeYaml: yaml, environment: env } = editing;
    void confirm({
      title: `Save and deploy ${stack.name}?`,
      description:
        'Saves the Compose file and .env, then redeploys the stack. If the new file is invalid, the running stack is left as it is.',
      confirmLabel: 'Save and deploy',
      destructive: false,
    }).then((confirmed) => {
      if (!confirmed) return;
      void run(stack.id, 'save', async () => {
        const result = await invoke('stacks:update', {
          id: stack.id,
          composeYaml: yaml,
          environment: env,
          streamId,
        });
        setEditing(null);
        if (result.warnings.length > 0) toast.warning('Deployed with warnings');
        else toast.success(`${stack.name} was updated`);
      });
    });
  };

  const remove = (stack: StackRecord, deleteData: boolean): void => {
    const keptExternal = [...stack.externalNetworks, ...stack.externalVolumes];
    void confirm({
      title: deleteData ? `Delete ${stack.name} and its data?` : `Remove ${stack.name}?`,
      description: deleteData
        ? `Deletes the containers, the stack's own volumes and files, the Nginx sites, the DNS records CloudForge created, and the saved Compose file and .env. This cannot be undone.${keptExternal.length > 0 ? ` Kept, because other stacks may use them: ${keptExternal.join(', ')}.` : ''}`
        : 'Stops and removes the containers and the Nginx sites. Volumes, DNS records and the saved files stay, so deploying the same name again brings the stack back.',
      confirmLabel: deleteData ? 'Delete everything' : 'Remove',
      destructive: true,
    }).then((confirmed) => {
      if (!confirmed) return;
      void run(stack.id, deleteData ? 'delete' : 'remove', async () => {
        const result = await invoke('stacks:remove', { id: stack.id, deleteData, streamId });
        if (editing?.stack.id === stack.id) setEditing(null);
        for (const warning of result.warnings) toast.warning(warning);
        toast.success(deleteData ? `${stack.name} was deleted` : `${stack.name} was removed`);
      });
    });
  };

  const targetName = (id: string): string =>
    targets.data?.find((item) => item.id === id)?.name ?? 'Unknown server';
  const working = create.isPending || busy !== null;
  const domainsTaken = (key: string): string[] =>
    routes
      .filter((route) => route.key !== key && route.selection.domain !== '')
      .map((route) => route.selection.domain);

  return (
    <div>
      <PageHeader
        title="Docker Stacks"
        description="Deploy any Docker Compose stack on your servers and publish it on a domain, with its Cloudflare record, Nginx site and HTTPS certificate."
      />

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Rocket className="size-4" /> New stack
            </CardTitle>
            <CardDescription>
              The server needs Docker and Nginx. The stack appears in Containers and in Dockhand
              under its name.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="stack-target">Server</Label>
              <Select
                id="stack-target"
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
              >
                {(targets.data ?? []).length === 0 ? (
                  <option value="">No saved server</option>
                ) : null}
                {(targets.data ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.host})
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="stack-name">Stack name</Label>
              <Input
                id="stack-name"
                value={name}
                placeholder="rustfs"
                autoComplete="off"
                onChange={(event) => setName(event.target.value.trim().toLowerCase())}
              />
            </div>
            <div className="flex items-center gap-3 md:col-span-2">
              <Button variant="outline" onClick={() => void chooseFolder()}>
                <FolderOpen className="mr-2 size-4" /> Load from a folder
              </Button>
              <span className="text-muted-foreground text-sm">
                Reads compose.yaml and .env from the folder, or paste them below.
              </span>
            </div>
            <StackFileFields
              idPrefix="stack"
              composeYaml={composeYaml}
              environment={environment}
              onComposeChange={setComposeYaml}
              onEnvironmentChange={setEnvironment}
            />
            <AnalysisSummary analysis={analysis} />

            {routes.map((route, index) => (
              <RouteFields
                key={route.key}
                route={route}
                index={index}
                targetId={targetId}
                analysis={analysis}
                otherDomains={domainsTaken(route.key)}
                refreshKey={stacks.data}
                onChange={(change) => updateRoute(route.key, change)}
                onRemove={() =>
                  setRoutes((current) => current.filter((item) => item.key !== route.key))
                }
              />
            ))}
            <div className="flex flex-wrap items-center gap-3 md:col-span-2">
              <Button
                variant="outline"
                onClick={() =>
                  setRoutes((current) => [...current, newRoute(onlyService?.name ?? '')])
                }
              >
                <Plus className="mr-2 size-4" /> Add a domain
              </Button>
              {routes.length === 0 ? (
                <span className="text-muted-foreground text-sm">
                  No domain: the stack runs on the server without being published.
                </span>
              ) : null}
            </div>
            {routes.some((route) => route.https) ? (
              <div className="space-y-2">
                <Label htmlFor="stack-email">Email for the HTTPS certificates</Label>
                <Input
                  id="stack-email"
                  type="email"
                  value={certificateEmail}
                  placeholder="you@example.com"
                  onChange={(event) => setCertificateEmail(event.target.value)}
                />
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-3 md:col-span-2">
              <Button onClick={submit} disabled={working || blockers.length > 0}>
                <Rocket className="mr-2 size-4" />
                {create.isPending ? 'Deploying… (a few minutes)' : 'Deploy stack'}
              </Button>
              {blockers[0] && (composeYaml || name) ? (
                <span className="text-muted-foreground text-sm">{blockers[0]}</span>
              ) : null}
            </div>
          </CardContent>
        </Card>

        {editing ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Pencil className="size-4" /> Edit {editing.stack.name}
              </CardTitle>
              <CardDescription>
                Change the image version or the variables, then deploy. To change a domain or its
                port, use Remove (the data stays) and deploy again.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <StackFileFields
                idPrefix="stack-edit"
                composeYaml={editing.composeYaml}
                environment={editing.environment}
                onComposeChange={(value) =>
                  setEditing((current) => current && { ...current, composeYaml: value })
                }
                onEnvironmentChange={(value) =>
                  setEditing((current) => current && { ...current, environment: value })
                }
              />
              <AnalysisSummary analysis={editAnalysis} />
              <div className="flex gap-3 md:col-span-2">
                <Button
                  onClick={saveEdit}
                  disabled={working || (editAnalysis?.errors.length ?? 0) > 0}
                >
                  <Rocket className="mr-2 size-4" /> Save and deploy
                </Button>
                <Button variant="ghost" disabled={working} onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {logs.length > 0 || working ? (
          <Card>
            <CardHeader>
              <CardTitle>Progress</CardTitle>
            </CardHeader>
            <CardContent>
              <LogTerminal lines={logs} emptyMessage="Connecting to the server…" />
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Layers className="size-4" /> Stacks
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(stacks.data ?? []).length === 0 ? (
              <p className="text-muted-foreground text-sm">No stack deployed from here yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Stack</TableHead>
                    <TableHead>Server</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(stacks.data ?? []).map((stack) => {
                    const status = statuses[stack.id];
                    return (
                      <TableRow key={stack.id}>
                        <TableCell className="align-top">
                          <div className="font-medium">{stack.name}</div>
                          {stack.routes.map((route) => (
                            <div key={route.domain} className="text-xs">
                              <SiteLink
                                url={`${route.https ? 'https' : 'http'}://${route.domain}`}
                                label={route.domain}
                              />{' '}
                              <span className="text-muted-foreground">
                                → {route.service}:{route.containerPort} (127.0.0.1:{route.hostPort})
                              </span>
                            </div>
                          ))}
                          {[...stack.warnings, ...(stack.lastError ? [stack.lastError] : [])].map(
                            (text) => (
                              <div
                                key={text}
                                className="text-warning mt-1 flex max-w-2xl items-start gap-1 text-xs"
                              >
                                <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {text}
                              </div>
                            ),
                          )}
                          {status ? (
                            <div className="text-muted-foreground mt-1 text-xs">
                              {status.containers
                                .map(
                                  (item) =>
                                    `${item.service}: ${item.state}${item.health ? ` (${item.health})` : ''}`,
                                )
                                .join(' · ') || 'No container found on the server'}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="align-top">{targetName(stack.targetId)}</TableCell>
                        <TableCell className="align-top">{statusBadge(stack)}</TableCell>
                        <TableCell className="align-top">
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={working}
                              onClick={() => void checkStatus(stack)}
                            >
                              <RefreshCw
                                className={`mr-1 size-3 ${busy === `${stack.id}:status` ? 'animate-spin' : ''}`}
                              />
                              Check
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={working}
                              onClick={() => void openEditor(stack)}
                            >
                              <Pencil className="mr-1 size-3" /> Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={working}
                              onClick={() => redeploy(stack)}
                            >
                              <Wrench className="mr-1 size-3" /> Redeploy
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={working}
                              onClick={() => remove(stack, false)}
                            >
                              Remove
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive"
                              disabled={working}
                              onClick={() => remove(stack, true)}
                            >
                              <Trash2 className="mr-1 size-3" /> Delete
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
