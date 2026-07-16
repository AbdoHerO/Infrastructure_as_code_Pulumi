import readme from '@docs/README.md?raw';
import gettingStarted from '@docs/GETTING-STARTED.md?raw';
import firstInstance from '@docs/FIRST-INSTANCE.md?raw';
import configuration from '@docs/CONFIGURATION.md?raw';
import overview from '@docs/OVERVIEW.md?raw';
import modules from '@docs/MODULES.md?raw';
import ansible from '@docs/ANSIBLE.md?raw';
import nginx from '@docs/NGINX-MANAGER.md?raw';
import firewall from '@docs/FIREWALL-MANAGER.md?raw';
import ssl from '@docs/SSL-DOMAINS.md?raw';
import infraUpdates from '@docs/INFRASTRUCTURE-UPDATES.md?raw';
import security from '@docs/SECURITY.md?raw';
import architecture from '@docs/ARCHITECTURE.md?raw';
import dataModel from '@docs/DATA-MODEL.md?raw';
import ipc from '@docs/IPC.md?raw';
import packages from '@docs/PACKAGES.md?raw';
import development from '@docs/DEVELOPMENT.md?raw';
import packaging from '@docs/PACKAGING.md?raw';
import releases from '@docs/MOVING-AND-RELEASING.md?raw';
import roadmap from '@docs/ROADMAP.md?raw';
import privacy from '@docs/PRIVACY.md?raw';
import license from '@docs/LICENSE.md?raw';
import aws from '@docs/AWS.md?raw';
import cloudflare from '@docs/CLOUDFLARE.md?raw';
import jenkins from '@docs/JENKINS-PIPELINES.md?raw';

export type DocumentationCategory = 'Start here' | 'Operate' | 'Reference' | 'Develop';

export interface DocumentationArticle {
  readonly id: string;
  readonly file: string;
  readonly title: string;
  readonly summary: string;
  readonly category: DocumentationCategory;
  readonly content: string;
}

export const DOCUMENTATION: readonly DocumentationArticle[] = [
  article(
    'welcome',
    'README.md',
    'Documentation home',
    'Choose the right guide and learning path.',
    'Start here',
    readme,
  ),
  article(
    'getting-started',
    'GETTING-STARTED.md',
    'Getting started',
    'Install, run, test, and troubleshoot CloudForge.',
    'Start here',
    gettingStarted,
  ),
  article(
    'configuration',
    'CONFIGURATION.md',
    'Credentials & configuration',
    'Configure cloud, SSH, Cloudflare, Jenkins, GitHub, settings, and secrets.',
    'Start here',
    configuration,
  ),
  article(
    'first-instance',
    'FIRST-INSTANCE.md',
    'Your first OCI instance',
    'Provision a complete server, connect over SSH, and remove it safely.',
    'Start here',
    firstInstance,
  ),
  article(
    'aws',
    'AWS.md',
    'Amazon Web Services',
    'Configure AWS credentials, provision an EC2 stack, and manage its lifecycle.',
    'Start here',
    aws,
  ),
  article(
    'overview',
    'OVERVIEW.md',
    'Product overview',
    'Core concepts, terminology, and end-to-end workflows.',
    'Start here',
    overview,
  ),
  article(
    'modules',
    'MODULES.md',
    'Application modules',
    'Understand every page and its data flow.',
    'Operate',
    modules,
  ),
  article(
    'ansible',
    'ANSIBLE.md',
    'Ansible & VPS targets',
    'Prepare a VPS and run generic configuration profiles.',
    'Operate',
    ansible,
  ),
  article(
    'nginx-manager',
    'NGINX-MANAGER.md',
    'Nginx Manager',
    'Sites, validation, live status, logs, backups, and rollback.',
    'Operate',
    nginx,
  ),
  article(
    'firewall-manager',
    'FIREWALL-MANAGER.md',
    'Firewall Manager',
    'Synchronize and safely update live provider firewall rules.',
    'Operate',
    firewall,
  ),
  article(
    'ssl-domains',
    'SSL-DOMAINS.md',
    'SSL & Domains',
    'Direct/proxied DNS verification, certificates, renewal, and Nginx integration.',
    'Operate',
    ssl,
  ),
  article(
    'cloudflare',
    'CLOUDFLARE.md',
    'Cloudflare',
    'Credentials, zones, DNS records, domain routing, SSL/TLS, cache, and edge services.',
    'Operate',
    cloudflare,
  ),
  article(
    'jenkins-pipelines',
    'JENKINS-PIPELINES.md',
    'Jenkins Pipelines',
    'Create, parameterize, run, diagnose, and domain-route per-VPS application pipelines.',
    'Operate',
    jenkins,
  ),
  article(
    'infrastructure-updates',
    'INFRASTRUCTURE-UPDATES.md',
    'Infrastructure update safety',
    'Understand Pulumi updates, replacements, preview, and approval.',
    'Operate',
    infraUpdates,
  ),
  article(
    'security',
    'SECURITY.md',
    'Security',
    'Encryption, keychain storage, hardening, and threat boundaries.',
    'Reference',
    security,
  ),
  article(
    'privacy',
    'PRIVACY.md',
    'Privacy',
    'Local data, network activity, and diagnostic boundaries.',
    'Reference',
    privacy,
  ),
  article(
    'license',
    'LICENSE.md',
    'License',
    'CloudForge and third-party licensing status.',
    'Reference',
    license,
  ),
  article(
    'architecture',
    'ARCHITECTURE.md',
    'Architecture',
    'Clean Architecture, DDD, Electron processes, and dependency rules.',
    'Reference',
    architecture,
  ),
  article(
    'data-model',
    'DATA-MODEL.md',
    'Data model',
    'SQLite and Prisma entities, relations, and conventions.',
    'Reference',
    dataModel,
  ),
  article(
    'ipc',
    'IPC.md',
    'Typed IPC reference',
    'Channels, events, Result envelopes, and extension patterns.',
    'Reference',
    ipc,
  ),
  article(
    'packages',
    'PACKAGES.md',
    'Workspace packages',
    'Package ownership, public exports, and important files.',
    'Develop',
    packages,
  ),
  article(
    'development',
    'DEVELOPMENT.md',
    'Development guide',
    'Set up the repository and add features consistently.',
    'Develop',
    development,
  ),
  article(
    'packaging',
    'PACKAGING.md',
    'Packaging',
    'Build and verify distributable desktop applications.',
    'Develop',
    packaging,
  ),
  article(
    'moving-and-releasing',
    'MOVING-AND-RELEASING.md',
    'Move state & release',
    'Transfer local state and publish tag-driven Windows releases.',
    'Develop',
    releases,
  ),
  article(
    'roadmap',
    'ROADMAP.md',
    'Completion report',
    'Implemented phases, evidence, and release requirements.',
    'Develop',
    roadmap,
  ),
];

function article(
  id: string,
  file: string,
  title: string,
  summary: string,
  category: DocumentationCategory,
  content: string,
): DocumentationArticle {
  return { id, file, title, summary, category, content };
}

export function findDocumentationArticle(value: string | null): DocumentationArticle {
  if (!value) return DOCUMENTATION[1]!;
  const file = value.split('/').at(-1)?.split('#')[0]?.toLowerCase();
  return (
    DOCUMENTATION.find((item) => item.id === value || item.file.toLowerCase() === file) ??
    DOCUMENTATION[1]!
  );
}

export function searchDocumentation(query: string): readonly DocumentationArticle[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return DOCUMENTATION;
  return DOCUMENTATION.filter((article) => {
    const haystack = `${article.title}\n${article.summary}\n${article.content}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function articleIdForHref(href: string | undefined): string | null {
  if (!href || /^(?:https?:|mailto:|#)/i.test(href)) return null;
  const filename = href.replaceAll('\\', '/').split('/').at(-1)?.split('#')[0];
  return (
    DOCUMENTATION.find((article) => article.file.toLowerCase() === filename?.toLowerCase())?.id ??
    null
  );
}
