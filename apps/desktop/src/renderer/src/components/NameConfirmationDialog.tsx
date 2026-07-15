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
  readonly pending?: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}

/** In-app typed confirmation for destructive actions in the desktop renderer. */
export function NameConfirmationDialog({
  open,
  title,
  description,
  expectedName,
  confirmLabel,
  pending = false,
  onOpenChange,
  onConfirm,
}: NameConfirmationDialogProps): JSX.Element {
  const [typedName, setTypedName] = useState('');
  const inputId = useId();

  useEffect(() => {
    if (open) setTypedName('');
  }, [open, expectedName]);

  const confirmed = typedName === expectedName;
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
              if (event.key === 'Enter' && confirmed && !pending) onConfirm();
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!confirmed || pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
