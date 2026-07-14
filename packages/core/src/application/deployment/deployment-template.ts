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
    step(
      'Update packages',
      'if command -v apt-get >/dev/null; then sudo apt-get update -y; elif command -v dnf >/dev/null; then sudo dnf -y makecache; else echo "Unsupported package manager" >&2; exit 1; fi',
    ),
    step(
      'Install prerequisites',
      'if command -v apt-get >/dev/null; then sudo apt-get install -y ca-certificates git gnupg ufw fail2ban; else sudo dnf install -y ca-certificates git dnf-utils firewalld; fi',
    ),
    step(
      'Install Docker',
      'if command -v apt-get >/dev/null; then sudo apt-get install -y docker.io docker-compose-v2 || sudo apt-get install -y docker.io docker-compose; else sudo dnf remove -y --noautoremove oci-oke-node-minimal cri-o runc || true; sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo && sudo dnf install -y --allowerasing docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; fi',
    ),
    step('Enable Docker', 'sudo systemctl enable --now docker'),
    step('Grant Docker access', 'sudo usermod -aG docker "$USER"'),
    step(
      'Configure firewall',
      'if command -v ufw >/dev/null; then sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw --force enable; else sudo systemctl enable --now firewalld && sudo firewall-cmd --permanent --add-service=ssh && sudo firewall-cmd --permanent --add-service=http && sudo firewall-cmd --permanent --add-service=https && sudo firewall-cmd --reload; fi',
    ),
  ];
}

const nginx = (): DeploymentStep =>
  step(
    'Install Nginx',
    'if command -v apt-get >/dev/null; then sudo apt-get install -y nginx; else sudo dnf install -y nginx; fi',
  );

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
