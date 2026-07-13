import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ActivityDto } from '@cloudforge/core';
import { invoke } from '../../lib/ipc.js';

/** Read the activity feed (most recent first). */
export function useActivity(limit = 200): UseQueryResult<ActivityDto[]> {
  return useQuery({
    queryKey: ['activity', limit],
    queryFn: () => invoke('activity:list', { limit }),
    refetchInterval: 15_000,
  });
}
