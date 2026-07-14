import type * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import type { PulumiFn } from '@pulumi/pulumi/automation';
import type { FirewallRule, InfrastructurePlan } from '@cloudforge/core';

/** Decrypted AWS fields captured only by the inline Pulumi program. */
export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly region: string;
}

/** Compile the provider-independent plan into real AWS VPC/EC2/EBS resources. */
export function buildAwsProgram(plan: InfrastructurePlan, creds: AwsCredentials): PulumiFn {
  return () => {
    const provider = new aws.Provider('aws', {
      accessKey: creds.accessKeyId,
      secretKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { token: creds.sessionToken } : {}),
      region: creds.region as aws.Region,
    });
    const opts: pulumi.CustomResourceOptions = { provider };
    const invokeOpts: pulumi.InvokeOptions = { provider };
    const tags = (name: string): Record<string, string> => ({
      Name: name,
      ManagedBy: 'CloudForge',
    });

    const vpcs = new Map<string, aws.ec2.Vpc>();
    const gateways = new Map<string, aws.ec2.InternetGateway>();
    const routeTables = new Map<string, aws.ec2.RouteTable>();
    const securityGroups = new Map<string, aws.ec2.SecurityGroup[]>();
    const subnets = new Map<string, aws.ec2.Subnet>();
    const subnetNetworks = new Map<string, string>();
    const instances = new Map<string, aws.ec2.Instance>();
    const outputs: Record<string, pulumi.Input<unknown>> = {
      providerKind: 'aws',
      resourceCount: plan.resources.length,
    };

    for (const resource of plan.resources) {
      if (resource.kind !== 'network') continue;
      const vpc = new aws.ec2.Vpc(
        resource.name,
        {
          cidrBlock: resource.cidrBlock,
          enableDnsHostnames: true,
          enableDnsSupport: true,
          tags: tags(resource.name),
        },
        opts,
      );
      const gateway = new aws.ec2.InternetGateway(
        `${resource.name}-igw`,
        { vpcId: vpc.id, tags: tags(`${resource.name}-igw`) },
        opts,
      );
      const routeTable = new aws.ec2.RouteTable(
        `${resource.name}-rt`,
        {
          vpcId: vpc.id,
          routes: [{ cidrBlock: '0.0.0.0/0', gatewayId: gateway.id }],
          tags: tags(`${resource.name}-rt`),
        },
        opts,
      );
      vpcs.set(resource.name, vpc);
      gateways.set(resource.name, gateway);
      routeTables.set(resource.name, routeTable);
      outputs[`${resource.name}Id`] = vpc.id;
    }

    for (const resource of plan.resources) {
      if (resource.kind !== 'firewall') continue;
      const vpc = vpcs.get(resource.networkName);
      if (!vpc) continue;
      const ingress = resource.rules
        .filter((rule) => rule.direction === 'ingress')
        .map(toSecurityGroupRule);
      const plannedEgress = resource.rules
        .filter((rule) => rule.direction === 'egress')
        .map(toSecurityGroupRule);
      const group = new aws.ec2.SecurityGroup(
        resource.name,
        {
          vpcId: vpc.id,
          description: `CloudForge firewall ${resource.name}`,
          ingress,
          egress:
            plannedEgress.length > 0
              ? plannedEgress
              : [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }],
          tags: tags(resource.name),
        },
        opts,
      );
      const groups = securityGroups.get(resource.networkName) ?? [];
      groups.push(group);
      securityGroups.set(resource.networkName, groups);
    }

    for (const resource of plan.resources) {
      if (resource.kind !== 'subnet') continue;
      const vpc = vpcs.get(resource.networkName);
      if (!vpc) continue;
      const subnet = new aws.ec2.Subnet(
        resource.name,
        {
          vpcId: vpc.id,
          cidrBlock: resource.cidrBlock,
          mapPublicIpOnLaunch: resource.public,
          tags: tags(resource.name),
        },
        opts,
      );
      subnets.set(resource.name, subnet);
      subnetNetworks.set(resource.name, resource.networkName);
      if (resource.public) {
        const routeTable = routeTables.get(resource.networkName);
        if (routeTable) {
          new aws.ec2.RouteTableAssociation(
            `${resource.name}-rta`,
            { subnetId: subnet.id, routeTableId: routeTable.id },
            opts,
          );
        }
      }
    }

    for (const resource of plan.resources) {
      if (resource.kind !== 'compute') continue;
      const subnet = subnets.get(resource.subnetName);
      if (!subnet) continue;
      const networkName = subnetNetworks.get(resource.subnetName);
      const groups = networkName ? (securityGroups.get(networkName) ?? []) : [];
      const keyPair = resource.sshPublicKey.trim()
        ? new aws.ec2.KeyPair(
            `${resource.name}-key`,
            { publicKey: resource.sshPublicKey.trim(), tags: tags(`${resource.name}-key`) },
            opts,
          )
        : undefined;
      const ami = resolveAmi(resource.image, resource.shape, invokeOpts);
      const instance = new aws.ec2.Instance(
        resource.name,
        {
          ami,
          instanceType: resource.shape,
          subnetId: subnet.id,
          associatePublicIpAddress: resource.assignPublicIp,
          ...(groups.length > 0 ? { vpcSecurityGroupIds: groups.map((group) => group.id) } : {}),
          ...(keyPair ? { keyName: keyPair.keyName } : {}),
          ...(resource.bootVolumeGb
            ? { rootBlockDevice: { volumeSize: resource.bootVolumeGb, volumeType: 'gp3' } }
            : {}),
          tags: tags(resource.name),
        },
        opts,
      );
      instances.set(resource.name, instance);
      outputs[`${resource.name}PublicIp`] = instance.publicIp;
      outputs[`${resource.name}PrivateIp`] = instance.privateIp;
      outputs[`${resource.name}SshUser`] = defaultSshUser(resource.image);
      outputs[`${resource.name}Id`] = instance.id;
    }

    const defaultZone = aws
      .getAvailabilityZones({ state: 'available' }, invokeOpts)
      .then((result) => result.names[0] ?? '');
    for (const resource of plan.resources) {
      if (resource.kind !== 'volume') continue;
      const target = resource.attachTo ? instances.get(resource.attachTo) : undefined;
      const volume = new aws.ebs.Volume(
        resource.name,
        {
          availabilityZone: target ? target.availabilityZone : defaultZone,
          size: resource.sizeGb,
          type: 'gp3',
          tags: tags(resource.name),
        },
        opts,
      );
      if (target) {
        new aws.ec2.VolumeAttachment(
          `${resource.name}-att`,
          { deviceName: '/dev/sdf', instanceId: target.id, volumeId: volume.id },
          opts,
        );
      }
      outputs[`${resource.name}Id`] = volume.id;
    }

    return Promise.resolve(outputs);
  };
}

function toSecurityGroupRule(rule: FirewallRule): aws.types.input.ec2.SecurityGroupIngress {
  const source = rule.source.trim();
  const port = rule.port ?? 0;
  return {
    protocol: rule.protocol === 'all' ? '-1' : rule.protocol,
    fromPort: port,
    toPort: port,
    ...(source.includes(':') ? { ipv6CidrBlocks: [source] } : { cidrBlocks: [source] }),
  };
}

function resolveAmi(
  image: string,
  instanceType: string,
  opts: pulumi.InvokeOptions,
): pulumi.Input<string> {
  const requested = image.trim();
  if (requested.startsWith('ami-')) return requested;
  const arm =
    /(?:^|\.)[a-z0-9]*g[a-z0-9]*\./i.test(`.${instanceType}.`) || instanceType.startsWith('a1.');
  const architecture = arm ? 'arm64' : 'x86_64';
  const normalized = requested.toLowerCase();
  const amazonLinux = normalized.includes('amazon') || normalized.includes('al2023');
  return aws.ec2
    .getAmi(
      {
        mostRecent: true,
        owners: [amazonLinux ? 'amazon' : '099720109477'],
        filters: [
          { name: 'architecture', values: [architecture] },
          { name: 'virtualization-type', values: ['hvm'] },
          {
            name: 'name',
            values: [
              amazonLinux
                ? `al2023-ami-2023*-kernel-6.1-${architecture}`
                : ubuntuAmiPattern(normalized, architecture),
            ],
          },
        ],
      },
      opts,
    )
    .then((result) => result.id);
}

function ubuntuAmiPattern(image: string, architecture: string): string {
  const release = image.includes('24.04') ? 'noble-24.04' : 'jammy-22.04';
  const suffix = architecture === 'arm64' ? 'arm64' : 'amd64';
  return `ubuntu/images/hvm-ssd-gp3/ubuntu-${release}-${suffix}-server-*`;
}

function defaultSshUser(image: string): string {
  return image.toLowerCase().includes('amazon') || image.toLowerCase().includes('al2023')
    ? 'ec2-user'
    : 'ubuntu';
}
