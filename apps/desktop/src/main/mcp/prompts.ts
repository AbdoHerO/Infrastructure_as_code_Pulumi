import { McpToolError } from './types.js';

interface PromptArgument {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
}

interface McpPrompt {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly arguments: readonly PromptArgument[];
  readonly text: (args: Readonly<Record<string, string>>) => string;
}

const argument = (name: string, description: string, required = false): PromptArgument => ({
  name,
  description,
  required,
});

const target = argument('target', 'The saved VPS target, by name or id');
const domain = argument('domain', 'The domain, e.g. app.example.com');
const named = (value: string | undefined, fallback: string): string => {
  const given = value?.trim() ?? '';
  return given === '' ? fallback : given;
};

const steps = (intro: string, list: readonly string[], closing?: string): string =>
  [intro, '', ...list.map((step, index) => `${String(index + 1)}. ${step}`)]
    .concat(closing ? ['', closing] : [])
    .join('\n');

/** The workflows the window walks people through, for a client to follow. */
export const MCP_PROMPTS: readonly McpPrompt[] = [
  {
    name: 'onboard-vps',
    title: 'Add a server',
    description: 'Save a server as a VPS target, safely, and prepare it.',
    arguments: [argument('host', 'The server address'), argument('name', 'A name for the target')],
    text: (args) =>
      steps(`Add the server ${named(args.host, 'the user names')} to CloudForge.`, [
        'List SSH credentials with credentials_list (kinds ssh and ssh-password). If none fits, ask the user which to use; ssh_keys_generate can make one, and its public key must then be installed on the server.',
        'Call targets_inspect_host_key and show the user the fingerprint. Ask them to compare it with what their provider shows. Do not continue until they confirm: this is what stops you connecting to the wrong machine.',
        `Save it with targets_create as "${named(args.name, 'a name the user chooses')}", passing that same fingerprint.`,
        'Run ansible_preflight. If its status is needs-repair, tell the user what it would install and run ansible_repair, then ansible_preflight again. If it is blocked, report why and stop.',
      ]),
  },
  {
    name: 'install-service',
    title: 'Install a service',
    description: 'Install Docker, Jenkins, Nginx, PostgreSQL and others on a server.',
    arguments: [
      target,
      argument('profile', 'docker, dockhand, portainer, jenkins, nginx or postgres'),
    ],
    text: (args) =>
      steps(
        `Install ${named(args.profile, 'the service the user wants')} on ${named(args.target, 'the chosen target')}.`,
        [
          'Call ansible_list_profiles and read the variables this profile takes. Ask the user about any that are required and have no default.',
          'Call ansible_get_profile_states to see whether it is already there; re-running updates it.',
          'Run ansible_preflight with the profile and variables. Fix a needs-repair result with ansible_repair; stop on blocked.',
          'Run ansible_run_profile. It can take minutes: follow it with operations_wait using the operationId if it is still running.',
          'Confirm with ansible_get_profile_states. A port it reports as blocked by the firewall can be opened with host_firewall_open, and may also need opening in the cloud firewall.',
          'For Jenkins and PostgreSQL, the login is available through ansible_get_access if the user has allowed secrets.',
        ],
      ),
  },
  {
    name: 'provision-infrastructure',
    title: 'Create cloud infrastructure',
    description: 'Plan, preview and create servers and networks in the cloud.',
    arguments: [argument('need', 'What the infrastructure is for')],
    text: (args) =>
      steps(`Create cloud infrastructure for: ${named(args.need, 'what the user describes')}.`, [
        'Check infra_engine_status. Check the project has a linked oracle or aws credential with projects_list_open; projects_update links one.',
        'Start from infra_list_templates and infra_apply_template, or write a plan using infra_resource_presets and save it with infra_save_plan. Fix every issue it reports.',
        'Run infra_preview and show the user what it would create, change or delete, and that real resources can cost money.',
        'Run infra_apply with its previewToken. If the preview deletes or replaces anything, say exactly what, and pass acceptDestructiveChanges only once the user agrees. The user also approves this in the CloudForge window.',
        'Read infra_get_outputs and targets_list: public instances become saved VPS targets automatically.',
      ]),
  },
  {
    name: 'deploy-docker-stack',
    title: 'Deploy a Docker stack',
    description: 'Deploy a Docker Compose stack and publish it on a domain.',
    arguments: [target, domain, argument('folder', 'Folder with the Compose file and .env')],
    text: (args) =>
      steps(
        `Deploy a Docker stack on ${named(args.target, 'the chosen target')}${args.domain ? ` at ${args.domain}` : ''}.`,
        [
          `Read the files: stacks_read_folder${args.folder ? ` with ${args.folder}` : ''}, or stacks_analyze on Compose text the user gives. Fix anything in its errors.`,
          'For each public domain choose the service and its container port. List Cloudflare accounts and zones with credentials_list and cloudflare_list_zones.',
          'Check every domain with domains_check. Do not continue past a conflict.',
          'Run stacks_create. Prefer folderPath so the .env never passes through the conversation.',
          'Confirm with stacks_status. Report any warnings on the stack, such as HTTPS not issued yet.',
        ],
      ),
  },
  {
    name: 'deploy-wordpress',
    title: 'Deploy WordPress',
    description: 'Deploy a WordPress site on a domain.',
    arguments: [target, domain],
    text: (args) =>
      steps(
        `Deploy WordPress on ${named(args.domain, 'the domain the user names')} using ${named(args.target, 'the chosen target')}.`,
        [
          'Ask for the site title, the admin user name (not admin, administrator, root, wordpress or test) and the admin email.',
          'Check the domain with domains_check; find its Cloudflare credential and zone with cloudflare_list_zones if it is on Cloudflare.',
          'Run wordpress_create. Leave adminPassword out so a strong one is generated.',
          'Tell the user the admin password is in CloudForge under Secrets, "WordPress · domain", and that they should save it.',
        ],
      ),
  },
  {
    name: 'publish-domain-https',
    title: 'Publish a domain with HTTPS',
    description: 'Point a domain at a server, route it through Nginx and give it a certificate.',
    arguments: [target, domain, argument('port', 'The local port of the application')],
    text: (args) =>
      steps(
        `Publish ${named(args.domain, 'the domain')} on ${named(args.target, 'the chosen target')}${args.port ? `, forwarding to port ${args.port}` : ''}.`,
        [
          'Check the domain with domains_check.',
          "Get the server's address from targets_get. If the domain is on Cloudflare, run cloudflare_ensure_dns; otherwise tell the user which record to create.",
          'Run nginx_save_site with the domain and upstreamPort.',
          "Run ssl_issue_certificate with waitForDnsSeconds set to 300: Let's Encrypt with an email, or Origin CA with a Cloudflare credential when the record is proxied.",
          'Check with nginx_inspect and ssl_list_certificates.',
        ],
      ),
  },
  {
    name: 'issue-ssl-certificate',
    title: 'Issue an SSL certificate',
    description: 'Issue a certificate for a domain that already has an Nginx site.',
    arguments: [target, domain],
    text: (args) =>
      steps(
        `Issue a certificate for ${named(args.domain, 'the domain')} on ${named(args.target, 'the chosen target')}.`,
        [
          'Confirm the domain is a managed site with nginx_list_sites; create it with nginx_save_site if not.',
          'Run ssl_verify_dns. If it is not pointing here yet, say so.',
          "Run ssl_issue_certificate. Use Let's Encrypt with an email, or Origin CA for a proxied Cloudflare record. Origin CA switches the whole zone to Full (strict) unless keepCloudflareSslMode is set, so ask first if the zone hosts other sites.",
        ],
      ),
  },
  {
    name: 'review-firewall',
    title: 'Review the firewalls',
    description: 'Check whether a server can be reached, and what is exposed.',
    arguments: [target],
    text: (args) =>
      steps(
        `Review the firewalls of ${named(args.target, 'the chosen target')}. A port is only reachable when both firewalls allow it.`,
        [
          'Read the server firewall with host_firewall_inspect.',
          'Find the instance with providers_list_instances and read its rules with cloud_firewall_get, where the provider supports it. Check them with cloud_firewall_analyze, passing the ports that matter.',
          "Run runtime_connectivity for the verdict on the plan's ports.",
          'Report what is open to the internet that should not be, and what is needed but blocked. Propose changes; make none without asking.',
        ],
      ),
  },
  {
    name: 'runtime-drift-and-apply',
    title: 'Reconcile a server with its plan',
    description: 'See how a server differs from its runtime plan and bring them in line.',
    arguments: [target],
    text: (args) =>
      steps(`Reconcile ${named(args.target, 'the chosen target')} with its runtime plan.`, [
        'Read runtime_get_plan. In legacy mode CloudForge changes nothing; ask the user before runtime_set_mode.',
        'Run runtime_drift and explain the differences. runtime_adopt records ownership of something that already exists, and changes nothing on the server.',
        'Run runtime_preview and show its operations. Stop if it reports blockers.',
        'Run runtime_apply with its token, plus the exact resource name of each destructive operation, only for those the user agreed to.',
      ]),
  },
  {
    name: 'jenkins-pipeline',
    title: 'Set up a Jenkins pipeline',
    description: 'Connect Jenkins, create a pipeline and run it.',
    arguments: [target, argument('repository', 'The Git repository URL')],
    text: (args) =>
      steps(
        `Set up a Jenkins pipeline on ${named(args.target, 'the chosen target')}${args.repository ? ` for ${args.repository}` : ''}.`,
        [
          'Check Jenkins is there with ansible_get_profile_states; install it with the install-service workflow if not.',
          'Find a jenkins credential with credentials_list, and check it with jenkins_test_connection.',
          'Run jenkins_save_pipeline. A private repository needs a github credential. Keep secrets in an environment-file credential, not in environment.',
          'Read jenkins_get_status to see the parameters Jenkins found.',
          'Run jenkins_trigger_build, then follow it with jenkins_get_status. Never pass a WIPE value unless the user asked for that data to be erased.',
        ],
      ),
  },
  {
    name: 'give-ssh-access',
    title: 'Give someone SSH access',
    description: "Create a person's own account on a server.",
    arguments: [target, argument('username', 'Their account name')],
    text: (args) =>
      steps(
        `Give ${named(args.username, 'the person')} SSH access to ${named(args.target, 'the chosen target')}.`,
        [
          "If they have not sent a public key, use host_access_instructions: its keyRequest is the message to send them. Never ask for a private key, and never share CloudForge's own key.",
          'Ask whether they need full administrator rights. Default to no.',
          'Run host_access_grant. The user approves it in the CloudForge window.',
          'Give the user the message from host_access_instructions to send them, and report any warnings from host_access_inspect.',
        ],
      ),
  },
  {
    name: 'diagnose-site-down',
    title: 'Find out why a site is down',
    description: 'Work through DNS, the firewall, Nginx, the application and the certificate.',
    arguments: [target, domain],
    text: (args) =>
      steps(
        `${named(args.domain, 'The site')} on ${named(args.target, 'the chosen target')} is not working. Find out why, without changing anything.`,
        [
          'Does DNS point here? ssl_verify_dns.',
          'Is Nginx healthy, and is there a site for it? nginx_inspect, nginx_list_sites, then nginx_read_logs with kind error.',
          'Is the application running? runtime_inspect, then containers_logs for its container. Note that logs can contain secrets.',
          'Is the certificate valid? ssl_list_certificates.',
          'Can traffic reach it? runtime_connectivity and host_firewall_inspect.',
        ],
        'Report the cause and propose a fix. Make no change until the user agrees.',
      ),
  },
  {
    name: 'backup-project',
    title: 'Back up the project',
    description: 'Write an encrypted backup of the open project.',
    arguments: [argument('folder', 'Where to put the backup')],
    text: (args) =>
      steps('Back up the open project.', [
        `Confirm the destination folder${args.folder ? ` (${args.folder})` : ''} and which project is open with projects_get_session.`,
        'Ask the user for a passphrase of at least 12 characters and the project passkey. Tell them this passes through the conversation, and that the backup cannot be restored without the passphrase.',
        'Run backup_create_project and report the path.',
      ]),
  },
];

export function renderPrompt(name: string, args: Readonly<Record<string, string>>): string {
  const prompt = MCP_PROMPTS.find((item) => item.name === name);
  if (!prompt) throw new McpToolError(`There is no prompt called ${name}.`);
  return prompt.text(args);
}
