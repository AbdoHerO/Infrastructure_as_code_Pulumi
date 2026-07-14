import {
  CheckCircle2,
  CircleStop,
  Cpu,
  Globe,
  HardDrive,
  Image,
  Loader2,
  Play,
  PlugZap,
  RotateCw,
  Server,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Badge, Button, Card, CardContent, Separator } from '@cloudforge/ui';
import { type CredentialSummaryDto, PROVIDER_LABELS, type ProviderKind } from '@cloudforge/core';
import {
  useLoadInstances,
  useLoadAvailabilityDomains,
  useLoadImages,
  useLoadRegions,
  useLoadResources,
  useLoadShapes,
  useTerminateInstance,
  useTestConnection,
  useInstanceAction,
} from './useProviders.js';

/** A single provider connection: test it and discover regions/shapes. */
export function ProviderCard({ credential }: { credential: CredentialSummaryDto }): JSX.Element {
  const test = useTestConnection();
  const regions = useLoadRegions();
  const shapes = useLoadShapes();
  const instances = useLoadInstances();
  const availabilityDomains = useLoadAvailabilityDomains();
  const images = useLoadImages();
  const terminate = useTerminateInstance();
  const resources = useLoadResources();
  const instanceAction = useInstanceAction();

  const result = test.data;
  const isAws = credential.kind === 'aws';

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
              {credential.kind === 'aws' ? (
                <Badge variant="outline" className="mt-1">
                  Read-only discovery
                </Badge>
              ) : null}
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
              {isAws ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={availabilityDomains.isPending}
                    onClick={() => availabilityDomains.mutate(credential.id)}
                  >
                    <Server className="size-4" />
                    {availabilityDomains.data
                      ? `${availabilityDomains.data.length} availability zones`
                      : 'Load availability zones'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={images.isPending}
                    onClick={() => images.mutate(credential.id)}
                  >
                    {images.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Image className="size-4" />
                    )}
                    {images.data ? `${images.data.length} images` : 'Load images'}
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={resources.isPending}
                  onClick={() => resources.mutate(credential.id)}
                >
                  {resources.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <HardDrive className="size-4" />
                  )}
                  {resources.data ? `${resources.data.length} resources` : 'Load cloud resources'}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={shapes.isPending}
                onClick={() => shapes.mutate(credential.id)}
              >
                <Cpu className="size-4" />
                {shapes.data ? `${shapes.data.length} shapes` : 'Load shapes'}
              </Button>
              {!isAws ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={instances.isPending}
                  onClick={() => instances.mutate(credential.id)}
                >
                  {instances.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Server className="size-4" />
                  )}
                  {instances.data ? `${instances.data.length} instances` : 'Load instances'}
                </Button>
              ) : null}
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
            {isAws && availabilityDomains.data ? (
              <DiscoveryList
                title="Availability zones"
                items={availabilityDomains.data.map((zone) => ({ id: zone.id, text: zone.name }))}
              />
            ) : null}
            {isAws && shapes.data ? (
              <DiscoveryList
                title="Instance types"
                items={shapes.data.slice(0, 24).map((shape) => ({
                  id: shape.id,
                  text: `${shape.name}${shape.ocpus ? ` · ${shape.ocpus} vCPU` : ''}${shape.memoryGb ? ` · ${shape.memoryGb} GB` : ''}`,
                }))}
                total={shapes.data.length}
              />
            ) : null}
            {isAws && images.data ? (
              <DiscoveryList
                title="Recent Amazon Linux and Ubuntu images"
                items={images.data.slice(0, 20).map((image) => ({
                  id: image.id,
                  text: `${image.name} · ${image.architecture}`,
                }))}
                total={images.data.length}
              />
            ) : null}
            {isAws && (availabilityDomains.isError || shapes.isError || images.isError) ? (
              <p className="text-destructive text-xs">
                {availabilityDomains.error?.message ??
                  shapes.error?.message ??
                  images.error?.message}
              </p>
            ) : null}
            {instances.isError ? (
              <p className="text-destructive text-xs">{instances.error.message}</p>
            ) : null}
            {terminate.isError ? (
              <p className="text-destructive text-xs">{terminate.error.message}</p>
            ) : null}
            {instances.data ? (
              <div className="space-y-2">
                <p className="text-muted-foreground text-xs">
                  Account instances include servers created outside CloudForge. Termination is
                  permanent and deletes the boot volume.
                </p>
                {instances.data.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No active instances.</p>
                ) : (
                  instances.data.map((instance) => (
                    <div
                      key={instance.id}
                      className="bg-secondary/40 flex items-center justify-between gap-3 rounded-lg p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{instance.name}</p>
                        <p className="text-muted-foreground truncate text-xs">
                          {instance.state} · {instance.shape} · {instance.region}
                        </p>
                      </div>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={terminate.isPending}
                        onClick={() => {
                          const typed = window.prompt(
                            `Permanently terminate "${instance.name}" and delete its boot volume? Type the instance name to confirm.`,
                          );
                          if (typed !== instance.name) return;
                          terminate.mutate(
                            { credentialId: credential.id, instanceId: instance.id },
                            { onSuccess: () => instances.mutate(credential.id) },
                          );
                        }}
                      >
                        {terminate.isPending ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Trash2 className="size-4" />
                        )}
                        Terminate
                      </Button>
                      <div className="flex gap-1">
                        {instance.state === 'STOPPED' ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={instanceAction.isPending}
                            onClick={() =>
                              instanceAction.mutate(
                                {
                                  credentialId: credential.id,
                                  instanceId: instance.id,
                                  action: 'start',
                                },
                                { onSuccess: () => instances.mutate(credential.id) },
                              )
                            }
                          >
                            <Play className="size-3.5" /> Start
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={instanceAction.isPending}
                            onClick={() =>
                              instanceAction.mutate(
                                {
                                  credentialId: credential.id,
                                  instanceId: instance.id,
                                  action: 'stop',
                                },
                                { onSuccess: () => instances.mutate(credential.id) },
                              )
                            }
                          >
                            <CircleStop className="size-3.5" /> Stop
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={instanceAction.isPending || instance.state !== 'RUNNING'}
                          onClick={() =>
                            instanceAction.mutate(
                              {
                                credentialId: credential.id,
                                instanceId: instance.id,
                                action: 'reboot',
                              },
                              { onSuccess: () => instances.mutate(credential.id) },
                            )
                          }
                        >
                          <RotateCw className="size-3.5" /> Reboot
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : null}
            {resources.data ? (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Compartment resources</p>
                {resources.data.map((resource) => (
                  <div
                    key={resource.id}
                    className="bg-secondary/40 flex items-center gap-2 rounded-md px-3 py-2 text-xs"
                  >
                    <Badge variant="secondary">{resource.type}</Badge>
                    <span className="min-w-0 flex-1 truncate">{resource.name}</span>
                    <span className="text-muted-foreground">
                      {resource.details ?? resource.state}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function DiscoveryList({
  title,
  items,
  total,
}: {
  title: string;
  items: readonly { id: string; text: string }[];
  total?: number;
}): JSX.Element {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">
        {title}
        {total !== undefined && total > items.length
          ? ` · showing ${items.length} of ${total}`
          : ''}
      </p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {items.map((item) => (
          <div key={item.id} className="bg-secondary/40 truncate rounded-md px-3 py-2 text-xs">
            {item.text}
          </div>
        ))}
      </div>
    </div>
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
