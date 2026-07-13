import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { CreateProjectInput, ProjectDto, UpdateProjectInput } from '@cloudforge/core';
import { invoke } from '../../lib/ipc.js';

const PROJECTS_KEY = ['projects'] as const;

/** Query the list of projects. */
export function useProjects(): UseQueryResult<ProjectDto[]> {
  return useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: () => invoke('projects:list', undefined),
  });
}

/** Create a project and refresh the list. */
export function useCreateProject(): UseMutationResult<ProjectDto, Error, CreateProjectInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => invoke('projects:create', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROJECTS_KEY }),
  });
}

/** Apply a partial update to a project (e.g. link a provider credential). */
export function useUpdateProject(): UseMutationResult<
  ProjectDto,
  Error,
  { id: string; changes: UpdateProjectInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, changes }) => invoke('projects:update', { id, changes }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROJECTS_KEY }),
  });
}

/** Delete a project and refresh the list. */
export function useDeleteProject(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke('projects:delete', { id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROJECTS_KEY }),
  });
}
