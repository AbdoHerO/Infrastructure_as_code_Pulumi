import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileUp } from 'lucide-react';
import {
  Button,
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
import {
  CREDENTIAL_KINDS,
  CREDENTIAL_SCHEMAS,
  type CredentialKind,
  type CredentialSummaryDto,
} from '@cloudforge/core';
import { IpcCallError } from '../../lib/ipc.js';
import {
  importEnvironmentFile,
  revealCredential,
  useCreateCredential,
  useUpdateCredential,
} from './useCredentials.js';

interface CredentialDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  credential?: CredentialSummaryDto | null;
}

/** Dialog to add or replace a credential; fields are generated from the kind's schema. */
export function CredentialDialog({
  open,
  onOpenChange,
  credential = null,
}: CredentialDialogProps): JSX.Element {
  const [kind, setKind] = useState<CredentialKind>('oracle');
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const create = useCreateCredential();
  const update = useUpdateCredential();
  const [importingFile, setImportingFile] = useState(false);
  const editing = Boolean(credential);

  useEffect(() => {
    if (!open || !credential) return;
    setKind(credential.kind);
    setName(credential.name);
    void revealCredential(credential.id)
      .then(setValues)
      .catch(() => toast.error('Failed to load the encrypted credential'));
  }, [credential, open]);

  const spec = CREDENTIAL_SCHEMAS[kind];

  const reset = (): void => {
    setKind('oracle');
    setName('');
    setValues({});
  };

  const submit = async (): Promise<void> => {
    try {
      if (credential) {
        await update.mutateAsync({ id: credential.id, kind, name, data: values });
      } else {
        await create.mutateAsync({ kind, name, data: values });
      }
      toast.success(editing ? 'Credential updated securely' : 'Credential saved securely');
      reset();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof IpcCallError ? error.message : 'Failed to save credential');
    }
  };

  const uploadEnvironmentFile = async (): Promise<void> => {
    setImportingFile(true);
    try {
      const imported = await importEnvironmentFile();
      if (!imported) return;
      setValues((current) => ({
        ...current,
        filename: imported.filename,
        content: imported.content,
      }));
      toast.success(`Loaded ${imported.filename}`);
    } catch (error) {
      toast.error(
        error instanceof IpcCallError ? error.message : 'Failed to load environment file',
      );
    } finally {
      setImportingFile(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0">
        <DialogHeader className="shrink-0 p-6 pb-4">
          <DialogTitle>{editing ? 'Edit credential' : 'Add credential'}</DialogTitle>
          <DialogDescription>
            Secrets are encrypted with your OS keychain and never stored in plaintext.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6">
          <div className="space-y-1.5">
            <Label>Provider</Label>
            <Select
              disabled={editing}
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as CredentialKind);
                setValues({});
              }}
            >
              {CREDENTIAL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {CREDENTIAL_SCHEMAS[k].label}
                </option>
              ))}
            </Select>
          </div>

          {kind === 'aws' ? (
            <div className="border-primary/30 bg-primary/5 rounded-lg border p-3 text-sm">
              <p className="font-medium">AWS infrastructure provisioning is available.</p>
              <p className="text-muted-foreground mt-1 text-xs leading-5">
                Use a narrowly scoped IAM access key. Preview the exact VPC, EC2, security-group and
                EBS changes before Apply because AWS resources may incur charges.
              </p>
              <Button asChild variant="link" size="sm" className="mt-1 h-auto p-0">
                <Link to="/documentation?doc=aws" onClick={() => onOpenChange(false)}>
                  How to create the key and IAM policy
                </Link>
              </Button>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              placeholder={`${spec.label} account`}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          {spec.fields.map((fieldSpec) => (
            <div key={fieldSpec.key} className="space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <Label>
                  {fieldSpec.label}
                  {!fieldSpec.required ? (
                    <span className="text-muted-foreground ml-1 text-xs">(optional)</span>
                  ) : null}
                </Label>
                {kind === 'environment-file' && fieldSpec.key === 'content' ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={importingFile}
                    onClick={() => void uploadEnvironmentFile()}
                  >
                    <FileUp className="mr-2 h-4 w-4" />
                    {importingFile ? 'Loading…' : 'Upload file'}
                  </Button>
                ) : null}
              </div>
              {fieldSpec.multiline ? (
                <>
                  {kind === 'environment-file' && fieldSpec.key === 'content' ? (
                    <p className="text-muted-foreground text-xs">
                      Paste the content below or upload an existing environment file. You can review
                      and edit imported values before saving.
                    </p>
                  ) : null}
                  <Textarea
                    className="min-h-[120px] font-mono text-xs"
                    placeholder={fieldSpec.placeholder}
                    value={values[fieldSpec.key] ?? ''}
                    onChange={(event) =>
                      setValues((prev) => ({ ...prev, [fieldSpec.key]: event.target.value }))
                    }
                  />
                </>
              ) : (
                <Input
                  type={fieldSpec.secret ? 'password' : 'text'}
                  placeholder={fieldSpec.placeholder}
                  value={values[fieldSpec.key] ?? ''}
                  onChange={(event) =>
                    setValues((prev) => ({ ...prev, [fieldSpec.key]: event.target.value }))
                  }
                />
              )}
            </div>
          ))}
        </div>

        <DialogFooter className="border-border shrink-0 border-t p-6 pt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={create.isPending || update.isPending} onClick={() => void submit()}>
            {create.isPending || update.isPending
              ? 'Saving…'
              : editing
                ? 'Update credential'
                : 'Save credential'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
