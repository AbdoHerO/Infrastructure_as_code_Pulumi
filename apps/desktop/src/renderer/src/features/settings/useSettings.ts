import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { AppSettings, SettingsPatch } from '@cloudforge/core';
import { invoke } from '../../lib/ipc.js';

const SETTINGS_KEY = ['settings'] as const;

/** Read the persisted application settings. */
export function useSettings(): UseQueryResult<AppSettings> {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => invoke('settings:get', undefined),
  });
}

/** Update a subset of settings; the server returns the merged result. */
export function useUpdateSettings(): UseMutationResult<AppSettings, Error, SettingsPatch> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => invoke('settings:update', patch),
    onSuccess: (settings) => queryClient.setQueryData(SETTINGS_KEY, settings),
  });
}
