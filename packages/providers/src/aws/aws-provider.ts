import {
  DescribeAvailabilityZonesCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeInstanceTypesCommand,
  DescribeInternetGatewaysCommand,
  DescribeRegionsCommand,
  DescribeSubnetsCommand,
  DescribeVolumesCommand,
  DescribeVpcsCommand,
  EC2Client,
  RebootInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { err, ok, ProviderError, type Result } from '@cloudforge/shared';
import type {
  AccountInfo,
  AvailabilityDomain,
  CloudInstance,
  CloudProvider,
  CloudResource,
  ConnectionTestResult,
  InstanceAction,
  MachineImage,
  ProviderCredentials,
  Region,
  Shape,
} from '@cloudforge/core';

interface AwsConfig {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly region: string;
}

interface CommandSender {
  send(command: unknown): Promise<unknown>;
}

/** Injectable client boundary used to test AWS mapping without network access. */
export interface AwsClientSet {
  readonly sts: CommandSender;
  readonly ec2: CommandSender;
}

interface StsIdentity {
  readonly Account?: string;
  readonly Arn?: string;
  readonly UserId?: string;
}

interface RegionsOutput {
  readonly Regions?: readonly { RegionName?: string; OptInStatus?: string }[];
}

interface ZonesOutput {
  readonly AvailabilityZones?: readonly {
    ZoneId?: string;
    ZoneName?: string;
    State?: string;
  }[];
}

interface InstanceTypesOutput {
  readonly InstanceTypes?: readonly {
    InstanceType?: string;
    VCpuInfo?: { DefaultVCpus?: number };
    MemoryInfo?: { SizeInMiB?: number };
  }[];
  readonly NextToken?: string;
}

interface ImagesOutput {
  readonly Images?: readonly {
    ImageId?: string;
    Name?: string;
    Description?: string;
    Architecture?: string;
    OwnerId?: string;
    CreationDate?: string;
    PlatformDetails?: string;
  }[];
}

interface InstancesOutput {
  readonly Reservations?: readonly {
    Instances?: readonly {
      InstanceId?: string;
      InstanceType?: string;
      State?: { Name?: string };
      Placement?: { AvailabilityZone?: string };
      LaunchTime?: Date;
      Tags?: readonly { Key?: string; Value?: string }[];
    }[];
  }[];
}

interface ResourcesOutput {
  readonly Vpcs?: readonly {
    VpcId?: string;
    State?: string;
    CidrBlock?: string;
    Tags?: AwsTag[];
  }[];
  readonly Subnets?: readonly {
    SubnetId?: string;
    State?: string;
    CidrBlock?: string;
    Tags?: AwsTag[];
  }[];
  readonly InternetGateways?: readonly {
    InternetGatewayId?: string;
    Attachments?: readonly { State?: string }[];
    Tags?: AwsTag[];
  }[];
  readonly Volumes?: readonly {
    VolumeId?: string;
    State?: string;
    Size?: number;
    Tags?: AwsTag[];
  }[];
}

interface AwsTag {
  readonly Key?: string;
  readonly Value?: string;
}

const AWS_IMAGE_LIMIT = 100;

/**
 * AWS account discovery and EC2 lifecycle adapter. Infrastructure creation is
 * compiled separately by the AWS Pulumi program, keeping the OCI adapter
 * unchanged.
 */
export class AwsProvider implements CloudProvider {
  readonly kind = 'aws' as const;

  private constructor(
    private readonly config: AwsConfig,
    private readonly clients: AwsClientSet,
  ) {}

  static fromCredentials(
    credentials: ProviderCredentials,
    clients?: AwsClientSet,
  ): Result<AwsProvider, ProviderError> {
    const required = ['accessKeyId', 'secretAccessKey', 'region'] as const;
    for (const key of required) {
      if (!credentials[key]?.trim()) {
        return err(new ProviderError(`Missing AWS credential field: ${key}`));
      }
    }

    const config: AwsConfig = {
      accessKeyId: credentials.accessKeyId!.trim(),
      secretAccessKey: credentials.secretAccessKey!.trim(),
      region: credentials.region!.trim(),
      ...(credentials.sessionToken?.trim()
        ? { sessionToken: credentials.sessionToken.trim() }
        : {}),
    };
    return ok(new AwsProvider(config, clients ?? createClients(config)));
  }

  async getAccountInfo(): Promise<Result<AccountInfo, ProviderError>> {
    try {
      const identity = (await this.clients.sts.send(
        new GetCallerIdentityCommand({}),
      )) as StsIdentity;
      if (!identity.Account) return err(new ProviderError('AWS did not return an account ID'));
      return ok({
        accountId: identity.Account,
        name: principalName(identity.Arn, identity.UserId),
        homeRegion: this.config.region,
      });
    } catch (error) {
      return err(awsError('read the caller identity', error));
    }
  }

  async testConnection(): Promise<Result<ConnectionTestResult, ProviderError>> {
    const account = await this.getAccountInfo();
    if (!account.ok) return ok({ connected: false, message: account.error.message });
    return ok({
      connected: true,
      message: `Connected to AWS account ${account.value.accountId}`,
      account: account.value,
    });
  }

  async listRegions(): Promise<Result<Region[], ProviderError>> {
    try {
      const output = (await this.clients.ec2.send(
        new DescribeRegionsCommand({ AllRegions: false }),
      )) as RegionsOutput;
      return ok(
        (output.Regions ?? [])
          .flatMap((region) =>
            region.RegionName
              ? [
                  {
                    id: region.RegionName,
                    name: region.RegionName,
                    isHome: region.RegionName === this.config.region,
                  },
                ]
              : [],
          )
          .sort((left, right) => left.name.localeCompare(right.name)),
      );
    } catch (error) {
      return err(awsError('list regions', error));
    }
  }

  async listAvailabilityDomains(): Promise<Result<AvailabilityDomain[], ProviderError>> {
    try {
      const output = (await this.clients.ec2.send(
        new DescribeAvailabilityZonesCommand({
          Filters: [{ Name: 'state', Values: ['available'] }],
        }),
      )) as ZonesOutput;
      return ok(
        (output.AvailabilityZones ?? [])
          .flatMap((zone) =>
            zone.ZoneName ? [{ id: zone.ZoneId ?? zone.ZoneName, name: zone.ZoneName }] : [],
          )
          .sort((left, right) => left.name.localeCompare(right.name)),
      );
    } catch (error) {
      return err(awsError('list availability zones', error));
    }
  }

  async listShapes(): Promise<Result<Shape[], ProviderError>> {
    try {
      const shapes: Shape[] = [];
      let nextToken: string | undefined;
      do {
        const output = (await this.clients.ec2.send(
          new DescribeInstanceTypesCommand({ ...(nextToken ? { NextToken: nextToken } : {}) }),
        )) as InstanceTypesOutput;
        for (const item of output.InstanceTypes ?? []) {
          if (!item.InstanceType) continue;
          shapes.push({
            id: item.InstanceType,
            name: item.InstanceType,
            ...(item.VCpuInfo?.DefaultVCpus !== undefined
              ? { ocpus: item.VCpuInfo.DefaultVCpus }
              : {}),
            ...(item.MemoryInfo?.SizeInMiB !== undefined
              ? { memoryGb: item.MemoryInfo.SizeInMiB / 1024 }
              : {}),
          });
        }
        nextToken = output.NextToken;
      } while (nextToken);
      return ok(shapes.sort((left, right) => left.name.localeCompare(right.name)));
    } catch (error) {
      return err(awsError('list instance types', error));
    }
  }

  async listImages(): Promise<Result<MachineImage[], ProviderError>> {
    try {
      const output = (await this.clients.ec2.send(
        new DescribeImagesCommand({
          Owners: ['amazon', '099720109477'],
          Filters: [
            { Name: 'state', Values: ['available'] },
            {
              Name: 'name',
              Values: [
                'al2023-ami-2023*-kernel-6.1-x86_64',
                'al2023-ami-2023*-kernel-6.1-arm64',
                'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-*-server-*',
                'ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-*-server-*',
              ],
            },
          ],
        }),
      )) as ImagesOutput;
      const images = (output.Images ?? [])
        .flatMap((image): MachineImage[] =>
          image.ImageId && image.Name
            ? [
                {
                  id: image.ImageId,
                  name: image.Name,
                  operatingSystem: image.PlatformDetails ?? image.Description ?? 'Linux/UNIX',
                  architecture: image.Architecture ?? 'unknown',
                  ...(image.OwnerId ? { owner: image.OwnerId } : {}),
                  ...(image.CreationDate ? { createdAt: image.CreationDate } : {}),
                },
              ]
            : [],
        )
        .sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''))
        .slice(0, AWS_IMAGE_LIMIT);
      return ok(images);
    } catch (error) {
      return err(awsError('list machine images', error));
    }
  }

  async listInstances(): Promise<Result<CloudInstance[], ProviderError>> {
    try {
      const output = (await this.clients.ec2.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] },
          ],
        }),
      )) as InstancesOutput;
      return ok(mapInstances(output, this.config.region));
    } catch (error) {
      return err(awsError('list EC2 instances', error));
    }
  }

  async terminateInstance(instanceId: string): Promise<Result<void, ProviderError>> {
    try {
      await this.clients.ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
      return ok(undefined);
    } catch (error) {
      return err(awsError('terminate the EC2 instance', error));
    }
  }

  async instanceAction(
    instanceId: string,
    action: InstanceAction,
  ): Promise<Result<CloudInstance, ProviderError>> {
    try {
      const command =
        action === 'start'
          ? new StartInstancesCommand({ InstanceIds: [instanceId] })
          : action === 'stop'
            ? new StopInstancesCommand({ InstanceIds: [instanceId] })
            : new RebootInstancesCommand({ InstanceIds: [instanceId] });
      await this.clients.ec2.send(command);
      const output = (await this.clients.ec2.send(
        new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
      )) as InstancesOutput;
      const instance = mapInstances(output, this.config.region)[0];
      if (!instance) return err(new ProviderError('AWS did not return the updated EC2 instance'));
      return ok(instance);
    } catch (error) {
      return err(awsError(`${action} the EC2 instance`, error));
    }
  }

  async listResources(): Promise<Result<CloudResource[], ProviderError>> {
    try {
      const [vpcs, subnets, gateways, volumes] = (await Promise.all([
        this.clients.ec2.send(new DescribeVpcsCommand({})),
        this.clients.ec2.send(new DescribeSubnetsCommand({})),
        this.clients.ec2.send(new DescribeInternetGatewaysCommand({})),
        this.clients.ec2.send(new DescribeVolumesCommand({})),
      ])) as [ResourcesOutput, ResourcesOutput, ResourcesOutput, ResourcesOutput];
      return ok([
        ...(vpcs.Vpcs ?? []).flatMap((item) =>
          item.VpcId
            ? [
                cloudResource(
                  item.VpcId,
                  item.Tags,
                  'vcn',
                  item.State,
                  this.config.region,
                  item.CidrBlock,
                ),
              ]
            : [],
        ),
        ...(subnets.Subnets ?? []).flatMap((item) =>
          item.SubnetId
            ? [
                cloudResource(
                  item.SubnetId,
                  item.Tags,
                  'subnet',
                  item.State,
                  this.config.region,
                  item.CidrBlock,
                ),
              ]
            : [],
        ),
        ...(gateways.InternetGateways ?? []).flatMap((item) =>
          item.InternetGatewayId
            ? [
                cloudResource(
                  item.InternetGatewayId,
                  item.Tags,
                  'internet-gateway',
                  item.Attachments?.[0]?.State,
                  this.config.region,
                ),
              ]
            : [],
        ),
        ...(volumes.Volumes ?? []).flatMap((item) =>
          item.VolumeId
            ? [
                cloudResource(
                  item.VolumeId,
                  item.Tags,
                  'volume',
                  item.State,
                  this.config.region,
                  item.Size === undefined ? undefined : `${item.Size} GB`,
                ),
              ]
            : [],
        ),
      ]);
    } catch (error) {
      return err(awsError('list AWS infrastructure resources', error));
    }
  }
}

function createClients(config: AwsConfig): AwsClientSet {
  const credentials = {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
  };
  return {
    sts: new STSClient({ region: config.region, credentials }),
    ec2: new EC2Client({ region: config.region, credentials }),
  };
}

function mapInstances(output: InstancesOutput, region: string): CloudInstance[] {
  return (output.Reservations ?? []).flatMap((reservation) =>
    (reservation.Instances ?? []).flatMap((instance) =>
      instance.InstanceId
        ? [
            {
              id: instance.InstanceId,
              name: tagName(instance.Tags) ?? instance.InstanceId,
              state: instance.State?.Name ?? 'unknown',
              shape: instance.InstanceType ?? 'unknown',
              availabilityDomain: instance.Placement?.AvailabilityZone ?? 'unknown',
              region,
              ...(instance.LaunchTime ? { createdAt: instance.LaunchTime.toISOString() } : {}),
            },
          ]
        : [],
    ),
  );
}

function cloudResource(
  id: string,
  tags: readonly AwsTag[] | undefined,
  type: CloudResource['type'],
  state: string | undefined,
  region: string,
  details?: string,
): CloudResource {
  return {
    id,
    name: tagName(tags) ?? id,
    type,
    state: state ?? 'available',
    region,
    ...(details ? { details } : {}),
  };
}

function tagName(tags: readonly AwsTag[] | undefined): string | undefined {
  return tags?.find((tag) => tag.Key === 'Name')?.Value;
}

function principalName(arn: string | undefined, userId: string | undefined): string {
  if (!arn) return userId ?? 'AWS principal';
  const parts = arn.split('/');
  return parts.at(-1) ?? arn;
}

function awsError(operation: string, cause: unknown): ProviderError {
  const candidate = cause as {
    name?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number; requestId?: string };
  };
  return new ProviderError(`Could not ${operation}: ${candidate.message ?? 'AWS request failed'}`, {
    cause,
    context: {
      provider: 'aws',
      operation,
      errorName: candidate.name ?? 'UnknownAwsError',
      statusCode: candidate.$metadata?.httpStatusCode,
      requestId: candidate.$metadata?.requestId,
    },
  });
}
