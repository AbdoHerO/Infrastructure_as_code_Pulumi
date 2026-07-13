import { CheckCircle2, Cpu, Globe, Loader2, PlugZap, XCircle } from 'lucide-react';
import { Badge, Button, Card, CardContent, Separator } from '@cloudforge/ui';
import { type CredentialSummaryDto, PROVIDER_LABELS, type ProviderKind } from '@cloudforge/core';
import { useLoadRegions, useLoadShapes, useTestConnection } from './useProviders.js';

/** A single provider connection: test it and discover regions/shapes. */
export function ProviderCard({ credential }: { credential: CredentialSummaryDto }): JSX.Element {
  const test = useTestConnection();
  const regions = useLoadRegions();
  const shapes = useLoadShapes();

  const result = test.data;

  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="bg-secondary text-muted-foreground flex size-10 items-center justify-center rounded-lg">
              <PlugZap className="size-5" />
            </div>
            <div>
              <p className="font-medium">{credential.name}</p>
              <p className="text-muted-foreground text-xs">
                {PROVIDER_LABELS[credential.kind as ProviderKind]}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={test.isPending}
            onClick={() => test.mutate(credential.id)}
          >
            {test.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <PlugZap className="size-4" />
            )}
            Test connection
          </Button>
        </div>

        {test.isError ? (
          <StatusLine ok={false} text="Connection failed. Check the credential fields." />
        ) : result ? (
          <StatusLine
            ok={result.connected}
            text={result.message}
            detail={result.account ? `Home region: ${result.account.homeRegion ?? '—'}` : undefined}
          />
        ) : null}

        {result?.connected ? (
          <>
            <Separator />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={regions.isPending}
                onClick={() => regions.mutate(credential.id)}
              >
                <Globe className="size-4" />
                {regions.data ? `${regions.data.length} regions` : 'Load regions'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={shapes.isPending}
                onClick={() => shapes.mutate(credential.id)}
              >
                <Cpu className="size-4" />
                {shapes.data ? `${shapes.data.length} shapes` : 'Load shapes'}
              </Button>
            </div>
            {regions.data && regions.data.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {regions.data.slice(0, 12).map((region) => (
                  <Badge key={region.id} variant="secondary">
                    {region.name}
                    {region.isHome ? ' ★' : ''}
                  </Badge>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StatusLine({
  ok,
  text,
  detail,
}: {
  ok: boolean;
  text: string;
  detail?: string | undefined;
}): JSX.Element {
  return (
    <div className="flex items-start gap-2 text-sm">
      {ok ? (
        <CheckCircle2 className="text-success mt-0.5 size-4" />
      ) : (
        <XCircle className="text-destructive mt-0.5 size-4" />
      )}
      <div>
        <p className={ok ? 'text-foreground' : 'text-destructive'}>{text}</p>
        {detail ? <p className="text-muted-foreground text-xs">{detail}</p> : null}
      </div>
    </div>
  );
}
