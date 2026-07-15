import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  CloudflareDashboard,
  CloudflareDnsRecord,
  CloudflareDnsRecordInput,
  CloudflareZone,
  CloudflareZoneSettings,
} from '@cloudforge/core';
import { invoke } from '../../lib/ipc.js';

export const cloudflareKey = (credentialId: string) => ['cloudflare', credentialId] as const;

export function useCloudflareZones(
  credentialId: string,
): UseQueryResult<readonly CloudflareZone[]> {
  return useQuery({
    queryKey: [...cloudflareKey(credentialId), 'zones'],
    queryFn: () => invoke('cloudflare:zones', { credentialId }),
    enabled: Boolean(credentialId),
    retry: false,
  });
}

export function useCloudflareDashboard(
  credentialId: string,
  zoneId: string,
  zonesReady = true,
): UseQueryResult<CloudflareDashboard> {
  return useQuery({
    queryKey: [...cloudflareKey(credentialId), 'dashboard', zoneId],
    queryFn: () => invoke('cloudflare:dashboard', { credentialId, ...(zoneId ? { zoneId } : {}) }),
    enabled: Boolean(credentialId && zonesReady),
    retry: false,
  });
}

export function useCloudflareDns(
  credentialId: string,
  zoneId: string,
): UseQueryResult<readonly CloudflareDnsRecord[]> {
  return useQuery({
    queryKey: [...cloudflareKey(credentialId), 'dns', zoneId],
    queryFn: () => invoke('cloudflare:dnsRecords', { credentialId, zoneId }),
    enabled: Boolean(credentialId && zoneId),
  });
}

export function useSaveCloudflareDns(
  credentialId: string,
  zoneId: string,
): UseMutationResult<
  CloudflareDnsRecord,
  Error,
  { recordId?: string; input: CloudflareDnsRecordInput }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ recordId, input }: { recordId?: string; input: CloudflareDnsRecordInput }) =>
      recordId
        ? invoke('cloudflare:updateDnsRecord', { credentialId, zoneId, recordId, input })
        : invoke('cloudflare:createDnsRecord', { credentialId, zoneId, input }),
    onSuccess: () => client.invalidateQueries({ queryKey: [...cloudflareKey(credentialId)] }),
  });
}

export function useDeleteCloudflareDns(
  credentialId: string,
  zoneId: string,
): UseMutationResult<void, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (recordId: string) =>
      invoke('cloudflare:deleteDnsRecord', { credentialId, zoneId, recordId }),
    onSuccess: () => client.invalidateQueries({ queryKey: [...cloudflareKey(credentialId)] }),
  });
}

export function useCloudflareZoneSettings(
  credentialId: string,
  zoneId: string,
): UseQueryResult<CloudflareZoneSettings> {
  return useQuery({
    queryKey: [...cloudflareKey(credentialId), 'settings', zoneId],
    queryFn: () => invoke('cloudflare:zoneSettings', { credentialId, zoneId }),
    enabled: Boolean(credentialId && zoneId),
  });
}

export function useUpdateCloudflareZoneSettings(
  credentialId: string,
  zoneId: string,
): UseMutationResult<CloudflareZoneSettings, Error, Partial<CloudflareZoneSettings>> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<CloudflareZoneSettings>) =>
      invoke('cloudflare:updateZoneSettings', { credentialId, zoneId, patch }),
    onSuccess: () => client.invalidateQueries({ queryKey: [...cloudflareKey(credentialId)] }),
  });
}
