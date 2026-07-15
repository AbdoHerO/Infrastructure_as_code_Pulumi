import { useState } from 'react';
import { Eye, KeyRound, Plus, ShieldCheck, ShieldAlert, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@cloudforge/ui';
import { CREDENTIAL_SCHEMAS, type CredentialSummaryDto } from '@cloudforge/core';
import { PageHeader } from '../../components/PageHeader.js';
import { useConfirmation } from '../../components/ConfirmationDialogProvider.js';
import { CredentialDialog } from './CredentialDialog.js';
import { RevealDialog } from './RevealDialog.js';
import { useCredentials, useDeleteCredential, useSecurityStatus } from './useCredentials.js';

/** The Credential Manager: securely store, reveal and delete provider secrets. */
export function SecretsPage(): JSX.Element {
  const [adding, setAdding] = useState(false);
  const [revealing, setRevealing] = useState<CredentialSummaryDto | null>(null);
  const { data: credentials, isLoading } = useCredentials();
  const { data: security } = useSecurityStatus();
  const deleteCredential = useDeleteCredential();
  const confirm = useConfirmation();

  return (
    <>
      <PageHeader
        title="Secrets"
        description="Encrypted credentials for every connected service."
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus className="size-4" /> Add Credential
          </Button>
        }
      />

      <SecurityBanner backedByOsKeychain={security?.backedByOsKeychain ?? true} />

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading credentials…</p>
      ) : !credentials || credentials.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="bg-secondary text-muted-foreground flex size-14 items-center justify-center rounded-2xl">
              <KeyRound className="size-7" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">No credentials yet</p>
              <p className="text-muted-foreground text-sm">
                Add a credential to connect a cloud provider or service.
              </p>
            </div>
            <Button onClick={() => setAdding(true)}>
              <Plus className="size-4" /> Add Credential
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {credentials.map((credential) => (
                <TableRow key={credential.id}>
                  <TableCell className="font-medium">{credential.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{CREDENTIAL_SCHEMAS[credential.kind].label}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(credential.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Reveal"
                        onClick={() => setRevealing(credential)}
                      >
                        <Eye className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Delete"
                        disabled={deleteCredential.isPending}
                        onClick={() => {
                          void confirm({
                            title: 'Delete credential?',
                            description: `Delete “${credential.name}” permanently? Projects and services using this credential will lose access until another credential is linked.`,
                            confirmLabel: 'Delete credential',
                          }).then((confirmed) => {
                            if (!confirmed) return;
                            deleteCredential.mutate(credential.id, {
                              onSuccess: () => toast.success('Credential deleted'),
                              onError: () => toast.error('Failed to delete credential'),
                            });
                          });
                        }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <CredentialDialog open={adding} onOpenChange={setAdding} />
      <RevealDialog credential={revealing} onClose={() => setRevealing(null)} />
    </>
  );
}

function SecurityBanner({ backedByOsKeychain }: { backedByOsKeychain: boolean }): JSX.Element {
  return (
    <Card className="mb-6">
      <CardContent className="flex items-center gap-3 py-3">
        {backedByOsKeychain ? (
          <ShieldCheck className="text-success size-5" />
        ) : (
          <ShieldAlert className="text-warning size-5" />
        )}
        <p className="text-muted-foreground text-sm">
          {backedByOsKeychain
            ? 'Secrets are encrypted using your operating system keychain.'
            : 'OS keychain unavailable — secrets use an encrypted local key (weaker). '}
        </p>
      </CardContent>
    </Card>
  );
}
