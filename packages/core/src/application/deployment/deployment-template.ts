/**
 * Deployment templates describe a reproducible sequence of steps run over SSH on
 * a freshly-provisioned host: install Docker, configure services and launch an
 * application. Templates are provider-agnostic; they emit ordered shell steps.
 */

/** A single, named step in a deployment (one idempotent shell command). */
export interface DeploymentStep {
  readonly name: string;
  readonly command: string;
}

/** Runtime inputs a template may use to parameterise its steps. */
export interface DeploymentContext {
  /** Optional container image to run (for app templates). */
  readonly appImage?: string;
  /** Optional domain for reverse-proxy / TLS steps. */
  readonly domain?: string;
}

/** A deployment template and the steps it produces. */
export interface DeploymentTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly build: (context: DeploymentContext) => DeploymentStep[];
}

const step = (name: string, command: string): DeploymentStep => ({ name, command });

/** Base hardening + Docker installation shared by most templates. */
function dockerBase(): DeploymentStep[] {
  return [
    step('Update packages', 'sudo apt-get update -y && sudo apt-get upgrade -y'),
    step(
      'Install prerequisites',
      'sudo apt-get install -y ca-certificates curl gnupg ufw fail2ban',
    ),
    step('Install Docker', 'curl -fsSL https://get.docker.com | sudo sh'),
    step('Enable Docker', 'sudo systemctl enable --now docker'),
    step(
      'Configure firewall',
      'sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw --force enable',
    ),
  ];
}

const nginx = (): DeploymentStep => step('Install Nginx', 'sudo apt-get install -y nginx');

/** The built-in deployment templates. */
export const DEPLOYMENT_TEMPLATES: readonly DeploymentTemplate[] = [
  {
    id: 'docker-host',
    name: 'Docker Host',
    description: 'A hardened host with Docker and Docker Compose.',
    build: () => dockerBase(),
  },
  {
    id: 'nginx',
    name: 'Nginx Web Server',
    description: 'Nginx installed and running behind UFW.',
    build: () => [
      ...dockerBase(),
      nginx(),
      step('Start Nginx', 'sudo systemctl enable --now nginx'),
    ],
  },
  {
    id: 'node',
    name: 'Node API',
    description: 'Run a Node.js container on the Docker host.',
    build: (ctx) => [
      ...dockerBase(),
      step(
        'Run application',
        `sudo docker run -d --restart unless-stopped -p 80:3000 ${ctx.appImage ?? 'node:20-alpine'}`,
      ),
    ],
  },
  {
    id: 'nextjs',
    name: 'Next.js App',
    description: 'Run a Next.js container on the Docker host.',
    build: (ctx) => [
      ...dockerBase(),
      step(
        'Run application',
        `sudo docker run -d --restart unless-stopped -p 80:3000 ${ctx.appImage ?? 'node:20-alpine'}`,
      ),
    ],
  },
  {
    id: 'wordpress',
    name: 'WordPress',
    description: 'WordPress + MySQL via Docker Compose.',
    build: () => [
      ...dockerBase(),
      step(
        'Deploy WordPress',
        'sudo docker run -d --restart unless-stopped -p 80:80 --name wordpress wordpress:latest',
      ),
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama AI Server',
    description: 'Run an Ollama model server on the Docker host.',
    build: () => [
      ...dockerBase(),
      step(
        'Run Ollama',
        'sudo docker run -d --restart unless-stopped -p 11434:11434 --name ollama ollama/ollama:latest',
      ),
    ],
  },
];

/** Look up a template by id. */
export function findTemplate(id: string): DeploymentTemplate | undefined {
  return DEPLOYMENT_TEMPLATES.find((template) => template.id === id);
}

/** Summary (no `build` fn) suitable for transport to the renderer. */
export interface DeploymentTemplateSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/** List templates as transport-safe summaries. */
export function listTemplateSummaries(): DeploymentTemplateSummary[] {
  return DEPLOYMENT_TEMPLATES.map(({ id, name, description }) => ({ id, name, description }));
}
