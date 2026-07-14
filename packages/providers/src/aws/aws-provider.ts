import {
  DescribeAvailabilityZonesCommand,
  DescribeImagesCommand,
  DescribeInstanceTypesCommand,
  DescribeRegionsCommand,
  EC2Client,
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

const AWS_IMAGE_LIMIT = 100;

/**
 * AWS discovery adapter. It is completely separate from the OCI adapter and
 * performs no infrastructure mutations in this milestone increment.
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

  listInstances(): Promise<Result<CloudInstance[], ProviderError>> {
    return unsupported('instance discovery');
  }

  terminateInstance(_instanceId: string): Promise<Result<void, ProviderError>> {
    return unsupported('instance termination');
  }

  instanceAction(
    _instanceId: string,
    _action: InstanceAction,
  ): Promise<Result<CloudInstance, ProviderError>> {
    return unsupported('instance lifecycle actions');
  }

  listResources(): Promise<Result<CloudResource[], ProviderError>> {
    return unsupported('infrastructure resource discovery');
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

function unsupported<T>(capability: string): Promise<Result<T, ProviderError>> {
  return Promise.resolve(
    err(new ProviderError(`AWS ${capability} is not enabled in this milestone increment`)),
  );
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
