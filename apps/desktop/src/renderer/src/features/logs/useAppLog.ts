import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { invoke } from '../../lib/ipc.js';

/** Location of the application log file. */
export function useLogInfo(): UseQueryResult<{ path: string; dir: string }> {
  return useQuery({
    queryKey: ['logs', 'info'],
    queryFn: () => invoke('logs:info', undefined),
    staleTime: Infinity,
  });
}

/** Live tail of the application log file (polled). */
export function useLogTail(lines = 400): UseQueryResult<string[]> {
  return useQuery({
    queryKey: ['logs', 'tail', lines],
    queryFn: () => invoke('logs:tail', { lines }),
    refetchInterval: 3000,
  });
}

/** Open the log folder in the OS file manager. */
export function openLogFolder(): Promise<void> {
  return invoke('logs:openFolder', undefined);
}
