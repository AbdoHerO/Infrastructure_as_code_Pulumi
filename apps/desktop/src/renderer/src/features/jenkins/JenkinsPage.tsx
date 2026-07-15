import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import type {
  JenkinsParameter,
  JenkinsPipelineRecord,
  SaveJenkinsPipelineInput,
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
  Select,
  Switch,
  Textarea,
  toast,
} from '@cloudforge/ui';
import { PageHeader } from '../../components/PageHeader.js';
import { useConfirmation } from '../../components/ConfirmationDialogProvider.js';
import { invoke } from '../../lib/ipc.js';
import { useVpsTargets } from '../ansible/useAnsible.js';
import { useCredentials } from '../secrets/useCredentials.js';

const empty: SaveJenkinsPipelineInput = {
  name: '',
  description: '',
  targetId: '',
  jenkinsCredentialId: '',
  githubCredentialId: null,
  repositoryUrl: '',
  branch: 'main',
  jenkinsfilePath: 'Jenkinsfile',
  pipelineScript: "sh 'docker compose up -d --build'",
  definitionMode: 'scm',
  parameters: [],
  environment: {},
  domain: '',
  applicationPort: null,
  cloudflareCredentialId: null,
  cloudflareZoneId: null,
  configureDomain: false,
};

export function JenkinsPage(): JSX.Element {
  const queryClient = useQueryClient();
  const confirm = useConfirmation();
  const targets = useVpsTargets();
  const credentials = useCredentials();
  const pipelines = useQuery({
    queryKey: ['jenkins', 'pipelines'],
    queryFn: () => invoke('jenkins:list', undefined),
  });
  const [form, setForm] = useState<SaveJenkinsPipelineInput>(empty);
  const [environmentText, setEnvironmentText] = useState('');
  const [buildValues, setBuildValues] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState('');
  const jenkinsCredentials = credentials.data?.filter((item) => item.kind === 'jenkins') ?? [];
  const githubCredentials = credentials.data?.filter((item) => item.kind === 'github') ?? [];
  const cloudflareCredentials =
    credentials.data?.filter((item) => item.kind === 'cloudflare') ?? [];
  const selected = pipelines.data?.find((item) => item.id === selectedId);

  useEffect(() => {
    if (!form.targetId && targets.data?.[0])
      setForm((current) => ({ ...current, targetId: targets.data?.[0]?.id ?? '' }));
  }, [form.targetId, targets.data]);

  const refresh = (): void => {
    void Promise.all([pipelines.refetch(), targets.refetch(), credentials.refetch()]).then(() =>
      toast.success('Jenkins state refreshed'),
    );
  };
  const save = useMutation({
    mutationFn: () =>
      invoke('jenkins:save', {
        ...form,
        environment: parseEnvironment(environmentText),
      }),
    onSuccess: (pipeline) => {
      toast.success(`Pipeline ${pipeline.name} configured in Jenkins`);
      setSelectedId(pipeline.id);
      void queryClient.invalidateQueries({ queryKey: ['jenkins', 'pipelines'] });
    },
    onError: (error) => toast.error(error.message),
  });
  const test = useMutation({
    mutationFn: () =>
      invoke('jenkins:test', {
        targetId: form.targetId,
        credentialId: form.jenkinsCredentialId,
      }),
    onSuccess: (result) => toast.success(`Connected to Jenkins ${result.version}`),
    onError: (error) => toast.error(error.message),
  });
  const trigger = useMutation({
    mutationFn: (pipeline: JenkinsPipelineRecord) =>
      invoke('jenkins:trigger', { id: pipeline.id, parameters: buildValues }),
    onSuccess: () => toast.success('Jenkins build queued'),
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => invoke('jenkins:delete', { id }),
    onSuccess: () => {
      setSelectedId('');
      toast.success('Pipeline deleted from Jenkins and CloudForge');
      void queryClient.invalidateQueries({ queryKey: ['jenkins', 'pipelines'] });
    },
    onError: (error) => toast.error(error.message),
  });
  const status = useQuery({
    queryKey: ['jenkins', 'status', selectedId],
    queryFn: () => invoke('jenkins:status', { id: selectedId }),
    enabled: Boolean(selectedId),
    refetchInterval: selectedId ? 15_000 : false,
  });

  const edit = (pipeline: JenkinsPipelineRecord): void => {
    setSelectedId(pipeline.id);
    setForm({
      id: pipeline.id,
      name: pipeline.name,
      description: pipeline.description,
      targetId: pipeline.targetId,
      jenkinsCredentialId: pipeline.jenkinsCredentialId,
      githubCredentialId: pipeline.githubCredentialId,
      repositoryUrl: pipeline.repositoryUrl,
      branch: pipeline.branch,
      jenkinsfilePath: pipeline.jenkinsfilePath,
      pipelineScript: pipeline.pipelineScript,
      definitionMode: pipeline.definitionMode,
      parameters: pipeline.parameters,
      environment: pipeline.environment,
      domain: pipeline.domain,
      applicationPort: pipeline.applicationPort,
      cloudflareCredentialId: pipeline.cloudflareCredentialId,
      cloudflareZoneId: pipeline.cloudflareZoneId,
      configureDomain: pipeline.configureDomain,
    });
    setEnvironmentText(
      Object.entries(pipeline.environment)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    );
    setBuildValues(
      Object.fromEntries(
        pipeline.parameters.map((parameter) => [parameter.name, parameter.defaultValue]),
      ),
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Jenkins Pipelines"
        description="Create isolated Jenkins folders and reusable pipelines for every VPS and application."
        actions={
          <Button variant="outline" onClick={refresh}>
            <RefreshCw className="mr-2 h-4 w-4" /> Refresh
          </Button>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Configured pipelines</CardTitle>
            <CardDescription>Each VPS receives its own CloudForge folder.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              className="w-full"
              variant="outline"
              onClick={() => {
                setForm({ ...empty, targetId: targets.data?.[0]?.id ?? '' });
                setEnvironmentText('');
                setSelectedId('');
              }}
            >
              <Plus className="mr-2 h-4 w-4" /> New pipeline
            </Button>
            {pipelines.data?.map((pipeline) => (
              <button
                key={pipeline.id}
                className="border-border hover:bg-muted/40 w-full rounded-md border p-3 text-left"
                onClick={() => edit(pipeline)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{pipeline.name}</span>
                  <Badge variant="secondary">{pipeline.branch}</Badge>
                </div>
                <p className="text-muted-foreground mt-1 truncate text-xs">{pipeline.folder}</p>
                <p className="text-muted-foreground truncate text-xs">
                  {pipeline.repositoryUrl || 'Inline pipeline'}
                </p>
              </button>
            ))}
            {pipelines.data?.length === 0 && (
              <p className="text-muted-foreground py-8 text-center text-sm">No pipelines yet.</p>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{form.id ? 'Edit pipeline' : 'Create pipeline'}</CardTitle>
              <CardDescription>
                Secrets remain encrypted and are installed into the selected Jenkins folder.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <Field label="VPS target">
                <Select
                  value={form.targetId}
                  onChange={(event) => setForm({ ...form, targetId: event.target.value })}
                >
                  <option value="">Select VPS</option>
                  {targets.data?.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.name} · {target.host}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Jenkins credential">
                <Select
                  value={form.jenkinsCredentialId}
                  onChange={(event) =>
                    setForm({ ...form, jenkinsCredentialId: event.target.value })
                  }
                >
                  <option value="">Select Jenkins credential</option>
                  {jenkinsCredentials.map((credential) => (
                    <option key={credential.id} value={credential.id}>
                      {credential.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Pipeline name">
                <Input
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </Field>
              <Field label="Definition">
                <Select
                  value={form.definitionMode}
                  onChange={(event) =>
                    setForm({ ...form, definitionMode: event.target.value as 'scm' | 'inline' })
                  }
                >
                  <option value="scm">Jenkinsfile from Git</option>
                  <option value="inline">Inline pipeline steps</option>
                </Select>
              </Field>
              <Field label="Repository URL">
                <Input
                  disabled={form.definitionMode === 'inline'}
                  value={form.repositoryUrl}
                  placeholder="https://github.com/company/app.git"
                  onChange={(event) => setForm({ ...form, repositoryUrl: event.target.value })}
                />
              </Field>
              <Field label="GitHub credential">
                <Select
                  disabled={form.definitionMode === 'inline'}
                  value={form.githubCredentialId ?? ''}
                  onChange={(event) =>
                    setForm({ ...form, githubCredentialId: event.target.value || null })
                  }
                >
                  <option value="">Public repository / none</option>
                  {githubCredentials.map((credential) => (
                    <option key={credential.id} value={credential.id}>
                      {credential.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Branch">
                <Input
                  value={form.branch}
                  onChange={(event) => setForm({ ...form, branch: event.target.value })}
                />
              </Field>
              <Field label="Jenkinsfile path">
                <Input
                  disabled={form.definitionMode === 'inline'}
                  value={form.jenkinsfilePath}
                  onChange={(event) => setForm({ ...form, jenkinsfilePath: event.target.value })}
                />
              </Field>
              <div className="md:col-span-2">
                <Field label="Description">
                  <Input
                    value={form.description}
                    onChange={(event) => setForm({ ...form, description: event.target.value })}
                  />
                </Field>
              </div>
              {form.definitionMode === 'inline' && (
                <div className="md:col-span-2">
                  <Field label="Pipeline Groovy steps">
                    <Textarea
                      className="min-h-40 font-mono"
                      value={form.pipelineScript}
                      onChange={(event) => setForm({ ...form, pipelineScript: event.target.value })}
                    />
                  </Field>
                </div>
              )}
              <div className="md:col-span-2">
                <Field label="Non-secret environment (one KEY=value per line)">
                  <Textarea
                    className="min-h-24 font-mono"
                    value={environmentText}
                    onChange={(event) => setEnvironmentText(event.target.value)}
                  />
                </Field>
              </div>
              <div className="space-y-3 md:col-span-2">
                <div className="flex items-center justify-between">
                  <Label>Build parameters</Label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setForm({
                        ...form,
                        parameters: [...form.parameters, newParameter(form.parameters.length + 1)],
                      })
                    }
                  >
                    <Plus className="mr-1 h-3 w-3" /> Parameter
                  </Button>
                </div>
                {form.parameters.map((parameter, index) => (
                  <ParameterEditor
                    key={index}
                    parameter={parameter}
                    onChange={(value) =>
                      setForm({
                        ...form,
                        parameters: form.parameters.map((item, itemIndex) =>
                          itemIndex === index ? value : item,
                        ),
                      })
                    }
                    onRemove={() =>
                      setForm({
                        ...form,
                        parameters: form.parameters.filter((_, itemIndex) => itemIndex !== index),
                      })
                    }
                  />
                ))}
              </div>
              <div className="border-border space-y-4 rounded-md border p-4 md:col-span-2">
                <label className="flex items-center gap-3">
                  <Switch
                    checked={form.configureDomain}
                    onCheckedChange={(configureDomain) => setForm({ ...form, configureDomain })}
                  />
                  <span>
                    <span className="block font-medium">Configure application domain</span>
                    <span className="text-muted-foreground text-xs">
                      Create Cloudflare DNS and apply an Nginx reverse proxy to this application.
                    </span>
                  </span>
                </label>
                {form.configureDomain && (
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label="Domain / subdomain">
                      <Input
                        value={form.domain}
                        placeholder="app.example.com"
                        onChange={(event) => setForm({ ...form, domain: event.target.value })}
                      />
                    </Field>
                    <Field label="Application port">
                      <Input
                        type="number"
                        value={form.applicationPort ?? ''}
                        onChange={(event) =>
                          setForm({ ...form, applicationPort: Number(event.target.value) || null })
                        }
                      />
                    </Field>
                    <Field label="Cloudflare credential">
                      <Select
                        value={form.cloudflareCredentialId ?? ''}
                        onChange={(event) =>
                          setForm({ ...form, cloudflareCredentialId: event.target.value || null })
                        }
                      >
                        <option value="">Use Cloudflare default</option>
                        {cloudflareCredentials.map((credential) => (
                          <option key={credential.id} value={credential.id}>
                            {credential.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Cloudflare Zone ID (optional)">
                      <Input
                        value={form.cloudflareZoneId ?? ''}
                        onChange={(event) =>
                          setForm({ ...form, cloudflareZoneId: event.target.value || null })
                        }
                      />
                    </Field>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2 md:col-span-2">
                <Button
                  disabled={!form.targetId || !form.jenkinsCredentialId || test.isPending}
                  variant="outline"
                  onClick={() => test.mutate()}
                >
                  {test.isPending ? 'Testing…' : 'Test Jenkins'}
                </Button>
                <Button disabled={save.isPending} onClick={() => save.mutate()}>
                  <Save className="mr-2 h-4 w-4" />
                  {save.isPending ? 'Configuring…' : 'Save to Jenkins'}
                </Button>
                {form.id && (
                  <Button
                    variant="destructive"
                    onClick={() =>
                      void confirm({
                        title: 'Delete Jenkins pipeline?',
                        description: `Delete ${form.name} from Jenkins and CloudForge?`,
                        confirmLabel: 'Delete pipeline',
                        destructive: true,
                      }).then((confirmed) => {
                        if (confirmed && form.id) remove.mutate(form.id);
                      })
                    }
                  >
                    <Trash2 className="mr-2 h-4 w-4" /> Delete
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {selected && (
            <Card>
              <CardHeader>
                <CardTitle>Run {selected.name}</CardTitle>
                <CardDescription>
                  {status.data?.exists
                    ? `Jenkins status: ${status.data.lastBuildResult ?? status.data.color}`
                    : 'Load and run the configured job.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {selected.parameters.map((parameter) => (
                  <Field key={parameter.name} label={parameter.name}>
                    <BuildParameterInput
                      parameter={parameter}
                      value={buildValues[parameter.name] ?? parameter.defaultValue}
                      onChange={(value) =>
                        setBuildValues({ ...buildValues, [parameter.name]: value })
                      }
                    />
                    {parameter.description && (
                      <p className="text-muted-foreground text-xs">{parameter.description}</p>
                    )}
                  </Field>
                ))}
                <div className="flex gap-2">
                  <Button onClick={() => trigger.mutate(selected)} disabled={trigger.isPending}>
                    <Play className="mr-2 h-4 w-4" /> Run pipeline
                  </Button>
                  <Button variant="outline" onClick={() => void status.refetch()}>
                    <RefreshCw className="mr-2 h-4 w-4" /> Status
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
function newParameter(index: number): JenkinsParameter {
  return { name: `PARAM_${index}`, type: 'string', defaultValue: '', description: '', choices: [] };
}
function ParameterEditor({
  parameter,
  onChange,
  onRemove,
}: {
  readonly parameter: JenkinsParameter;
  readonly onChange: (value: JenkinsParameter) => void;
  readonly onRemove: () => void;
}): JSX.Element {
  return (
    <div className="border-border space-y-2 rounded-md border p-3">
      <div className="grid gap-2 md:grid-cols-[1fr_140px_1fr_auto]">
        <Input
          value={parameter.name}
          placeholder="PARAMETER_NAME"
          onChange={(event) => onChange({ ...parameter, name: event.target.value.toUpperCase() })}
        />
        <Select
          value={parameter.type}
          onChange={(event) =>
            onChange({ ...parameter, type: event.target.value as JenkinsParameter['type'] })
          }
        >
          <option value="string">String</option>
          <option value="boolean">Boolean</option>
          <option value="choice">Choice</option>
          <option value="password">Password</option>
        </Select>
        <Input
          type={parameter.type === 'password' ? 'password' : 'text'}
          value={parameter.type === 'choice' ? parameter.choices.join(',') : parameter.defaultValue}
          placeholder={parameter.type === 'choice' ? 'dev,staging,production' : 'Default value'}
          onChange={(event) =>
            onChange(
              parameter.type === 'choice'
                ? {
                    ...parameter,
                    choices: event.target.value
                      .split(',')
                      .map((item) => item.trim())
                      .filter(Boolean),
                  }
                : { ...parameter, defaultValue: event.target.value },
            )
          }
        />
        <Button size="icon" variant="ghost" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <Input
        value={parameter.description}
        placeholder="Parameter description (optional)"
        onChange={(event) => onChange({ ...parameter, description: event.target.value })}
      />
    </div>
  );
}

function BuildParameterInput({
  parameter,
  value,
  onChange,
}: {
  readonly parameter: JenkinsParameter;
  readonly value: string;
  readonly onChange: (value: string) => void;
}): JSX.Element {
  if (parameter.type === 'boolean') {
    return (
      <Select value={value || 'false'} onChange={(event) => onChange(event.target.value)}>
        <option value="false">False</option>
        <option value="true">True</option>
      </Select>
    );
  }
  if (parameter.type === 'choice') {
    return (
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        {parameter.choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </Select>
    );
  }
  return (
    <Input
      type={parameter.type === 'password' ? 'password' : 'text'}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
function parseEnvironment(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        return separator < 1
          ? [line, '']
          : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      }),
  );
}
