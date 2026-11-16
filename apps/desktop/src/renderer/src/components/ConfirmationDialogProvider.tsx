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
  Input,
  Label,
} from '@cloudforge/ui';

export interface ConfirmationOptions {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel?: string;
  readonly destructive?: boolean;
  /** Text the person must type before the confirm button works, e.g. a project name. */
  readonly typeToConfirm?: string;
}

interface PendingConfirmation extends ConfirmationOptions {
  readonly id: number;
}

type ConfirmAction = (options: ConfirmationOptions) => Promise<boolean>;

const ConfirmationContext = createContext<ConfirmAction | null>(null);

/** Application-wide, non-blocking replacement for unsupported browser confirm dialogs. */
export function ConfirmationDialogProvider({ children }: { children: ReactNode }): JSX.Element {
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const [typed, setTyped] = useState('');
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);
  const nextId = useRef(0);

  const confirm = useCallback<ConfirmAction>(
    (options) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        nextId.current += 1;
        setTyped('');
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
  const expected = pending?.typeToConfirm?.trim();
  const typedMatches = !expected || typed.trim() === expected;

  return (
    <ConfirmationContext.Provider value={value}>
      {children}
      <Dialog open={pending !== null} onOpenChange={(open) => !open && close(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pending?.title}</DialogTitle>
            <DialogDescription className="max-h-[50vh] overflow-y-auto whitespace-pre-line">
              {pending?.description}
            </DialogDescription>
          </DialogHeader>
          {expected ? (
            <div className="space-y-2">
              <Label htmlFor={`confirm-${String(pending?.id)}`}>
                Type <span className="font-mono font-semibold">{expected}</span> to confirm
              </Label>
              <Input
                id={`confirm-${String(pending?.id)}`}
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && typedMatches) close(true);
                }}
              />
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              variant={pending?.destructive === false ? 'default' : 'destructive'}
              disabled={!typedMatches}
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
