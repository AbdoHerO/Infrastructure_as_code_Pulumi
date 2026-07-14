import { createHashRouter } from 'react-router-dom';
import { AppShell } from './layout/AppShell.js';
import { DashboardPage } from '../features/dashboard/DashboardPage.js';
import { ProjectsPage } from '../features/projects/ProjectsPage.js';
import { InfrastructurePage } from '../features/infrastructure/InfrastructurePage.js';
import { DeploymentsPage } from '../features/deployments/DeploymentsPage.js';
import { LogsPage } from '../features/logs/LogsPage.js';
import { ProvidersPage } from '../features/providers/ProvidersPage.js';
import { TemplatesPage } from '../features/templates/TemplatesPage.js';
import { MarketplacePage } from '../features/marketplace/MarketplacePage.js';
import { UpdatesPage } from '../features/updates/UpdatesPage.js';
import { SecretsPage } from '../features/secrets/SecretsPage.js';
import { SettingsPage } from '../features/settings/SettingsPage.js';
import { AboutPage } from '../features/about/AboutPage.js';
import { SshKeysPage } from '../features/ssh-keys/SshKeysPage.js';
import { ContainersPage } from '../features/containers/ContainersPage.js';
import { AnsiblePage } from '../features/ansible/AnsiblePage.js';
import { NginxPage } from '../features/nginx/NginxPage.js';
import { FirewallPage } from '../features/firewall/FirewallPage.js';
import { SslPage } from '../features/ssl/SslPage.js';
import { DocumentationPage } from '../features/documentation/DocumentationPage.js';

/**
 * Central route table. Modules not yet implemented render a {@link PlaceholderPage}
 * that names the phase in which they land — the shell, routing and design system
 * are already in place for them.
 */
export const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'documentation', element: <DocumentationPage /> },
      { path: 'projects', element: <ProjectsPage /> },
      { path: 'infrastructure', element: <InfrastructurePage /> },
      { path: 'deployments', element: <DeploymentsPage /> },
      { path: 'containers', element: <ContainersPage /> },
      { path: 'ansible', element: <AnsiblePage /> },
      { path: 'nginx', element: <NginxPage /> },
      { path: 'firewall', element: <FirewallPage /> },
      { path: 'ssl', element: <SslPage /> },
      { path: 'providers', element: <ProvidersPage /> },
      { path: 'templates', element: <TemplatesPage /> },
      { path: 'secrets', element: <SecretsPage /> },
      { path: 'ssh-keys', element: <SshKeysPage /> },
      { path: 'logs', element: <LogsPage /> },
      { path: 'plugins', element: <MarketplacePage /> },
      { path: 'updates', element: <UpdatesPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'about', element: <AboutPage /> },
    ],
  },
]);
