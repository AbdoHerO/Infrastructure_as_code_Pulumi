import { useEffect } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { McpSettingsPatch, McpStatus } from '@shared/mcp/types.js';
import { invoke, subscribe } from '../../lib/ipc.js';

const STATUS_KEY = ['mcp', 'status'] as const;

/** The MCP server's state, kept current as clients come and go. */
export function useMcpStatus(): UseQueryResult<McpStatus, Error> {
  const queryClient = useQueryClient();
  useEffect(
    () => subscribe('mcp:statusChanged', (status) => queryClient.setQueryData(STATUS_KEY, status)),
    [queryClient],
  );
  return useQuery({ queryKey: STATUS_KEY, queryFn: () => invoke('mcp:status', undefined) });
}

export function useUpdateMcpSettings(): UseMutationResult<McpStatus, Error, McpSettingsPatch> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: McpSettingsPatch) => invoke('mcp:updateSettings', patch),
    onSuccess: (status) => queryClient.setQueryData(STATUS_KEY, status),
  });
}
