import { createHashRouter } from 'react-router-dom';
import {
  Blocks,
  Container,
  FileCode2,
  KeyRound,
  RefreshCw,
  Rocket,
  ScrollText,
  Server,
} from 'lucide-react';
import { AppShell } from './layout/AppShell.js';
import { PlaceholderPage } from '../components/PlaceholderPage.js';
import { DashboardPage } from '../features/dashboard/DashboardPage.js';
import { ProjectsPage } from '../features/projects/ProjectsPage.js';
import { ProvidersPage } from '../features/providers/ProvidersPage.js';
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
      {
        path: 'infrastructure',
        element: (
          <PlaceholderPage
            title="Infrastructure"
            description="Virtual machines, networks, firewalls, volumes and more."
            icon={Server}
            phase="Phase 7"
          />
        ),
      },
      {
        path: 'deployments',
        element: (
          <PlaceholderPage
            title="Deployments"
            description="Provision, configure and deploy applications end to end."
            icon={Rocket}
            phase="Phase 8"
          />
        ),
      },
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
      {
        path: 'templates',
        element: (
          <PlaceholderPage
            title="Templates"
            description="Reusable infrastructure and deployment templates."
            icon={FileCode2}
            phase="Phase 10"
          />
        ),
      },
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
      {
        path: 'logs',
        element: (
          <PlaceholderPage
            title="Logs"
            description="Beautiful live logs with search, filter and export."
            icon={ScrollText}
            phase="Phase 9"
          />
        ),
      },
      {
        path: 'plugins',
        element: (
          <PlaceholderPage
            title="Plugin Marketplace"
            description="Discover and install providers, templates and widgets."
            icon={Blocks}
            phase="Phase 10"
          />
        ),
      },
      {
        path: 'updates',
        element: (
          <PlaceholderPage
            title="Updates"
            description="Application updates and release channels."
            icon={RefreshCw}
            phase="Phase 10"
          />
        ),
      },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'about', element: <AboutPage /> },
    ],
  },
]);
