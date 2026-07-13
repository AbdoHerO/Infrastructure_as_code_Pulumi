import { createHashRouter } from 'react-router-dom';
import { Container, KeyRound } from 'lucide-react';
import { AppShell } from './layout/AppShell.js';
import { PlaceholderPage } from '../components/PlaceholderPage.js';
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
      { path: 'projects', element: <ProjectsPage /> },
      { path: 'infrastructure', element: <InfrastructurePage /> },
      { path: 'deployments', element: <DeploymentsPage /> },
      {
        path: 'containers',
        element: (
          <PlaceholderPage
            title="Containers"
            description="Manage Docker containers and Compose stacks."
            icon={Container}
            phase="Phase 8"
          />
        ),
      },
      { path: 'providers', element: <ProvidersPage /> },
      { path: 'templates', element: <TemplatesPage /> },
      { path: 'secrets', element: <SecretsPage /> },
      {
        path: 'ssh-keys',
        element: (
          <PlaceholderPage
            title="SSH Keys"
            description="Manage SSH key pairs used for deployments."
            icon={KeyRound}
            phase="Phase 4"
          />
        ),
      },
      { path: 'logs', element: <LogsPage /> },
      { path: 'plugins', element: <MarketplacePage /> },
      { path: 'updates', element: <UpdatesPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'about', element: <AboutPage /> },
    ],
  },
]);
