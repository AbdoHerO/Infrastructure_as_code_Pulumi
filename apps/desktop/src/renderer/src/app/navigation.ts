import {
  Blocks,
  Boxes,
  Cloud,
  Container,
  FileCode2,
  Info,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  RefreshCw,
  Rocket,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  Workflow,
} from 'lucide-react';

/** A single navigable module in the sidebar. */
export interface NavItem {
  readonly label: string;
  readonly path: string;
  readonly icon: LucideIcon;
}

/** A titled group of navigation items. */
export interface NavGroup {
  readonly title: string;
  readonly items: readonly NavItem[];
}

/**
 * The application's navigation model. Adding a module is a single declarative
 * entry here plus a route in the router — no other wiring required.
 */
export const NAVIGATION: readonly NavGroup[] = [
  {
    title: 'Overview',
    items: [{ label: 'Dashboard', path: '/', icon: LayoutDashboard }],
  },
  {
    title: 'Manage',
    items: [
      { label: 'Projects', path: '/projects', icon: Boxes },
      { label: 'Infrastructure', path: '/infrastructure', icon: Server },
      { label: 'Deployments', path: '/deployments', icon: Rocket },
      { label: 'Containers', path: '/containers', icon: Container },
      { label: 'Ansible', path: '/ansible', icon: Workflow },
    ],
  },
  {
    title: 'Configure',
    items: [
      { label: 'Cloud Providers', path: '/providers', icon: Cloud },
      { label: 'Templates', path: '/templates', icon: FileCode2 },
      { label: 'Secrets', path: '/secrets', icon: ShieldCheck },
      { label: 'SSH Keys', path: '/ssh-keys', icon: KeyRound },
    ],
  },
  {
    title: 'Observe',
    items: [{ label: 'Logs', path: '/logs', icon: ScrollText }],
  },
  {
    title: 'System',
    items: [
      { label: 'Plugin Marketplace', path: '/plugins', icon: Blocks },
      { label: 'Updates', path: '/updates', icon: RefreshCw },
      { label: 'Settings', path: '/settings', icon: Settings },
      { label: 'About', path: '/about', icon: Info },
    ],
  },
];

/** Flattened list of every navigable item (useful for search / command palette). */
export const NAV_ITEMS: readonly NavItem[] = NAVIGATION.flatMap((group) => group.items);
