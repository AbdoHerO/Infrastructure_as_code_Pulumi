import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { invoke } from '../../lib/ipc.js';

/** Whether the Pulumi Infrastructure-as-Code engine is available on this host. */
export function useEngineStatus(): UseQueryResult<{ available: boolean }> {
  return useQuery({
    queryKey: ['infra', 'engineStatus'],
    queryFn: () => invoke('infra:engineStatus', undefined),
    staleTime: 60_000,
  });
}
