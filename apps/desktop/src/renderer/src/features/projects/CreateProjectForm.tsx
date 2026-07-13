import type { ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button, Card, CardContent, Input, Label, Select, Textarea, toast } from '@cloudforge/ui';
import { ENVIRONMENTS } from '@cloudforge/core';
import { IpcCallError } from '../../lib/ipc.js';
import { useCreateProject } from './useProjects.js';

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100, 'Name is too long'),
  environment: z.enum(ENVIRONMENTS),
  region: z.string().trim().min(1, 'Region is required'),
  description: z.string().trim().max(500).optional(),
});

type FormValues = z.infer<typeof schema>;

interface CreateProjectFormProps {
  onCreated: () => void;
  onCancel: () => void;
}

/** Inline form for creating a project, validated with Zod + React Hook Form. */
export function CreateProjectForm({ onCreated, onCancel }: CreateProjectFormProps): JSX.Element {
  const createProject = useCreateProject();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { environment: 'development' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await createProject.mutateAsync({
        name: values.name,
        environment: values.environment,
        region: values.region,
        ...(values.description ? { description: values.description } : {}),
      });
      toast.success(`Project "${values.name}" created`);
      onCreated();
    } catch (error) {
      const message = error instanceof IpcCallError ? error.message : 'Failed to create project';
      setError('root', { message });
    }
  });

  return (
    <Card>
      <CardContent className="pt-6">
        <form
          onSubmit={(event) => {
            void onSubmit(event);
          }}
          className="space-y-4"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name" error={errors.name?.message}>
              <Input placeholder="my-api" {...register('name')} />
            </Field>
            <Field label="Region" error={errors.region?.message}>
              <Input placeholder="eu-frankfurt-1" {...register('region')} />
            </Field>
            <Field label="Environment" error={errors.environment?.message}>
              <Select {...register('environment')}>
                {ENVIRONMENTS.map((env) => (
                  <option key={env} value={env}>
                    {env}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Description" error={errors.description?.message}>
            <Textarea
              placeholder="What does this infrastructure host?"
              {...register('description')}
            />
          </Field>

          {errors.root?.message ? (
            <p className="text-destructive text-sm">{errors.root.message}</p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create project'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | undefined;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}
