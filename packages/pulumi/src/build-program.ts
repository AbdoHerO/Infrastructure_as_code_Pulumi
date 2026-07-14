import type { PulumiFn } from '@pulumi/pulumi/automation';
import type { InfrastructurePlan } from '@cloudforge/core';
import { buildAwsProgram, type AwsCredentials } from './aws-program.js';
import { buildOracleProgram, type OciCredentials } from './oci-program.js';

/** Credential fields Oracle Cloud provisioning requires. */
const ORACLE_REQUIRED = [
  'tenancyOcid',
  'userOcid',
  'compartmentOcid',
  'fingerprint',
  'privateKey',
  'region',
] as const;
const AWS_REQUIRED = ['accessKeyId', 'secretAccessKey', 'region'] as const;

/**
 * Compile a declarative {@link InfrastructurePlan} into a Pulumi inline program.
 *
 * When provider credentials are supplied the program provisions **real** cloud
 * resources through the matching provider (Oracle Cloud or AWS). Without
 * credentials it falls back to a metadata-only program that surfaces the plan
 * as stack outputs (used for offline validation and unit tests, requiring no
 * cloud account).
 */
export function buildProgram(
  plan: InfrastructurePlan,
  credentials?: Readonly<Record<string, string>>,
): PulumiFn {
  if (plan.providerKind === 'oracle' && credentials && hasOracleCredentials(credentials)) {
    return buildOracleProgram(plan, toOciCredentials(credentials));
  }
  if (plan.providerKind === 'aws' && credentials && hasAwsCredentials(credentials)) {
    return buildAwsProgram(plan, toAwsCredentials(credentials));
  }
  return metadataProgram(plan);
}

function hasAwsCredentials(credentials: Readonly<Record<string, string>>): boolean {
  return AWS_REQUIRED.every((key) => (credentials[key] ?? '').trim().length > 0);
}

function toAwsCredentials(credentials: Readonly<Record<string, string>>): AwsCredentials {
  return {
    accessKeyId: credentials.accessKeyId ?? '',
    secretAccessKey: credentials.secretAccessKey ?? '',
    ...(credentials.sessionToken?.trim() ? { sessionToken: credentials.sessionToken.trim() } : {}),
    region: credentials.region ?? '',
  };
}

/** A program that creates no resources, only echoing the plan as outputs. */
function metadataProgram(plan: InfrastructurePlan): PulumiFn {
  return () =>
    Promise.resolve({
      providerKind: plan.providerKind,
      resourceCount: plan.resources.length,
      resources: plan.resources.map((resource) => ({ name: resource.name, kind: resource.kind })),
    });
}

function hasOracleCredentials(credentials: Readonly<Record<string, string>>): boolean {
  return ORACLE_REQUIRED.every((key) => (credentials[key] ?? '').trim().length > 0);
}

function toOciCredentials(credentials: Readonly<Record<string, string>>): OciCredentials {
  return {
    tenancyOcid: credentials.tenancyOcid ?? '',
    userOcid: credentials.userOcid ?? '',
    compartmentOcid: credentials.compartmentOcid ?? '',
    fingerprint: credentials.fingerprint ?? '',
    privateKey: credentials.privateKey ?? '',
    region: credentials.region ?? '',
  };
}
