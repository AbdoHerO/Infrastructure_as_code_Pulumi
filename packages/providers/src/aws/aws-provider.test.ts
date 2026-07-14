import { describe, expect, it } from 'vitest';
import type { AwsClientSet } from './aws-provider.js';
import { AwsProvider } from './aws-provider.js';

const credentials = {
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'test-secret',
  region: 'eu-west-1',
};

function clients(): AwsClientSet {
  return {
    sts: {
      send: () =>
        Promise.resolve({
          Account: '123456789012',
          Arn: 'arn:aws:iam::123456789012:user/cloudforge',
          UserId: 'AIDAEXAMPLE',
        }),
    },
    ec2: {
      send: (command) => {
        switch ((command as { constructor: { name: string } }).constructor.name) {
          case 'DescribeRegionsCommand':
            return Promise.resolve({
              Regions: [{ RegionName: 'eu-west-1' }, { RegionName: 'us-east-1' }],
            });
          case 'DescribeAvailabilityZonesCommand':
            return Promise.resolve({
              AvailabilityZones: [
                { ZoneId: 'euw1-az1', ZoneName: 'eu-west-1a', State: 'available' },
              ],
            });
          case 'DescribeInstanceTypesCommand':
            return Promise.resolve({
              InstanceTypes: [
                {
                  InstanceType: 't4g.small',
                  VCpuInfo: { DefaultVCpus: 2 },
                  MemoryInfo: { SizeInMiB: 2048 },
                },
              ],
            });
          case 'DescribeImagesCommand':
            return Promise.resolve({
              Images: [
                {
                  ImageId: 'ami-123',
                  Name: 'ubuntu/images/ubuntu-noble-24.04-arm64-server-20260714',
                  Architecture: 'arm64',
                  PlatformDetails: 'Linux/UNIX',
                  CreationDate: '2026-07-14T00:00:00.000Z',
                },
              ],
            });
          case 'DescribeInstancesCommand':
            return Promise.resolve({
              Reservations: [
                {
                  Instances: [
                    {
                      InstanceId: 'i-123',
                      InstanceType: 't3.micro',
                      State: { Name: 'running' },
                      Placement: { AvailabilityZone: 'eu-west-1a' },
                      LaunchTime: new Date('2026-07-14T00:00:00.000Z'),
                      Tags: [{ Key: 'Name', Value: 'web-server' }],
                    },
                  ],
                },
              ],
            });
          case 'DescribeVpcsCommand':
            return Promise.resolve({
              Vpcs: [
                {
                  VpcId: 'vpc-123',
                  State: 'available',
                  CidrBlock: '10.0.0.0/16',
                  Tags: [{ Key: 'Name', Value: 'network' }],
                },
              ],
            });
          case 'DescribeSubnetsCommand':
            return Promise.resolve({ Subnets: [] });
          case 'DescribeInternetGatewaysCommand':
            return Promise.resolve({ InternetGateways: [] });
          case 'DescribeVolumesCommand':
            return Promise.resolve({ Volumes: [] });
          case 'StartInstancesCommand':
          case 'StopInstancesCommand':
          case 'RebootInstancesCommand':
          case 'TerminateInstancesCommand':
            return Promise.resolve({});
          default:
            return Promise.reject(new Error('Unexpected AWS command'));
        }
      },
    },
  };
}

function provider(): AwsProvider {
  const result = AwsProvider.fromCredentials(credentials, clients());
  if (!result.ok) throw result.error;
  return result.value;
}

describe('AwsProvider', () => {
  it('validates every required field before creating clients', () => {
    expect(AwsProvider.fromCredentials({ ...credentials, region: '' }).ok).toBe(false);
    expect(AwsProvider.fromCredentials({ ...credentials, secretAccessKey: '' }).ok).toBe(false);
  });

  it('tests credentials with STS without exposing secret fields', async () => {
    const result = await provider().testConnection();
    expect(result).toEqual({
      ok: true,
      value: {
        connected: true,
        message: 'Connected to AWS account 123456789012',
        account: {
          accountId: '123456789012',
          name: 'cloudforge',
          homeRegion: 'eu-west-1',
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('test-secret');
  });

  it('maps regions, availability zones, instance types, and images', async () => {
    const aws = provider();
    const regions = await aws.listRegions();
    const zones = await aws.listAvailabilityDomains();
    const shapes = await aws.listShapes();
    const images = await aws.listImages();

    expect(regions.ok && regions.value.find((region) => region.id === 'eu-west-1')?.isHome).toBe(
      true,
    );
    expect(zones.ok && zones.value[0]?.name).toBe('eu-west-1a');
    expect(shapes.ok && shapes.value[0]).toMatchObject({
      id: 't4g.small',
      ocpus: 2,
      memoryGb: 2,
    });
    expect(images.ok && images.value[0]).toMatchObject({
      id: 'ami-123',
      architecture: 'arm64',
    });
  });

  it('discovers and controls EC2 instances without leaking credentials', async () => {
    const aws = provider();
    const instances = await aws.listInstances();
    const started = await aws.instanceAction('i-123', 'start');
    const terminated = await aws.terminateInstance('i-123');

    expect(instances.ok && instances.value[0]).toMatchObject({
      id: 'i-123',
      name: 'web-server',
      state: 'running',
      shape: 't3.micro',
    });
    expect(started.ok && started.value.id).toBe('i-123');
    expect(terminated.ok).toBe(true);
  });

  it('discovers AWS network and storage resources', async () => {
    const result = await provider().listResources();
    expect(result.ok && result.value[0]).toMatchObject({
      id: 'vpc-123',
      name: 'network',
      type: 'vcn',
      details: '10.0.0.0/16',
    });
  });
});
