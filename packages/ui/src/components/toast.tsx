import { Toaster as SonnerToaster, toast } from 'sonner';

export { toast };

/**
 * App-wide toast host. Rendered once near the root; styled to match the design
 * system tokens in both light and dark themes.
 */
export function Toaster(): JSX.Element {
  return (
    <SonnerToaster
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            'group rounded-lg border border-border bg-popover text-popover-foreground shadow-lg',
          description: 'text-muted-foreground',
          actionButton: 'bg-primary text-primary-foreground',
          cancelButton: 'bg-secondary text-secondary-foreground',
          error: 'border-destructive/40',
          success: 'border-success/40',
        },
      }}
    />
  );
}
