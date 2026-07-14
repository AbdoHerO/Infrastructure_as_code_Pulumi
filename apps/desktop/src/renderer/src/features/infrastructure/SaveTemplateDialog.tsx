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
  Textarea,
  toast,
} from '@cloudforge/ui';
import type { InfrastructurePlan } from '@cloudforge/core';
import { IpcCallError } from '../../lib/ipc.js';
import { useSaveTemplate } from './useInfrastructure.js';

interface SaveTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan: InfrastructurePlan;
}

/** Dialog to save the current infrastructure plan as a reusable custom template. */
export function SaveTemplateDialog({
  open,
  onOpenChange,
  plan,
}: SaveTemplateDialogProps): JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const save = useSaveTemplate();

  const submit = (): void => {
    if (name.trim().length === 0) {
      toast.error('Give the template a name');
      return;
    }
    save.mutate(
      {
        name: name.trim(),
        plan,
        ...(description.trim() ? { description: description.trim() } : {}),
      },
      {
        onSuccess: () => {
          toast.success(`Saved template "${name.trim()}"`);
          setName('');
          setDescription('');
          onOpenChange(false);
        },
        onError: (error) =>
          toast.error(error instanceof IpcCallError ? error.message : 'Failed to save template'),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save as template</DialogTitle>
          <DialogDescription>
            Store the current plan ({plan.resources.length} resource
            {plan.resources.length === 1 ? '' : 's'}) as a reusable template you can apply to any
            project.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              placeholder="My web stack"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label>Description (optional)</Label>
            <Textarea
              placeholder="What does this template provision?"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save template'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
