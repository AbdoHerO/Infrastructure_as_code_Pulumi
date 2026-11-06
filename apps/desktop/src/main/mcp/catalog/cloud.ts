import { z } from 'zod/v4';
import type { InfrastructurePlan, VpsRuntimePlan } from '@cloudforge/core';
import { compact, type McpTool, McpToolError, toolset } from '../types.js';
import { credentialId, id, port } from './common.js';

const cloud = toolset('cloud');
const infrastructure = toolset('infrastructure');

const engineLog = { logChannel: 'engine:log' } as const;
const instanceId = id('Instance id, from providers_list_instances');

const liveFirewallRule = z.object({
  id: z.string().describe('Keep an existing id; any new unique text for a new rule'),
  direction: z.enum(['ingress', 'egress']),
  protocol: z.enum(['tcp', 'udp', 'icmp', 'all']),
  cidr: z.string().describe('e.g. 0.0.0.0/0'),
  portFrom: port.nullable(),
  portTo: port.nullable(),
  description: z.string(),
  stateless: z.boolean(),
});
const liveFirewallRules = z.array(liveFirewallRule);

const planResource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('network'), name: z.string(), cidrBlock: z.string() }),
  z.object({
    kind: z.literal('subnet'),
    name: z.string(),
    networkName: z.string(),
    cidrBlock: z.string(),
    public: z.boolean(),
  }),
  z.object({
    kind: z.literal('firewall'),
    name: z.string(),
    networkName: z.string(),
    rules: z.array(
      z.object({
        protocol: z.enum(['tcp', 'udp', 'icmp', 'all']),
        port: port.optional(),
        source: z.string(),
        direction: z.enum(['ingress', 'egress']),
      }),
    ),
  }),
  z.object({
    kind: z.literal('compute'),
    name: z.string(),
    shape: z.string(),
    image: z.string(),
    subnetName: z.string(),
    sshPublicKey: z.string(),
    sshCredentialId: z.string().optional(),
    assignPublicIp: z.boolean(),
    ocpus: z.number().positive().optional(),
    memoryGb: z.number().positive().optional(),
    bootVolumeGb: z.number().positive().optional(),
    availabilityDomain: z.string().optional(),
  }),
  z.object({
    kind: z.literal('volume'),
    name: z.string(),
    sizeGb: z.number().positive(),
    attachTo: z.string().optional(),
  }),
]);

const plan = z
  .object({
    providerKind: z.string().describe('oracle or aws; must match the project linked credential'),
    config: z.record(z.string(), z.string()).default({}),
    resources: z.array(planResource),
  })
  .describe('The whole desired infrastructure. See infra_resource_presets for starting points.');

const asPlan = (value: unknown): InfrastructurePlan => value as InfrastructurePlan;

async function refuseToReplacePlan(
  context: Parameters<McpTool['run']>[1],
  replaceExistingPlan: boolean,
): Promise<void> {
  if (replaceExistingPlan) return;
  const existing = await context.call('infra:getPlan', { projectId: context.projectId() });
  if (existing) {
    throw new McpToolError(
      'This project already has a saved plan and a template replaces it. Pass replaceExistingPlan: true if that is what you want.',
    );
  }
}

const replaceExistingPlan = z
  .boolean()
  .default(false)
  .describe('Required when the project already has a saved plan, which this replaces');

export const CLOUD_TOOLS: readonly McpTool[] = [
  cloud.call(
    'providers_test_connection',
    'providers:test',
    'read',
    'Check that a cloud credential works and show its account.',
    { credentialId },
    (input) => input,
  ),
  cloud.call(
    'providers_list_regions',
    'providers:listRegions',
    'read',
    'Regions available to a cloud credential.',
    { credentialId },
    (input) => input,
  ),
  cloud.call(
    'providers_list_shapes',
    'providers:listShapes',
    'read',
    'Instance shapes available to a cloud credential.',
    { credentialId },
    (input) => input,
  ),
  cloud.call(
    'providers_list_images',
    'providers:listImages',
    'read',
    'Machine images available to launch.',
    { credentialId },
    (input) => input,
  ),
  cloud.call(
    'providers_list_availability_domains',
    'providers:listAvailabilityDomains',
    'read',
    'Availability domains or zones of the credential region.',
    { credentialId },
    (input) => input,
  ),
  cloud.call(
    'providers_list_instances',
    'providers:listInstances',
    'read',
    'Compute instances in the account, including ones made outside CloudForge.',
    { credentialId },
    (input) => input,
  ),
  cloud.call(
    'providers_list_resources',
    'providers:listResources',
    'read',
    'Networks, subnets, gateways and volumes in the account.',
    { credentialId },
    (input) => input,
  ),
  cloud.call(
    'providers_start_instance',
    'providers:instanceAction',
    'write',
    'Start a stopped instance and wait until it is running.',
    { credentialId, instanceId },
    (input) => ({ ...input, action: 'start' as const }),
    { idempotent: true, operation: { logChannel: null } },
  ),
  cloud.call(
    'providers_stop_instance',
    'providers:instanceAction',
    'critical',
    'Stop an instance. Whatever runs on it goes offline.',
    { credentialId, instanceId },
    (input) => ({ ...input, action: 'stop' as const }),
    { operation: { logChannel: null } },
  ),
  cloud.call(
    'providers_reboot_instance',
    'providers:instanceAction',
    'critical',
    'Reboot an instance. Whatever runs on it is briefly offline.',
    { credentialId, instanceId },
    (input) => ({ ...input, action: 'reboot' as const }),
    { operation: { logChannel: null } },
  ),
  cloud.call(
    'providers_terminate_instance',
    'providers:terminateInstance',
    'critical',
    'Permanently delete an instance and its boot volume.',
    {
      credentialId,
      instanceId,
      confirmationName: z.string().describe("The instance's exact name"),
    },
    (input) => input,
    { operation: { logChannel: null } },
  ),
  cloud.call(
    'cloud_firewall_get',
    'firewall:get',
    'read',
    "An instance's live cloud firewall rules: its Oracle security list or AWS security groups.",
    { credentialId, instanceId },
    (input) => input,
  ),
  cloud.custom(
    'cloud_firewall_update',
    ['firewall:update', 'firewall:analyze'],
    'critical',
    'Replace the live cloud firewall rules of an instance, and report anything risky in the result. A mistake can lock everyone out.',
    {
      credentialId,
      instanceId,
      expectedRules: liveFirewallRules.describe(
        'The rules exactly as cloud_firewall_get returned them; the change is refused if they have changed since',
      ),
      rules: liveFirewallRules.describe('The complete new set of rules'),
    },
    async (input, context) => {
      const updated = await context.call('firewall:update', {
        credentialId: input.credentialId,
        instanceId: input.instanceId,
        expectedRules: input.expectedRules,
        rules: input.rules,
      });
      const { warnings } = await context.call('firewall:analyze', { rules: updated.rules });
      return { ...updated, warnings };
    },
  ),
  cloud.call(
    'cloud_firewall_analyze',
    'firewall:analyze',
    'read',
    'Check a set of firewall rules: duplicates, SSH or all traffic open to the internet, stateless rules, overlaps, and whether given ports are reachable from the internet. Also lists ready-made rules for common services.',
    {
      rules: liveFirewallRules,
      ports: z.array(port).optional().describe('Ports to test for public reachability'),
    },
    (input) => compact({ rules: input.rules, ports: input.ports }),
    { openWorld: false },
  ),
  cloud.call(
    'cloud_firewall_history',
    'firewall:history',
    'read',
    "Past changes to an instance's cloud firewall, each with the rules before and after. Roll back by passing a `before` set to cloud_firewall_update.",
    { instanceId, limit: z.number().int().min(1).max(500).default(50) },
    (input) => input,
    { openWorld: false },
  ),
];

export const INFRASTRUCTURE_TOOLS: readonly McpTool[] = [
  infrastructure.call(
    'infra_engine_status',
    'infra:engineStatus',
    'read',
    'Whether the infrastructure engine (Pulumi) is available on this computer.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  infrastructure.call(
    'infra_get_plan',
    'infra:getPlan',
    'read',
    "The project's saved infrastructure plan, or null when it has none.",
    {},
    (_input, context) => ({ projectId: context.projectId() }),
    { openWorld: false },
  ),
  infrastructure.custom(
    'infra_save_plan',
    ['infra:savePlan', 'infra:validate'],
    'write',
    "Save the project's infrastructure plan and report any problems in it. Changes nothing in the cloud; run infra_preview, then infra_apply.",
    { plan },
    async (input, context) => {
      const saved = asPlan(input.plan);
      await context.call('infra:savePlan', { projectId: context.projectId(), plan: saved });
      return { saved: true, issues: await context.call('infra:validate', { plan: saved }) };
    },
    { openWorld: false, idempotent: true },
  ),
  infrastructure.call(
    'infra_validate_plan',
    'infra:validate',
    'read',
    'Check a plan for duplicate names and references to things that do not exist.',
    { plan },
    (input) => ({ plan: asPlan(input.plan) }),
    { openWorld: false },
  ),
  infrastructure.call(
    'infra_preview',
    'infra:preview',
    'read',
    'Work out what applying the saved plan would change in the cloud. Returns the previewToken infra_apply needs, and which changes delete or replace something.',
    {},
    (_input, context) => ({ projectId: context.projectId(), streamId: context.streamId }),
    { operation: engineLog },
  ),
  infrastructure.call(
    'infra_apply',
    'infra:apply',
    'critical',
    'Make the cloud match the saved plan. This creates real resources that can cost money. Needs a fresh previewToken; refused if the plan has problems.',
    {
      previewToken: z.string().min(1).describe('From infra_preview on the current saved plan'),
      acceptDestructiveChanges: z
        .boolean()
        .default(false)
        .describe('Required when the preview deletes or replaces resources'),
    },
    (input, context) => ({
      projectId: context.projectId(),
      streamId: context.streamId,
      previewToken: input.previewToken,
      acceptDestructiveChanges: input.acceptDestructiveChanges,
    }),
    { operation: engineLog },
  ),
  infrastructure.call(
    'infra_destroy',
    'infra:destroy',
    'critical',
    "Destroy every cloud resource of this project's stack and delete its saved plan and managed targets. Data on them is lost.",
    {},
    (_input, context) => ({ projectId: context.projectId(), streamId: context.streamId }),
    { operation: engineLog },
  ),
  infrastructure.call(
    'infra_refresh',
    'infra:refresh',
    'write',
    'Update the stack state from the cloud to detect changes made elsewhere. Changes no cloud resource.',
    {},
    (_input, context) => ({ projectId: context.projectId(), streamId: context.streamId }),
    { operation: engineLog, idempotent: true },
  ),
  infrastructure.call(
    'infra_get_outputs',
    'infra:outputs',
    'read',
    "The stack's outputs, such as public addresses. Also refreshes this project's managed VPS targets.",
    {},
    (_input, context) => ({ projectId: context.projectId() }),
  ),
  infrastructure.call(
    'infra_list_managed_stacks',
    'infra:managedStacks',
    'read',
    "This project's stack and the resources it manages.",
    {},
    () => undefined,
    { openWorld: false },
  ),
  infrastructure.call(
    'infra_destroy_stack',
    'infra:destroyStack',
    'critical',
    "Destroy a managed stack by name, from infra_list_managed_stacks. Only this project's stack is accepted.",
    { project: z.string().min(1), stack: z.string().min(1) },
    (input, context) => ({
      ref: { project: input.project, stack: input.stack },
      streamId: context.streamId,
    }),
    { operation: engineLog },
  ),
  infrastructure.call(
    'infra_list_templates',
    'infra:templates',
    'read',
    'Built-in infrastructure templates.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  infrastructure.custom(
    'infra_apply_template',
    ['infra:applyTemplate', 'infra:getPlan'],
    'write',
    "Fill the project's saved plan from a built-in template. Changes nothing in the cloud.",
    {
      templateId: id('Template id, from infra_list_templates'),
      sshCredentialId: z.string().optional().describe('Saved SSH key to install on the instances'),
      sshPublicKey: z.string().optional().describe('Or a public key that is not saved'),
      region: z.string().optional(),
      shape: z.string().optional().describe('Instance shape instead of the template default'),
      replaceExistingPlan,
    },
    async ({ replaceExistingPlan: replace, ...input }, context) => {
      await refuseToReplacePlan(context, replace);
      return context.call(
        'infra:applyTemplate',
        compact({ ...input, projectId: context.projectId() }),
      );
    },
    { openWorld: false },
  ),
  infrastructure.call(
    'infra_list_custom_templates',
    'infra:customTemplates',
    'read',
    'Templates saved in this project.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  infrastructure.call(
    'infra_get_custom_template',
    'infra:getCustomTemplate',
    'read',
    'A saved template with its full plan.',
    { id: id('Template id, from infra_list_custom_templates') },
    (input) => input,
    { openWorld: false },
  ),
  infrastructure.call(
    'infra_save_custom_template',
    'infra:saveTemplate',
    'write',
    'Save a plan as a reusable template.',
    { name: z.string().min(1), description: z.string().optional(), plan },
    (input) => compact({ ...input, plan: asPlan(input.plan) }),
    { openWorld: false },
  ),
  infrastructure.call(
    'infra_delete_custom_template',
    'infra:deleteTemplate',
    'critical',
    'Delete a saved template.',
    { id: id('Template id, from infra_list_custom_templates') },
    (input) => input,
    { openWorld: false },
  ),
  infrastructure.custom(
    'infra_apply_custom_template',
    ['infra:applyCustomTemplate', 'infra:getPlan'],
    'write',
    "Fill the project's saved plan from a saved template. Changes nothing in the cloud.",
    {
      templateId: id('Template id, from infra_list_custom_templates'),
      replaceExistingPlan,
    },
    async ({ templateId, replaceExistingPlan: replace }, context) => {
      await refuseToReplacePlan(context, replace);
      return context.call('infra:applyCustomTemplate', {
        projectId: context.projectId(),
        templateId,
      });
    },
    { openWorld: false },
  ),
  infrastructure.call(
    'infra_resource_presets',
    'infra:resourcePresets',
    'read',
    'Default network, subnet, firewall, compute and volume resources, plus common shapes and images, to start writing a plan from.',
    { providerKind: z.enum(['oracle', 'aws']).optional() },
    (input) => compact(input),
    { openWorld: false },
  ),
  infrastructure.call(
    'infra_ssh_connections',
    'infra:sshConnections',
    'read',
    "SSH addresses of the stack's instances, with the saved key each one uses and the command to connect.",
    {},
    (_input, context) => ({ projectId: context.projectId() }),
  ),
];

export const asRuntimePlan = (value: unknown): VpsRuntimePlan => value as VpsRuntimePlan;
