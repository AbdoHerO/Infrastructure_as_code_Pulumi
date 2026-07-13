import type * as pulumi from '@pulumi/pulumi';
import * as oci from '@pulumi/oci';
import type { PulumiFn } from '@pulumi/pulumi/automation';
import type { FirewallRule, InfrastructurePlan } from '@cloudforge/core';

/**
 * The decrypted Oracle Cloud credentials the program needs to configure an
 * explicit `oci.Provider`. These come from the project's stored credential and
 * are captured in the inline-program closure — they never touch the persisted
 * plan or Pulumi state as plaintext (the private key is stored encrypted with
 * the stack passphrase).
 */
export interface OciCredentials {
  readonly tenancyOcid: string;
  readonly userOcid: string;
  readonly compartmentOcid: string;
  readonly fingerprint: string;
  readonly privateKey: string;
  readonly region: string;
}

/** OCI protocol numbers for the plan's transport protocols. */
const PROTOCOL: Record<FirewallRule['protocol'], string> = {
  tcp: '6',
  udp: '17',
  icmp: '1',
  all: 'all',
};

/**
 * Compile an {@link InfrastructurePlan} into a Pulumi inline program that
 * provisions **real** Oracle Cloud resources: a VCN per network (with an
 * internet gateway and public route table), security lists per firewall,
 * subnets, compute instances and block volumes. Every resource is bound to an
 * explicit provider built from the supplied credentials, so applying the stack
 * creates resources visible in the Oracle Cloud Console.
 */
export function buildOracleProgram(plan: InfrastructurePlan, creds: OciCredentials): PulumiFn {
  return () => {
    const provider = new oci.Provider('oci', {
      tenancyOcid: creds.tenancyOcid,
      userOcid: creds.userOcid,
      fingerprint: creds.fingerprint,
      privateKey: creds.privateKey,
      region: creds.region,
    });
    const opts: pulumi.CustomResourceOptions = { provider };
    const invokeOpts: pulumi.InvokeOptions = { provider };
    const compartmentId = creds.compartmentOcid;

    // The first availability domain in the compartment — where instances and
    // block volumes are placed. Resolved once and reused.
    const availabilityDomain = oci.identity
      .getAvailabilityDomains({ compartmentId }, invokeOpts)
      .then((result) => result.availabilityDomains[0]?.name ?? '');

    const vcns = new Map<string, oci.core.Vcn>();
    const publicRouteTables = new Map<string, oci.core.RouteTable>();
    const securityListsByNetwork = new Map<string, oci.core.SecurityList[]>();
    const subnets = new Map<string, oci.core.Subnet>();
    const instances = new Map<string, oci.core.Instance>();

    const outputs: Record<string, pulumi.Input<unknown>> = {
      providerKind: plan.providerKind,
      resourceCount: plan.resources.length,
    };

    // 1. Networks → VCN + internet gateway + public route table.
    for (const resource of plan.resources) {
      if (resource.kind !== 'network') continue;
      const net = resource;
      const vcn = new oci.core.Vcn(
        net.name,
        { compartmentId, cidrBlocks: [net.cidrBlock], displayName: net.name },
        opts,
      );
      vcns.set(net.name, vcn);

      const gateway = new oci.core.InternetGateway(
        `${net.name}-igw`,
        { compartmentId, vcnId: vcn.id, enabled: true, displayName: `${net.name}-igw` },
        opts,
      );
      const routeTable = new oci.core.RouteTable(
        `${net.name}-rt`,
        {
          compartmentId,
          vcnId: vcn.id,
          displayName: `${net.name}-rt`,
          routeRules: [
            {
              destination: '0.0.0.0/0',
              destinationType: 'CIDR_BLOCK',
              networkEntityId: gateway.id,
            },
          ],
        },
        opts,
      );
      publicRouteTables.set(net.name, routeTable);
      outputs[`${net.name}Id`] = vcn.id;
    }

    // 2. Firewalls → security lists attached to their network's subnets.
    for (const resource of plan.resources) {
      if (resource.kind !== 'firewall') continue;
      const firewall = resource;
      const vcn = vcns.get(firewall.networkName);
      if (!vcn) continue;

      const ingress = firewall.rules
        .filter((rule) => rule.direction === 'ingress')
        .map((rule) => ingressRule(rule));
      const egress = firewall.rules
        .filter((rule) => rule.direction === 'egress')
        .map((rule) => egressRule(rule));
      // Always allow outbound traffic so instances can reach the internet
      // (package installs, updates) even when the plan lists only ingress rules.
      if (egress.length === 0) {
        egress.push({ protocol: 'all', destination: '0.0.0.0/0', destinationType: 'CIDR_BLOCK' });
      }

      const securityList = new oci.core.SecurityList(
        firewall.name,
        {
          compartmentId,
          vcnId: vcn.id,
          displayName: firewall.name,
          ingressSecurityRules: ingress,
          egressSecurityRules: egress,
        },
        opts,
      );
      const list = securityListsByNetwork.get(firewall.networkName) ?? [];
      list.push(securityList);
      securityListsByNetwork.set(firewall.networkName, list);
    }

    // 3. Subnets → attach the public route table + security lists of the network.
    for (const resource of plan.resources) {
      if (resource.kind !== 'subnet') continue;
      const spec = resource;
      const vcn = vcns.get(spec.networkName);
      if (!vcn) continue;

      const securityLists = securityListsByNetwork.get(spec.networkName) ?? [];
      const routeTable = publicRouteTables.get(spec.networkName);
      const subnet = new oci.core.Subnet(
        spec.name,
        {
          compartmentId,
          vcnId: vcn.id,
          cidrBlock: spec.cidrBlock,
          displayName: spec.name,
          prohibitPublicIpOnVnic: !spec.public,
          // Public subnets route egress through the internet gateway; private
          // subnets fall back to the VCN default route table.
          ...(spec.public && routeTable ? { routeTableId: routeTable.id } : {}),
          // When the network has firewalls, bind their security lists; otherwise
          // OCI attaches the VCN's default security list automatically.
          ...(securityLists.length > 0
            ? { securityListIds: securityLists.map((sl) => sl.id) }
            : {}),
        },
        opts,
      );
      subnets.set(spec.name, subnet);
    }

    // 4. Compute → instances launched from the newest matching platform image.
    for (const resource of plan.resources) {
      if (resource.kind !== 'compute') continue;
      const spec = resource;
      const subnet = subnets.get(spec.subnetName);
      if (!subnet) continue;

      const image = imageQuery(spec.image);
      const imageId = oci.core
        .getImages(
          {
            compartmentId,
            operatingSystem: image.operatingSystem,
            operatingSystemVersion: image.version,
            shape: spec.shape,
            sortBy: 'TIMECREATED',
            sortOrder: 'DESC',
          },
          invokeOpts,
        )
        .then((result) => result.images[0]?.id ?? '');

      const instance = new oci.core.Instance(
        spec.name,
        {
          compartmentId,
          availabilityDomain,
          shape: spec.shape,
          // Flexible shapes require an explicit OCPU/memory allocation.
          ...(spec.shape.includes('Flex')
            ? { shapeConfig: { ocpus: 1, memoryInGbs: 6 } }
            : {}),
          sourceDetails: {
            sourceType: 'image',
            sourceId: imageId,
            ...(spec.bootVolumeGb ? { bootVolumeSizeInGbs: String(spec.bootVolumeGb) } : {}),
          },
          createVnicDetails: {
            subnetId: subnet.id,
            assignPublicIp: String(spec.assignPublicIp),
            displayName: spec.name,
          },
          ...(spec.sshPublicKey.trim()
            ? { metadata: { ssh_authorized_keys: spec.sshPublicKey } }
            : {}),
          displayName: spec.name,
        },
        opts,
      );
      instances.set(spec.name, instance);
      outputs[`${spec.name}PublicIp`] = instance.publicIp;
      outputs[`${spec.name}PrivateIp`] = instance.privateIp;
    }

    // 5. Volumes → block volume + optional attachment to an instance.
    for (const resource of plan.resources) {
      if (resource.kind !== 'volume') continue;
      const spec = resource;
      const volume = new oci.core.Volume(
        spec.name,
        {
          compartmentId,
          availabilityDomain,
          sizeInGbs: String(spec.sizeGb),
          displayName: spec.name,
        },
        opts,
      );
      const target = spec.attachTo ? instances.get(spec.attachTo) : undefined;
      if (target) {
        new oci.core.VolumeAttachment(
          `${spec.name}-att`,
          { attachmentType: 'paravirtualized', instanceId: target.id, volumeId: volume.id },
          opts,
        );
      }
      outputs[`${spec.name}Id`] = volume.id;
    }

    return Promise.resolve(outputs);
  };
}

/** Build an OCI ingress security rule from a plan firewall rule. */
function ingressRule(rule: FirewallRule): oci.types.input.Core.SecurityListIngressSecurityRule {
  return {
    protocol: PROTOCOL[rule.protocol],
    source: rule.source,
    sourceType: 'CIDR_BLOCK',
    ...portOptions(rule),
  };
}

/** Build an OCI egress security rule from a plan firewall rule. */
function egressRule(rule: FirewallRule): oci.types.input.Core.SecurityListEgressSecurityRule {
  return {
    protocol: PROTOCOL[rule.protocol],
    destination: rule.source,
    destinationType: 'CIDR_BLOCK',
    ...portOptions(rule),
  };
}

/** Restrict a TCP/UDP rule to a single destination port, when one is given. */
function portOptions(rule: FirewallRule): {
  tcpOptions?: { min: number; max: number };
  udpOptions?: { min: number; max: number };
} {
  if (rule.port === undefined) return {};
  const range = { min: rule.port, max: rule.port };
  if (rule.protocol === 'tcp') return { tcpOptions: range };
  if (rule.protocol === 'udp') return { udpOptions: range };
  return {};
}

/** Map a plan image identifier (e.g. `ubuntu-22.04`) to an OCI image search. */
function imageQuery(image: string): { operatingSystem: string; version: string } {
  const normalized = image.trim().toLowerCase();
  const match = /^([a-z-]+?)-?(\d+(?:\.\d+)?)$/.exec(normalized);
  const version = match?.[2] ?? '22.04';
  const family = match?.[1] ?? 'ubuntu';
  if (family.includes('oracle')) return { operatingSystem: 'Oracle Linux', version };
  if (family.includes('centos')) return { operatingSystem: 'CentOS', version };
  return { operatingSystem: 'Canonical Ubuntu', version };
}
