import { useState } from 'react';
import { Copy, Download, KeyRound, Loader2, Plus, Trash2, Upload } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  Textarea,
  toast,
} from '@cloudforge/ui';
import type { SshKeyAlgorithm, SshKeySummary } from '@cloudforge/core';
import { PageHeader } from '../../components/PageHeader.js';
import {
  revealSshPrivateKey,
  useDeleteSshKey,
  useGenerateSshKey,
  useImportSshKey,
  useSshKeys,
} from './useSshKeys.js';

export function SshKeysPage(): JSX.Element {
  const keys = useSshKeys();
  const remove = useDeleteSshKey();
  const [dialog, setDialog] = useState<'generate' | 'import' | null>(null);

  return (
    <>
      <PageHeader
        title="SSH Keys"
        description="Generate, import and manage keys used for verified SSH deployments."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setDialog('import')}>
              <Upload className="size-4" /> Import
            </Button>
            <Button onClick={() => setDialog('generate')}>
              <Plus className="size-4" /> Generate key
            </Button>
          </div>
        }
      />

      {keys.isLoading ? (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading SSH keys…
        </div>
      ) : keys.data?.length ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {keys.data.map((key) => (
            <SshKeyCard
              key={key.id}
              sshKey={key}
              deleting={remove.isPending}
              onDelete={() => {
                const typed = window.prompt(
                  `Delete SSH key "${key.name}"? Type its name to confirm.`,
                );
                if (typed === key.name) remove.mutate(key.id);
              }}
            />
          ))}
        </div>
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <KeyRound className="text-muted-foreground size-8" />
            <p className="font-medium">No SSH keys yet</p>
            <p className="text-muted-foreground text-sm">
              Generate a key or import an existing OpenSSH or PEM private key.
            </p>
          </CardContent>
        </Card>
      )}

      <KeyDialog mode={dialog} onClose={() => setDialog(null)} />
    </>
  );
}

function SshKeyCard({
  sshKey,
  deleting,
  onDelete,
}: {
  sshKey: SshKeySummary;
  deleting: boolean;
  onDelete: () => void;
}): JSX.Element {
  const copy = async (value: string, label: string): Promise<void> => {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  };
  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-medium">{sshKey.name}</p>
            <p className="text-muted-foreground mt-1 break-all text-xs">{sshKey.fingerprint}</p>
          </div>
          <Badge variant="secondary">{sshKey.algorithm}</Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copy(sshKey.publicKey, 'Public key')}
          >
            <Copy className="size-4" /> Copy public key
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (
                !window.confirm(
                  'Reveal and copy the private key to the clipboard? Clear the clipboard after use.',
                )
              )
                return;
              void revealSshPrivateKey(sshKey.id).then((value) => copy(value, 'Private key'));
            }}
          >
            <Download className="size-4" /> Reveal private key
          </Button>
          <Button variant="destructive" size="sm" disabled={deleting} onClick={onDelete}>
            <Trash2 className="size-4" /> Delete
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function KeyDialog({
  mode,
  onClose,
}: {
  mode: 'generate' | 'import' | null;
  onClose: () => void;
}): JSX.Element {
  const generate = useGenerateSshKey();
  const importKey = useImportSshKey();
  const [name, setName] = useState('');
  const [algorithm, setAlgorithm] = useState<SshKeyAlgorithm>('ed25519');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const pending = generate.isPending || importKey.isPending;

  const submit = (): void => {
    const options = {
      onSuccess: () => {
        toast.success(mode === 'generate' ? 'SSH key generated' : 'SSH key imported');
        setName('');
        setPrivateKey('');
        setPassphrase('');
        onClose();
      },
      onError: (error: Error) => toast.error(error.message),
    };
    if (mode === 'generate') {
      generate.mutate({ name, algorithm, ...(passphrase ? { passphrase } : {}) }, options);
    } else {
      importKey.mutate({ name, privateKey, ...(passphrase ? { passphrase } : {}) }, options);
    }
  };

  return (
    <Dialog open={mode !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === 'generate' ? 'Generate SSH key' : 'Import SSH key'}</DialogTitle>
          <DialogDescription>
            Private keys are encrypted by CloudForge before being saved.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Name">
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          {mode === 'generate' ? (
            <Field label="Algorithm">
              <Select
                value={algorithm}
                onChange={(event) => setAlgorithm(event.target.value as SshKeyAlgorithm)}
              >
                <option value="ed25519">Ed25519 (recommended)</option>
                <option value="rsa">RSA 3072</option>
              </Select>
            </Field>
          ) : (
            <Field label="Private key (OpenSSH or PEM)">
              <Textarea
                className="min-h-40 font-mono text-xs"
                value={privateKey}
                onChange={(event) => setPrivateKey(event.target.value)}
              />
            </Field>
          )}
          <Field label="Passphrase (optional)">
            <Input
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || (mode === 'import' && !privateKey.trim()) || pending}
            onClick={submit}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {mode === 'generate' ? 'Generate' : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
