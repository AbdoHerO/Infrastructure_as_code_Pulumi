import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, Download, Loader2, RefreshCw, RotateCw, XCircle } from 'lucide-react';
import { Button, Card, CardContent } from '@cloudforge/ui';
import type { UpdateState } from '@shared/ipc/contract.js';
import { invoke, subscribe } from '../../lib/ipc.js';
import { PageHeader } from '../../components/PageHeader.js';

const initial: UpdateState = { status: 'idle', current: '—', latest: null };

export function UpdatesPage(): JSX.Element {
  const [state, setState] = useState<UpdateState>(initial);
  const check = useMutation({
    mutationFn: () => invoke('updates:check', undefined),
    onSuccess: setState,
  });
  const download = useMutation({
    mutationFn: () => invoke('updates:download', undefined),
    onSuccess: setState,
  });
  const install = useMutation({ mutationFn: () => invoke('updates:install', undefined) });

  useEffect(() => {
    void invoke('updates:state', undefined).then(setState);
    return subscribe('updates:state', setState);
  }, []);

  const busy = state.status === 'checking' || state.status === 'downloading';
  const icon =
    state.status === 'error' ? (
      <XCircle className="size-7" />
    ) : busy ? (
      <Loader2 className="size-7 animate-spin" />
    ) : (
      <CheckCircle2 className="size-7" />
    );

  return (
    <>
      <PageHeader
        title="Updates"
        description="Signed application update status and installation."
        actions={
          <Button
            variant="outline"
            onClick={() => check.mutate()}
            disabled={busy || check.isPending}
          >
            {state.status === 'checking' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Check for updates
          </Button>
        }
      />
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
          <div
            className={`flex size-14 items-center justify-center rounded-2xl ${state.status === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-success/10 text-success'}`}
          >
            {icon}
          </div>
          <div className="space-y-1">
            <p className="font-medium">{statusLabel(state)}</p>
            <p className="text-muted-foreground text-sm">
              Current {state.current}
              {state.latest ? ` · Latest ${state.latest}` : ''}
            </p>
            {state.message ? (
              <p className="text-muted-foreground text-xs">{state.message}</p>
            ) : null}
          </div>
          {state.status === 'downloading' ? (
            <div className="w-full max-w-md space-y-1">
              <div className="bg-secondary h-2 overflow-hidden rounded-full">
                <div
                  className="bg-primary h-full transition-[width]"
                  style={{ width: `${state.progress ?? 0}%` }}
                />
              </div>
              <p className="text-muted-foreground text-xs">{state.progress ?? 0}% downloaded</p>
            </div>
          ) : null}
          {state.status === 'available' ? (
            <Button onClick={() => download.mutate()} disabled={download.isPending}>
              <Download className="size-4" /> Download update
            </Button>
          ) : null}
          {state.status === 'downloaded' ? (
            <Button onClick={() => install.mutate()} disabled={install.isPending}>
              <RotateCw className="size-4" /> Restart and install
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}

function statusLabel(state: UpdateState): string {
  switch (state.status) {
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return 'An update is available';
    case 'downloading':
      return 'Downloading signed update…';
    case 'downloaded':
      return 'Update ready to install';
    case 'error':
      return 'Update failed';
    case 'not-available':
      return 'You are up to date';
    default:
      return 'Ready to check for updates';
  }
}
