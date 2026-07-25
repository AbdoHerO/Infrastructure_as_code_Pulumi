import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  CreateProjectInput,
  DuplicateProjectInput,
  ProjectDto,
  ProjectPickerDto,
  ProjectSessionDto,
} from '@cloudforge/core';
import { invoke } from '../../lib/ipc.js';

interface WorkspaceContextValue {
  readonly loading: boolean;
  readonly session: ProjectSessionDto | null;
  readonly projects: readonly ProjectPickerDto[];
  readonly refreshProjects: () => Promise<void>;
  readonly refreshSession: () => Promise<void>;
  readonly create: (input: CreateProjectInput) => Promise<ProjectDto>;
  readonly duplicate: (input: DuplicateProjectInput) => Promise<ProjectDto>;
  readonly unlock: (projectId: string, passkey: string) => Promise<void>;
  readonly lock: () => Promise<void>;
  readonly deleteCurrent: (confirmationName: string, passkey: string) => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/**
 * Owns the renderer's single workspace session. Feature query caches are
 * discarded on every transition so data from one project cannot render in the
 * next project, even briefly.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }): JSX.Element {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<ProjectSessionDto | null>(null);
  const [projects, setProjects] = useState<readonly ProjectPickerDto[]>([]);

  const refreshProjects = useCallback(async (): Promise<void> => {
    setProjects(await invoke('projects:picker', undefined));
  }, []);
  const refreshSession = useCallback(async (): Promise<void> => {
    setSession(await invoke('projects:session', undefined));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([invoke('projects:session', undefined), invoke('projects:picker', undefined)])
      .then(([current, available]) => {
        if (cancelled) return;
        setSession(current);
        setProjects(available);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const create = useCallback(
    async (input: CreateProjectInput): Promise<ProjectDto> => {
      const project = await invoke('projects:create', input);
      await refreshProjects();
      return project;
    },
    [refreshProjects],
  );

  const unlock = useCallback(
    async (projectId: string, passkey: string): Promise<void> => {
      const opened = await invoke('projects:unlock', { id: projectId, passkey });
      queryClient.clear();
      setSession(opened);
      await refreshProjects();
    },
    [queryClient, refreshProjects],
  );

  const duplicate = useCallback(
    async (input: DuplicateProjectInput): Promise<ProjectDto> => {
      const project = await invoke('projects:duplicate', input);
      await refreshProjects();
      return project;
    },
    [refreshProjects],
  );

  const lock = useCallback(async (): Promise<void> => {
    await invoke('projects:lock', undefined);
    queryClient.clear();
    setSession(null);
    await refreshProjects();
  }, [queryClient, refreshProjects]);

  const deleteCurrent = useCallback(
    async (confirmationName: string, passkey: string): Promise<void> => {
      const current = session;
      if (!current) return;
      await invoke('projects:delete', { id: current.project.id, confirmationName, passkey });
      queryClient.clear();
      setSession(null);
      await refreshProjects();
    },
    [queryClient, refreshProjects, session],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      loading,
      session,
      projects,
      refreshProjects,
      refreshSession,
      create,
      duplicate,
      unlock,
      lock,
      deleteCurrent,
    }),
    [
      create,
      deleteCurrent,
      duplicate,
      loading,
      lock,
      projects,
      refreshProjects,
      refreshSession,
      session,
      unlock,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/** Access the active project session and workspace lifecycle actions. */
export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return value;
}
