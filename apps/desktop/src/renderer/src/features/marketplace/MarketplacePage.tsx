import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Blocks, Cloud, FileCode2, Palette, Puzzle, Server, Trash2 } from 'lucide-react';
import { Badge, Button, Card, CardContent, Switch, toast } from '@cloudforge/ui';
import type { PluginListItem } from '@cloudforge/core';
import { invoke } from '../../lib/ipc.js';
import { PageHeader } from '../../components/PageHeader.js';

const KIND_ICON = {
  provider: Cloud,
  template: FileCode2,
  widget: Blocks,
  theme: Palette,
  'ansible-role': Server,
} as const;

/** The Plugin Marketplace: discover, install and enable extensions. */
export function MarketplacePage(): JSX.Element {
  const queryClient = useQueryClient();
  const plugins = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => invoke('plugins:list', undefined),
  });

  const refresh = (): Promise<void> =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['plugins', 'list'] }),
      queryClient.invalidateQueries({ queryKey: ['plugins', 'active'] }),
    ]).then(() => undefined);

  const install = useMutation({
    mutationFn: (id: string) => invoke('plugins:install', { id }),
    onSuccess: refresh,
  });
  const setEnabled = useMutation({
    mutationFn: (args: { id: string; enabled: boolean }) => invoke('plugins:setEnabled', args),
    onSuccess: refresh,
  });
  const uninstall = useMutation({
    mutationFn: (id: string) => invoke('plugins:uninstall', { id }),
    onSuccess: refresh,
  });

  return (
    <>
      <PageHeader
        title="Built-in Extensions"
        description="Trusted declarative capabilities bundled with CloudForge; extensions never execute downloaded code."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {plugins.data?.map((plugin) => (
          <PluginCard
            key={plugin.id}
            plugin={plugin}
            installing={install.isPending}
            onInstall={() =>
              install.mutate(plugin.id, {
                onSuccess: () => toast.success(`Installed ${plugin.name}`),
              })
            }
            onToggle={(enabled) => setEnabled.mutate({ id: plugin.id, enabled })}
            onUninstall={() => uninstall.mutate(plugin.id)}
          />
        ))}
      </div>
    </>
  );
}

function PluginCard({
  plugin,
  installing,
  onInstall,
  onToggle,
  onUninstall,
}: {
  plugin: PluginListItem;
  installing: boolean;
  onInstall: () => void;
  onToggle: (enabled: boolean) => void;
  onUninstall: () => void;
}): JSX.Element {
  const Icon = KIND_ICON[plugin.kind] ?? Puzzle;
  return (
    <Card>
      <CardContent className="flex h-full flex-col gap-3 py-5">
        <div className="flex items-center gap-3">
          <div className="bg-secondary text-muted-foreground flex size-10 items-center justify-center rounded-lg">
            <Icon className="size-5" />
          </div>
          <div>
            <p className="font-medium">{plugin.name}</p>
            <Badge variant="secondary">{plugin.kind}</Badge>
          </div>
        </div>
        <p className="text-muted-foreground flex-1 text-sm">{plugin.description}</p>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-xs">
            v{plugin.version} · {plugin.author}
          </span>
          {plugin.installed ? (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">Enabled</span>
              <Switch checked={plugin.enabled} onCheckedChange={onToggle} />
              <Button size="icon" variant="ghost" title="Uninstall" onClick={onUninstall}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" disabled={installing} onClick={onInstall}>
              Install
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
