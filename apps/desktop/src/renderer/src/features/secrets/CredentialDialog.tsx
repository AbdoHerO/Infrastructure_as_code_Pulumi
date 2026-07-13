import { useState } from 'react';
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
import { CREDENTIAL_KINDS, CREDENTIAL_SCHEMAS, type CredentialKind } from '@cloudforge/core';
import { IpcCallError } from '../../lib/ipc.js';
import { useCreateCredential } from './useCredentials.js';

interface CredentialDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Dialog to add a credential; fields are generated from the kind's schema. */
export function CredentialDialog({ open, onOpenChange }: CredentialDialogProps): JSX.Element {
  const [kind, setKind] = useState<CredentialKind>('oracle');
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const create = useCreateCredential();

  const spec = CREDENTIAL_SCHEMAS[kind];

  const reset = (): void => {
    setKind('oracle');
    setName('');
    setValues({});
  };

  const submit = async (): Promise<void> => {
    try {
      await create.mutateAsync({ kind, name, data: values });
      toast.success('Credential saved securely');
      reset();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof IpcCallError ? error.message : 'Failed to save credential');
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
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add credential</DialogTitle>
          <DialogDescription>
            Secrets are encrypted with your OS keychain and never stored in plaintext.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Provider</Label>
            <Select
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
              <Label>
                {fieldSpec.label}
                {!fieldSpec.required ? (
                  <span className="text-muted-foreground ml-1 text-xs">(optional)</span>
                ) : null}
              </Label>
              {fieldSpec.multiline ? (
                <Textarea
                  className="min-h-[120px] font-mono text-xs"
                  placeholder={fieldSpec.placeholder}
                  value={values[fieldSpec.key] ?? ''}
                  onChange={(event) =>
                    setValues((prev) => ({ ...prev, [fieldSpec.key]: event.target.value }))
                  }
                />
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

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={create.isPending} onClick={() => void submit()}>
            {create.isPending ? 'Saving…' : 'Save credential'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
