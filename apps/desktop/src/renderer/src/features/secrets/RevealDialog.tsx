import { useEffect, useState } from 'react';
import { Copy, Eye, EyeOff } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  toast,
} from '@cloudforge/ui';
import { CREDENTIAL_SCHEMAS, type CredentialSummaryDto } from '@cloudforge/core';
import { IpcCallError } from '../../lib/ipc.js';
import { revealCredential } from './useCredentials.js';

interface RevealDialogProps {
  credential: CredentialSummaryDto | null;
  onClose: () => void;
}

/** Fetches and displays a credential's decrypted fields, masked by default. */
export function RevealDialog({ credential, onClose }: RevealDialogProps): JSX.Element {
  const [data, setData] = useState<Record<string, string> | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!credential) return;
    setData(null);
    setVisible(false);
    let active = true;
    revealCredential(credential.id)
      .then((result) => {
        if (active) setData(result);
      })
      .catch((error: unknown) => {
        toast.error(error instanceof IpcCallError ? error.message : 'Failed to reveal credential');
        onClose();
      });
    return () => {
      active = false;
    };
  }, [credential, onClose]);

  const spec = credential ? CREDENTIAL_SCHEMAS[credential.kind] : null;

  return (
    <Dialog open={credential !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0">
        <DialogHeader className="shrink-0 p-6 pb-4">
          <DialogTitle className="flex items-center justify-between gap-4 pr-6">
            <span className="truncate">{credential?.name}</span>
            <Button variant="outline" size="sm" onClick={() => setVisible((v) => !v)}>
              {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              {visible ? 'Hide' : 'Show'}
            </Button>
          </DialogTitle>
          <DialogDescription>{spec?.label} credential</DialogDescription>
        </DialogHeader>

        {data === null ? (
          <p className="text-muted-foreground py-6 text-center text-sm">Decrypting…</p>
        ) : (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-6 pt-0">
            {spec?.fields
              .filter((field) => data[field.key] !== undefined)
              .map((field) => (
                <div key={field.key} className="space-y-1">
                  <p className="text-muted-foreground text-xs font-medium">{field.label}</p>
                  <div className="flex items-start gap-2">
                    <code className="bg-secondary min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md px-2.5 py-1.5 font-mono text-xs">
                      {visible || !field.secret ? data[field.key] : '•'.repeat(12)}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Copy"
                      onClick={() => {
                        void navigator.clipboard.writeText(data[field.key] ?? '');
                        toast.success('Copied to clipboard');
                      }}
                    >
                      <Copy className="size-4" />
                    </Button>
                  </div>
                </div>
              ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
