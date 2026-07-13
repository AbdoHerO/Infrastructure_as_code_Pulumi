/** Immutable product/branding constants for CloudForge. */
export const APP = {
  name: 'CloudForge',
  subtitle: 'Modern Infrastructure Platform',
  tagline: ['Provision.', 'Configure.', 'Deploy.', 'Manage.'] as const,
  id: 'com.cloudforge.desktop',
  version: '0.1.0',
} as const;

/** Supported UI theme modes. */
export const THEME_MODES = ['light', 'dark', 'system'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
