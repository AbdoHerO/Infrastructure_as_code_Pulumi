import { describe, expect, it } from 'vitest';
import type { LiveFirewallRule } from '@cloudforge/core';
import type { AwsClientSet } from './aws-provider.js';
import { AwsProvider } from './aws-provider.js';

const credentials = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret', region: 'eu-west-1' };

interface SentCommand {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

const INSTANCE = {
  InstanceId: 'i-1',
  State: { Name: 'running' },
  SubnetId: 'subnet-1',
  PublicIpAddress: '203.0.113.9',
  PrivateIpAddress: '10.0.1.5',
  SecurityGroups: [{ GroupId: 'sg-1' }],
  Tags: [{ Key: 'Name', Value: 'web' }],
};

const SSH_RULE = {
  SecurityGroupRuleId: 'sgr-ssh',
  GroupId: 'sg-1',
  IsEgress: false,
  IpProtocol: 'tcp',
  FromPort: 22,
  ToPort: 22,
  CidrIpv4: '0.0.0.0/0',
  Description: 'ssh',
};
const EGRESS_RULE = {
  SecurityGroupRuleId: 'sgr-out',
  GroupId: 'sg-1',
  IsEgress: true,
  IpProtocol: '-1',
  FromPort: -1,
  ToPort: -1,
  CidrIpv4: '0.0.0.0/0',
};

function fixture(rules: readonly unknown[] = [SSH_RULE, EGRESS_RULE]): {
  provider: AwsProvider;
  sent: SentCommand[];
} {
  const sent: SentCommand[] = [];
  const clients: AwsClientSet = {
    sts: { send: () => Promise.resolve({}) },
    ec2: {
      send: (command) => {
        const { constructor, input } = command as {
          constructor: { name: string };
          input: Record<string, unknown>;
        };
        sent.push({ name: constructor.name, input });
        switch (constructor.name) {
          case 'DescribeInstancesCommand':
            return Promise.resolve({ Reservations: [{ Instances: [INSTANCE] }] });
          case 'DescribeSubnetsCommand':
            return Promise.resolve({
              Subnets: [{ SubnetId: 'subnet-1', Tags: [{ Key: 'Name', Value: 'public' }] }],
            });
          case 'DescribeSecurityGroupRulesCommand':
            return Promise.resolve({ SecurityGroupRules: rules });
          default:
            return Promise.resolve({});
        }
      },
    },
  };
  const created = AwsProvider.fromCredentials(credentials, clients);
  if (!created.ok) throw created.error;
  return { provider: created.value, sent };
}

const changes = (sent: readonly SentCommand[]): SentCommand[] =>
  sent.filter((command) => !command.name.startsWith('Describe'));

const httpsRule: LiveFirewallRule = {
  id: 'new-rule',
  direction: 'ingress',
  protocol: 'tcp',
  cidr: '0.0.0.0/0',
  portFrom: 443,
  portTo: 443,
  description: 'https',
  stateless: false,
};
const sshRule: LiveFirewallRule = {
  id: 'sgr-ssh',
  direction: 'ingress',
  protocol: 'tcp',
  cidr: '0.0.0.0/0',
  portFrom: 22,
  portTo: 22,
  description: 'ssh',
  stateless: false,
};
const egressRule: LiveFirewallRule = {
  id: 'sgr-out',
  direction: 'egress',
  protocol: 'all',
  cidr: '0.0.0.0/0',
  portFrom: null,
  portTo: null,
  description: '',
  stateless: false,
};

describe('AWS instance firewall', () => {
  it('reads the security group rules and the instance details', async () => {
    const { provider } = fixture();
    const result = await provider.getInstanceFirewall('i-1');
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      provider: 'aws',
      instanceId: 'i-1',
      instanceName: 'web',
      state: 'running',
      subnetId: 'subnet-1',
      subnetName: 'public',
      securityListId: 'sg-1',
      publicIp: '203.0.113.9',
      privateIp: '10.0.1.5',
    });
    expect(result.value.rules).toEqual([sshRule, egressRule]);
  });

  it('leaves out rules it cannot express, so an update never touches them', async () => {
    const reference = {
      SecurityGroupRuleId: 'sgr-ref',
      GroupId: 'sg-1',
      IsEgress: false,
      IpProtocol: 'tcp',
      FromPort: 80,
      ToPort: 80,
      ReferencedGroupInfo: { GroupId: 'sg-2' },
    };
    const { provider, sent } = fixture([SSH_RULE, reference]);
    const read = await provider.getInstanceFirewall('i-1');
    if (!read.ok) throw read.error;
    expect(read.value.rules.map((rule) => rule.id)).toEqual(['sgr-ssh']);

    sent.length = 0;
    await provider.updateInstanceFirewall('i-1', [sshRule]);
    expect(changes(sent)).toEqual([]);
  });

  it('shows a whole port range as all ports', async () => {
    const all = { ...SSH_RULE, FromPort: 0, ToPort: 65535 };
    const { provider } = fixture([all]);
    const read = await provider.getInstanceFirewall('i-1');
    if (!read.ok) throw read.error;
    expect(read.value.rules[0]).toMatchObject({ portFrom: null, portTo: null });
  });

  it('changes nothing when the rules are the same', async () => {
    const { provider, sent } = fixture();
    await provider.updateInstanceFirewall('i-1', [sshRule, egressRule]);
    expect(changes(sent)).toEqual([]);
  });

  it('adds a new rule to the security group', async () => {
    const { provider, sent } = fixture();
    await provider.updateInstanceFirewall('i-1', [sshRule, egressRule, httpsRule]);
    expect(changes(sent)).toEqual([
      {
        name: 'AuthorizeSecurityGroupIngressCommand',
        input: {
          GroupId: 'sg-1',
          IpPermissions: [
            {
              IpProtocol: 'tcp',
              FromPort: 443,
              ToPort: 443,
              IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'https' }],
            },
          ],
        },
      },
    ]);
  });

  it('uses the IPv6 range for an IPv6 address block', async () => {
    const { provider, sent } = fixture();
    await provider.updateInstanceFirewall('i-1', [
      sshRule,
      egressRule,
      { ...httpsRule, cidr: '::/0', description: '' },
    ]);
    expect(changes(sent)[0]?.input.IpPermissions).toEqual([
      { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, Ipv6Ranges: [{ CidrIpv6: '::/0' }] },
    ]);
  });

  it('removes a rule that is gone, by its id', async () => {
    const { provider, sent } = fixture();
    await provider.updateInstanceFirewall('i-1', [egressRule]);
    expect(changes(sent)).toEqual([
      {
        name: 'RevokeSecurityGroupIngressCommand',
        input: { GroupId: 'sg-1', SecurityGroupRuleIds: ['sgr-ssh'] },
      },
    ]);
  });

  it('edits a changed rule in place, so it is never briefly missing', async () => {
    const { provider, sent } = fixture();
    await provider.updateInstanceFirewall('i-1', [
      { ...sshRule, cidr: '198.51.100.0/24' },
      egressRule,
    ]);
    expect(changes(sent)).toEqual([
      {
        name: 'ModifySecurityGroupRulesCommand',
        input: {
          GroupId: 'sg-1',
          SecurityGroupRules: [
            {
              SecurityGroupRuleId: 'sgr-ssh',
              SecurityGroupRule: {
                IpProtocol: 'tcp',
                FromPort: 22,
                ToPort: 22,
                CidrIpv4: '198.51.100.0/24',
                Description: 'ssh',
              },
            },
          ],
        },
      },
    ]);
  });

  it('adds before it removes when a rule changes direction', async () => {
    const { provider, sent } = fixture();
    await provider.updateInstanceFirewall('i-1', [{ ...sshRule, direction: 'egress' }, egressRule]);
    expect(changes(sent).map((command) => command.name)).toEqual([
      'AuthorizeSecurityGroupEgressCommand',
      'RevokeSecurityGroupIngressCommand',
    ]);
  });

  it('refuses stateless rules, which security groups do not have', async () => {
    const { provider, sent } = fixture();
    const result = await provider.updateInstanceFirewall('i-1', [
      { ...httpsRule, stateless: true },
    ]);
    expect(result.ok).toBe(false);
    expect(changes(sent)).toEqual([]);
  });
});
