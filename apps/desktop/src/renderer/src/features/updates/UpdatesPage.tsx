import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { Button, Card, CardContent } from '@cloudforge/ui';
import { invoke } from '../../lib/ipc.js';
import { PageHeader } from '../../components/PageHeader.js';

/** The Updates module: current version and update status. */
export function UpdatesPage(): JSX.Element {
  const updates = useQuery({
    queryKey: ['updates', 'check'],
    queryFn: () => invoke('updates:check', undefined),
  });

  return (
    <>
      <PageHeader
        title="Updates"
        description="Application version and update status."
        actions={
          <Button
            variant="outline"
            onClick={() => void updates.refetch()}
            disabled={updates.isFetching}
          >
            {updates.isFetching ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Check for updates
          </Button>
        }
      />

      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
          <div className="bg-success/10 text-success flex size-14 items-center justify-center rounded-2xl">
            <CheckCircle2 className="size-7" />
          </div>
          <div className="space-y-1">
            <p className="font-medium">
              {updates.data?.upToDate ? 'You are up to date' : 'An update is available'}
            </p>
            <p className="text-muted-foreground text-sm">
              Current version {updates.data?.current ?? '—'}
            </p>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
