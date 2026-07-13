import type { Config } from 'tailwindcss';
import { cloudforgePreset } from '@cloudforge/ui/tailwind-preset';

/** Desktop renderer Tailwind config — extends the shared design-system preset. */
export default {
  presets: [cloudforgePreset],
  content: [
    './src/renderer/index.html',
    './src/renderer/src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
} satisfies Config;
