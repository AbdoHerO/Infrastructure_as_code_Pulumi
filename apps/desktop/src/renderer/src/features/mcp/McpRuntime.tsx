import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  toast,
} from '@cloudforge/ui';
import type { McpApprovalRequest } from '@shared/mcp/types.js';
import { useThemeStore } from '../../app/theme/theme-store.js';
import { invoke, subscribe } from '../../lib/ipc.js';
import { queryRootsForChannels } from '../../lib/mcp-sync.js';

const REFRESH_DELAY_MS = 300;

/**
 * What the window does on behalf of connected MCP clients: asks you about critical
 * actions, reloads data they changed, and shows the page they ask for. Mounted
 * above the project gate, because a client can act while every project is locked.
 */
export function McpRuntime(): JSX.Element {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<readonly McpApprovalRequest[]>([]);
  const changed = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = pending[0];

  useEffect(() => {
    void invoke('mcp:pendingApprovals', undefined)
      .then(setPending)
      .catch(() => undefined);
    return subscribe('mcp:approvalsChanged', (event) => setPending(event.pending));
  }, []);

  useEffect(
    () =>
      subscribe('app:dataChanged', (event) => {
        for (const root of queryRootsForChannels(event.channels)) changed.current.add(root);
        // A client often changes several things in a row; reload once.
        if (timer.current) return;
        timer.current = setTimeout(() => {
          const roots = changed.current;
          changed.current = new Set();
          timer.current = null;
          void queryClient.invalidateQueries({
            predicate: (query) => roots.has(String(query.queryKey[0])),
          });
        }, REFRESH_DELAY_MS);
      }),
    [queryClient],
  );

  useEffect(
    () =>
      subscribe('ui:command', (command) => {
        if (command.kind === 'theme') useThemeStore.getState().setMode(command.theme);
        else window.location.hash = `#${command.path}`;
      }),
    [],
  );

  const decide = (approved: boolean): void => {
    if (!request) return;
    void invoke('mcp:resolveApproval', { id: request.id, approved }).catch((error: Error) =>
      toast.error(error.message),
    );
  };

  return (
    // Dismissing the dialog is a refusal, so nothing runs without a deliberate click.
    <Dialog open={request !== undefined} onOpenChange={(open) => !open && decide(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{request?.client} wants to run a critical action</DialogTitle>
          <DialogDescription>
            {request?.title}. It stops waiting at{' '}
            {request ? new Date(request.expiresAt).toLocaleTimeString() : ''} and is then refused.
          </DialogDescription>
        </DialogHeader>
        <pre className="bg-muted/40 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border p-3 font-mono text-xs">
          {request?.summary}
        </pre>
        {pending.length > 1 ? (
          <p className="text-muted-foreground text-xs">
            {pending.length - 1} more waiting after this one.
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => decide(false)}>
            Refuse
          </Button>
          <Button variant="destructive" onClick={() => decide(true)}>
            Allow this once
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
