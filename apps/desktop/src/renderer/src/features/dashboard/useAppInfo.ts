import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { AppInfo } from '@shared/ipc/contract.js';
import { invoke } from '../../lib/ipc.js';

/** Fetch runtime application/host information from the main process. */
export function useAppInfo(): UseQueryResult<AppInfo> {
  return useQuery({
    queryKey: ['app', 'info'],
    queryFn: () => invoke('app:getInfo', undefined),
    staleTime: Infinity,
  });
}
