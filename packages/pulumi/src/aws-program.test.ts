import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as pulumi from '@pulumi/pulumi';
import type { MockCallArgs, MockResourceArgs } from '@pulumi/pulumi/runtime/mocks.js';
import type { InfrastructurePlan } from '@cloudforge/core';
import { buildAwsProgram } from './aws-program.js';

interface RegisteredResource {
  readonly type: string;
  readonly name: string;
  readonly inputs: Record<string, unknown>;
}

const registered: RegisteredResource[] = [];

beforeAll(async () => {
  await pulumi.runtime.setMocks({
    newResource: (args: MockResourceArgs) => {
      const inputs = args.inputs as Record<string, unknown>;
      registered.push({ type: args.type, name: args.name, inputs });
      return {
        id: `${args.name}-id`,
        state: {
          ...inputs,
          publicIp: '198.51.100.10',
          privateIp: '10.0.1.10',
          availabilityZone: 'eu-west-1a',
          keyName: `${args.name}-key`,
        },
      };
    },
    call: (args: MockCallArgs): Record<string, unknown> => {
      if (args.token === 'aws:ec2/getAmi:getAmi') return { id: 'ami-test' };
      if (args.token.includes('getAvailabilityZones')) {
        return { names: ['eu-west-1a'], zoneIds: ['euw1-az1'] };
      }
      return {};
    },
  });
});

beforeEach(() => registered.splice(0));

describe('buildAwsProgram', () => {
  it('translates a generic plan into VPC, firewall, subnet, EC2, key and volume resources', async () => {
    const plan: InfrastructurePlan = {
      providerKind: 'aws',
      config: { region: 'eu-west-1' },
      resources: [
        { kind: 'network', name: 'network', cidrBlock: '10.0.0.0/16' },
        {
          kind: 'firewall',
          name: 'firewall',
          networkName: 'network',
          rules: [{ protocol: 'tcp', port: 22, source: '0.0.0.0/0', direction: 'ingress' }],
        },
        {
          kind: 'subnet',
          name: 'subnet',
          networkName: 'network',
          cidrBlock: '10.0.1.0/24',
          public: true,
        },
        {
          kind: 'compute',
          name: 'server',
          shape: 't3.micro',
          image: 'ubuntu-24.04',
          subnetName: 'subnet',
          sshPublicKey: 'ssh-ed25519 AAAATEST cloudforge',
          assignPublicIp: true,
          bootVolumeGb: 30,
        },
        { kind: 'volume', name: 'data', sizeGb: 20, attachTo: 'server' },
      ],
    };

    await pulumi.runtime.runInPulumiStack(
      buildAwsProgram(plan, {
        accessKeyId: 'AKIA_TEST',
        secretAccessKey: 'secret-test',
        region: 'eu-west-1',
      }),
    );

    expect(registered.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        'pulumi:providers:aws',
        'aws:ec2/vpc:Vpc',
        'aws:ec2/internetGateway:InternetGateway',
        'aws:ec2/routeTable:RouteTable',
        'aws:ec2/securityGroup:SecurityGroup',
        'aws:ec2/subnet:Subnet',
        'aws:ec2/keyPair:KeyPair',
        'aws:ec2/instance:Instance',
        'aws:ebs/volume:Volume',
        'aws:ec2/volumeAttachment:VolumeAttachment',
      ]),
    );
    const instance = registered.find(({ type }) => type === 'aws:ec2/instance:Instance');
    expect(instance?.inputs).toMatchObject({
      instanceType: 't3.micro',
      associatePublicIpAddress: true,
      rootBlockDevice: { volumeSize: 30, volumeType: 'gp3' },
    });
  });
});
