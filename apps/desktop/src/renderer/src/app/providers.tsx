import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { TooltipProvider } from '@cloudforge/ui';
import { useSettings } from '../features/settings/useSettings.js';
import { invoke } from '../lib/ipc.js';

/** Application-wide context providers (data fetching, tooltips, and more). */
export function AppProviders({ children }: { children: ReactNode }): JSX.Element {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <SettingsEffects />
      <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

function SettingsEffects(): null {
  const { data } = useSettings();
  const plugins = useQuery({
    queryKey: ['plugins', 'active'],
    queryFn: () => invoke('plugins:active', undefined),
  });
  useEffect(() => {
    document.documentElement.toggleAttribute(
      'data-reduced-motion',
      data?.appearance.reducedMotion ?? false,
    );
  }, [data?.appearance.reducedMotion]);
  useEffect(() => {
    const nord = plugins.data?.some((plugin) => plugin.contribution === 'theme:nord') ?? false;
    document.documentElement.toggleAttribute('data-theme-nord', nord);
  }, [plugins.data]);
  return null;
}
