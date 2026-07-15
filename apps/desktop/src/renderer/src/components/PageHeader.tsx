import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Button, toast } from '@cloudforge/ui';
import { invoke } from '../lib/ipc.js';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
}

/** Consistent page title block used at the top of every module. */
export function PageHeader({ title, description, actions }: PageHeaderProps): JSX.Element {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      const synchronized = await invoke('app:synchronize', undefined);
      await queryClient.invalidateQueries();
      if (synchronized.warnings.length > 0) {
        toast.warning(`Refreshed with ${synchronized.warnings.length} synchronization warning(s)`);
      } else {
        toast.success('Application data synchronized');
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not synchronize application data',
      );
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <div className="mb-8 flex items-start justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" disabled={refreshing} onClick={() => void refresh()}>
          <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
        {actions}
      </div>
    </div>
  );
}
