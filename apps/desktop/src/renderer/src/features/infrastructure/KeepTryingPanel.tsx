import { CheckCircle2, Loader2, Repeat, Square, XCircle } from 'lucide-react';
import {
  type KeepTryingState,
  isKeepTryingActive,
  KEEP_TRYING_INTERVAL_MS,
} from '@cloudforge/core';
import { Button, Card, CardContent } from '@cloudforge/ui';

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function attemptCount(attempts: number): string {
  return `${String(attempts)} ${attempts === 1 ? 'attempt' : 'attempts'}`;
}

/** Offered right after an Apply fails because the provider has no room. */
export function NoCapacityNotice({
  disabled,
  onKeepTrying,
}: {
  readonly disabled: boolean;
  readonly onKeepTrying: () => void;
}): JSX.Element {
  const minutes = String(KEEP_TRYING_INTERVAL_MS / 60_000);
  return (
    <Card className="mb-4 border-amber-500/40">
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
        <div>
          <p className="font-medium">The cloud provider has no free capacity for this server</p>
          <p className="text-muted-foreground">
            Your plan is fine, and only the server is missing. CloudForge can try again every{' '}
            {minutes} minutes and create it as soon as there is room.
          </p>
        </div>
        <Button disabled={disabled} onClick={onKeepTrying}>
          <Repeat className="size-4" /> Keep trying
        </Button>
      </CardContent>
    </Card>
  );
}

/** The current or last run. The page stays usable, because the run happens in the background. */
export function KeepTryingPanel({
  state,
  stopping,
  onStop,
  onDismiss,
}: {
  readonly state: KeepTryingState;
  readonly stopping: boolean;
  readonly onStop: () => void;
  readonly onDismiss: () => void;
}): JSX.Element {
  if (isKeepTryingActive(state)) {
    const trying = state.status === 'trying';
    return (
      <Card className="border-primary/40 mb-4">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
          <div className="flex min-w-0 items-start gap-3">
            <Loader2 className="text-primary mt-0.5 size-4 shrink-0 animate-spin" />
            <div className="min-w-0">
              <p className="font-medium">Trying to create your server</p>
              <p className="text-muted-foreground break-words">
                {trying ? 'Trying now' : state.message}
                {state.attempts > 0 ? ` · ${attemptCount(state.attempts)} so far` : ''}
                {state.nextAttemptAt ? ` · next try at ${clockTime(state.nextAttemptAt)}` : ''}
              </p>
              <p className="text-muted-foreground">
                Leave CloudForge open with this project selected. Your computer will not go to sleep
                while this runs. You can use other pages in the meantime.
              </p>
            </div>
          </div>
          <Button variant="outline" disabled={stopping} onClick={onStop}>
            {stopping ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-4" />}
            {stopping ? 'Stopping…' : 'Stop'}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const created = state.status === 'created';
  const failed = state.status === 'failed';
  const tries = attemptCount(state.attempts);
  return (
    <Card
      className={`mb-4 ${created ? 'border-emerald-500/40' : failed ? 'border-destructive/40' : ''}`}
    >
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
        <div className="flex min-w-0 items-start gap-3">
          {created ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
          ) : (
            <XCircle
              className={`mt-0.5 size-4 shrink-0 ${failed ? 'text-destructive' : 'text-muted-foreground'}`}
            />
          )}
          <div className="min-w-0">
            <p className="font-medium">
              {created ? `Server created after ${tries}` : `Stopped trying after ${tries}`}
            </p>
            {created ? (
              <p className="text-muted-foreground">Its address is under Stack outputs.</p>
            ) : (
              <>
                <p className="text-muted-foreground break-words">{state.message}</p>
                <p className="text-muted-foreground">
                  To start again, click Preview, then Keep trying.
                </p>
              </>
            )}
          </div>
        </div>
        <Button variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </CardContent>
    </Card>
  );
}
