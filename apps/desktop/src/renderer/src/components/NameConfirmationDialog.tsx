import { useEffect, useId, useState } from 'react';
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
} from '@cloudforge/ui';

interface NameConfirmationDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly expectedName: string;
  readonly confirmLabel: string;
  readonly requirePasskey?: boolean;
  readonly pending?: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (confirmation?: {
    readonly typedName: string;
    readonly passkey: string;
  }) => void;
}

/** In-app typed confirmation for destructive actions in the desktop renderer. */
export function NameConfirmationDialog({
  open,
  title,
  description,
  expectedName,
  confirmLabel,
  requirePasskey = false,
  pending = false,
  onOpenChange,
  onConfirm,
}: NameConfirmationDialogProps): JSX.Element {
  const [typedName, setTypedName] = useState('');
  const [passkey, setPasskey] = useState('');
  const inputId = useId();
  const passkeyId = useId();

  useEffect(() => {
    if (open) {
      setTypedName('');
      setPasskey('');
    }
  }, [open, expectedName]);

  const confirmed = typedName === expectedName && (!requirePasskey || passkey.length > 0);
  const confirm = (): void => onConfirm({ typedName, passkey });
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !pending && onOpenChange(nextOpen)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={inputId}>
            Type <span className="font-mono font-semibold">{expectedName}</span> to confirm
          </Label>
          <Input
            id={inputId}
            autoFocus
            autoComplete="off"
            value={typedName}
            disabled={pending}
            onChange={(event) => setTypedName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && confirmed && !pending) confirm();
            }}
          />
          {requirePasskey ? (
            <>
              <Label htmlFor={passkeyId}>Project passkey</Label>
              <Input
                id={passkeyId}
                type="password"
                autoComplete="current-password"
                value={passkey}
                disabled={pending}
                onChange={(event) => setPasskey(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && confirmed && !pending) confirm();
                }}
              />
            </>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!confirmed || pending} onClick={confirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
