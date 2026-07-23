/**
 * Query and mutation hooks for a VPS's runtime plan.
 *
 * The split here is deliberate and load-bearing. Reads (`plan`, `drift`,
 * `connectivity`) are queries that refetch freely, because none of them touch
 * the VPS's state. Writes are mutations, and the only one that changes a VPS —
 * `apply` — cannot be called without a token minted by `preview` moments
 * earlier. Nothing in this file can start a change on its own.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  HostFirewallState,
  RuntimeAdoption,
  RuntimeApplyOptions,
  RuntimeApplyReport,
  RuntimeConnectivityReport,
  RuntimeDriftReport,
  RuntimePlanView,
  RuntimePreview,
  VpsRuntimePlan,
} from '@cloudforge/core';
import { invoke } from '../../lib/ipc.js';

type ResourceKind = RuntimeAdoption['resourceKind'];
interface AdoptionRequest {
  readonly resourceKind: ResourceKind;
  readonly dockerName: string;
}
interface ApplyRequest {
  readonly streamId: string;
  readonly previewToken: string;
  readonly confirmations?: readonly string[];
  readonly options?: RuntimeApplyOptions;
}

export interface RuntimeActions {
  readonly setMode: UseMutationResult<RuntimePlanView, Error, VpsRuntimePlan['mode']>;
  readonly adopt: UseMutationResult<RuntimePlanView, Error, AdoptionRequest>;
  readonly release: UseMutationResult<RuntimePlanView, Error, AdoptionRequest>;
  readonly openFirewall: UseMutationResult<HostFirewallState, Error, void>;
  readonly preview: UseMutationResult<RuntimePreview, Error, RuntimeApplyOptions | undefined>;
  readonly apply: UseMutationResult<RuntimeApplyReport, Error, ApplyRequest>;
}

/** Every read for one target, so a write can invalidate the lot in one call. */
const keys = {
  plan: (targetId: string) => ['runtime', 'plan', targetId] as const,
  drift: (targetId: string) => ['runtime', 'drift', targetId] as const,
  connectivity: (targetId: string) => ['runtime', 'connectivity', targetId] as const,
};

export function useRuntimePlan(targetId: string): UseQueryResult<RuntimePlanView, Error> {
  return useQuery({
    queryKey: keys.plan(targetId),
    queryFn: () => invoke('runtime:getPlan', { targetId }),
    enabled: Boolean(targetId),
  });
}

/**
 * Drift, which needs an SSH round-trip to the VPS.
 *
 * Never on a timer. It is a read, but a read that opens a connection and runs
 * `docker inspect` — polling it would put a background load on someone's
 * production server for a page they may not be looking at.
 */
export function useRuntimeDrift(
  targetId: string,
  enabled: boolean,
): UseQueryResult<RuntimeDriftReport, Error> {
  return useQuery({
    queryKey: keys.drift(targetId),
    queryFn: () => invoke('runtime:drift', { targetId }),
    enabled: Boolean(targetId) && enabled,
    retry: false,
  });
}

export function useRuntimeConnectivity(
  targetId: string,
  enabled: boolean,
): UseQueryResult<RuntimeConnectivityReport, Error> {
  return useQuery({
    queryKey: keys.connectivity(targetId),
    // No `providerRules`: the cloud security list needs a credential this page
    // does not hold. Every provider verdict comes back honestly `unknown`
    // rather than as a guess, and the report says so in one place.
    queryFn: () => invoke('runtime:connectivity', { targetId }),
    enabled: Boolean(targetId) && enabled,
    retry: false,
  });
}

export function useRuntimeActions(targetId: string): RuntimeActions {
  const client = useQueryClient();
  const invalidate = async (): Promise<void> => {
    await Promise.all([
      client.invalidateQueries({ queryKey: keys.plan(targetId) }),
      client.invalidateQueries({ queryKey: keys.drift(targetId) }),
      client.invalidateQueries({ queryKey: keys.connectivity(targetId) }),
    ]);
  };

  return {
    setMode: useMutation({
      mutationFn: (mode: VpsRuntimePlan['mode']) => invoke('runtime:setMode', { targetId, mode }),
      onSuccess: invalidate,
    }),
    adopt: useMutation({
      mutationFn: (input: AdoptionRequest) => invoke('runtime:adopt', { targetId, ...input }),
      onSuccess: invalidate,
    }),
    release: useMutation({
      mutationFn: (input: AdoptionRequest) => invoke('runtime:release', { targetId, ...input }),
      onSuccess: invalidate,
    }),
    openFirewall: useMutation({
      mutationFn: () => invoke('runtime:openFirewall', { targetId }),
      onSuccess: invalidate,
    }),
    preview: useMutation({
      mutationFn: (options?: RuntimeApplyOptions) =>
        invoke('runtime:preview', { targetId, ...(options === undefined ? {} : { options }) }),
    }),
    apply: useMutation({
      mutationFn: (input: ApplyRequest) => invoke('runtime:apply', { targetId, ...input }),
      onSuccess: invalidate,
    }),
  };
}
