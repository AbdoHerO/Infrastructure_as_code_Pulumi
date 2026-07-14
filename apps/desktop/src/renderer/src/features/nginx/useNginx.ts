import { useEffect, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { ManagedNginxSite, NginxLogQuery } from '@cloudforge/core';
import type { IpcResponse } from '@shared/ipc/contract.js';
import { invoke, subscribe } from '../../lib/ipc.js';

interface NginxHooks {
  overview: UseQueryResult<IpcResponse<'nginx:inspect'>>;
  sites: UseQueryResult<IpcResponse<'nginx:listSites'>>;
  status: UseQueryResult<IpcResponse<'nginx:liveStatus'>>;
  backups: UseQueryResult<IpcResponse<'nginx:backups'>>;
  saveSite: UseMutationResult<IpcResponse<'nginx:saveSite'>, Error, ManagedNginxSite>;
  removeSite: UseMutationResult<IpcResponse<'nginx:removeSite'>, Error, string>;
  reload: UseMutationResult<IpcResponse<'nginx:reload'>, Error, void>;
  readConfig: UseMutationResult<IpcResponse<'nginx:readConfig'>, Error, void>;
  saveConfig: UseMutationResult<IpcResponse<'nginx:saveConfig'>, Error, string>;
  logs: UseMutationResult<IpcResponse<'nginx:logs'>, Error, NginxLogQuery>;
  restore: UseMutationResult<IpcResponse<'nginx:restore'>, Error, string>;
  readBackupConfig: UseMutationResult<IpcResponse<'nginx:readBackupConfig'>, Error, string>;
}

export function useNginx(targetId: string, streamId: string): NginxHooks {
  const client = useQueryClient();
  const key = ['nginx', targetId];
  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: key });
  };
  const overview = useQuery({
    queryKey: [...key, 'overview'],
    queryFn: () => invoke('nginx:inspect', { targetId }),
    enabled: Boolean(targetId),
    refetchInterval: 30_000,
  });
  const sites = useQuery({
    queryKey: [...key, 'sites'],
    queryFn: () => invoke('nginx:listSites', { targetId }),
    enabled: Boolean(targetId),
  });
  const status = useQuery({
    queryKey: [...key, 'status'],
    queryFn: () => invoke('nginx:liveStatus', { targetId }),
    enabled: Boolean(targetId),
    refetchInterval: 15_000,
  });
  const backups = useQuery({
    queryKey: [...key, 'backups'],
    queryFn: () => invoke('nginx:backups', { targetId }),
    enabled: Boolean(targetId),
  });
  const saveSite = useMutation({
    mutationFn: (site: ManagedNginxSite) => invoke('nginx:saveSite', { targetId, site, streamId }),
    onSuccess: refresh,
  });
  const removeSite = useMutation({
    mutationFn: (domain: string) => invoke('nginx:removeSite', { targetId, domain, streamId }),
    onSuccess: refresh,
  });
  const reload = useMutation({
    mutationFn: () => invoke('nginx:reload', { targetId, streamId }),
    onSuccess: refresh,
  });
  const readConfig = useMutation({ mutationFn: () => invoke('nginx:readConfig', { targetId }) });
  const saveConfig = useMutation({
    mutationFn: (content: string) => invoke('nginx:saveConfig', { targetId, content, streamId }),
    onSuccess: refresh,
  });
  const logs = useMutation({
    mutationFn: (query: NginxLogQuery) => invoke('nginx:logs', { targetId, query }),
  });
  const restore = useMutation({
    mutationFn: (backupId: string) => invoke('nginx:restore', { targetId, backupId, streamId }),
    onSuccess: refresh,
  });
  const readBackupConfig = useMutation({
    mutationFn: (backupId: string) => invoke('nginx:readBackupConfig', { targetId, backupId }),
  });
  return {
    overview,
    sites,
    status,
    backups,
    saveSite,
    removeSite,
    reload,
    readConfig,
    saveConfig,
    logs,
    restore,
    readBackupConfig,
  };
}

export function useNginxEvents(streamId: string): { lines: string[]; clear(): void } {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(
    () =>
      subscribe('nginx:log', ({ streamId: id, event }) => {
        if (id !== streamId) return;
        setLines((current) => [
          ...current.slice(-999),
          `${event.stream === 'step' ? '▶ ' : event.stream === 'stderr' ? '! ' : ''}${event.message.trimEnd()}`,
        ]);
      }),
    [streamId],
  );
  return { lines, clear: () => setLines([]) };
}
