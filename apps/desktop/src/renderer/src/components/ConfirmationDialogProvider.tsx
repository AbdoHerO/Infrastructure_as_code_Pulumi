import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@cloudforge/ui';

export interface ConfirmationOptions {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel?: string;
  readonly destructive?: boolean;
}

interface PendingConfirmation extends ConfirmationOptions {
  readonly id: number;
}

type ConfirmAction = (options: ConfirmationOptions) => Promise<boolean>;

const ConfirmationContext = createContext<ConfirmAction | null>(null);

/** Application-wide, non-blocking replacement for unsupported browser confirm dialogs. */
export function ConfirmationDialogProvider({ children }: { children: ReactNode }): JSX.Element {
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);
  const nextId = useRef(0);

  const confirm = useCallback<ConfirmAction>(
    (options) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        nextId.current += 1;
        setPending({ ...options, id: nextId.current });
      }),
    [],
  );
  const close = useCallback((confirmed: boolean): void => {
    const resolve = resolver.current;
    resolver.current = null;
    setPending(null);
    resolve?.(confirmed);
  }, []);
  useEffect(
    () => () => {
      resolver.current?.(false);
      resolver.current = null;
    },
    [],
  );
  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmationContext.Provider value={value}>
      {children}
      <Dialog open={pending !== null} onOpenChange={(open) => !open && close(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pending?.title}</DialogTitle>
            <DialogDescription className="whitespace-pre-line">
              {pending?.description}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              variant={pending?.destructive === false ? 'default' : 'destructive'}
              onClick={() => close(true)}
            >
              {pending?.confirmLabel ?? 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmationContext.Provider>
  );
}

export function useConfirmation(): ConfirmAction {
  const confirm = useContext(ConfirmationContext);
  if (!confirm) throw new Error('useConfirmation must be used inside ConfirmationDialogProvider');
  return confirm;
}
