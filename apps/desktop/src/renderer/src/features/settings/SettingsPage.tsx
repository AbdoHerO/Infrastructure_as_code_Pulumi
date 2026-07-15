import { useEffect, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Download, Loader2, RefreshCw, RotateCw } from 'lucide-react';
import {
  Card,
  CardContent,
  Button,
  Input,
  Select,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@cloudforge/ui';
import { THEME_MODES } from '@cloudforge/shared';
import type { UpdateState } from '@shared/ipc/contract.js';
import { PageHeader } from '../../components/PageHeader.js';
import { useThemeStore } from '../../app/theme/theme-store.js';
import { useCredentials, useSecurityStatus } from '../secrets/useCredentials.js';
import { useSettings, useUpdateSettings } from './useSettings.js';
import { invoke, subscribe } from '../../lib/ipc.js';
import { toast } from '@cloudforge/ui';

/** The Settings module with grouped, tabbed sections. */
export function SettingsPage(): JSX.Element {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  const { data: security } = useSecurityStatus();
  const { data: credentials } = useCredentials();
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const backupReady = backupPassphrase.length >= 12;
  const [updateState, setUpdateState] = useState<UpdateState>({
    status: 'idle',
    current: '—',
    latest: null,
  });
  const checkUpdate = useMutation({
    mutationFn: () => invoke('updates:check', undefined),
    onSuccess: setUpdateState,
    onError: (error: Error) => toast.error(error.message),
  });
  const downloadUpdate = useMutation({
    mutationFn: () => invoke('updates:download', undefined),
    onSuccess: setUpdateState,
    onError: (error: Error) => toast.error(error.message),
  });
  const installUpdate = useMutation({
    mutationFn: () => invoke('updates:install', undefined),
    onError: (error: Error) => toast.error(error.message),
  });

  useEffect(() => {
    void invoke('updates:state', undefined).then(setUpdateState);
    return subscribe('updates:state', setUpdateState);
  }, []);

  const updaterBusy = updateState.status === 'checking' || updateState.status === 'downloading';

  return (
    <>
      <PageHeader title="Settings" description="Configure CloudForge to your workflow." />

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          <TabsTrigger value="deployment">Deployment</TabsTrigger>
          <TabsTrigger value="updates">Updates</TabsTrigger>
          <TabsTrigger value="ssl">SSL</TabsTrigger>
          <TabsTrigger value="cloudflare">Cloudflare</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
        </TabsList>

        <TabsContent value="general">
          <Card>
            <CardContent className="divide-border/60 divide-y py-2">
              <Row title="Log retention" description="How many days to keep deployment logs.">
                <Input
                  type="number"
                  min={1}
                  className="w-24"
                  defaultValue={settings?.logs.retentionDays ?? 30}
                  onBlur={(event) =>
                    update.mutate({ logs: { retentionDays: Number(event.target.value) || 30 } })
                  }
                />
              </Row>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="appearance">
          <Card>
            <CardContent className="divide-border/60 divide-y py-2">
              <Row title="Theme" description="Light, dark, or follow your system.">
                <Select
                  className="w-40"
                  value={mode}
                  onChange={(event) => setMode(event.target.value as (typeof THEME_MODES)[number])}
                >
                  {THEME_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              </Row>
              <Row title="Reduced motion" description="Minimise animations and transitions.">
                <Switch
                  checked={settings?.appearance.reducedMotion ?? false}
                  onCheckedChange={(reducedMotion) =>
                    update.mutate({ appearance: { reducedMotion } })
                  }
                />
              </Row>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="deployment">
          <Card>
            <CardContent className="divide-border/60 divide-y py-2">
              <Row
                title="Confirm destructive actions"
                description="Require confirmation before destroying infrastructure."
              >
                <Switch
                  checked={settings?.deployment.confirmDestructive ?? true}
                  onCheckedChange={(confirmDestructive) =>
                    update.mutate({ deployment: { confirmDestructive } })
                  }
                />
              </Row>
              <Row title="Default region" description="Pre-selected region for new projects.">
                <Input
                  className="w-48"
                  placeholder="eu-frankfurt-1"
                  defaultValue={settings?.deployment.defaultRegion ?? ''}
                  onBlur={(event) =>
                    update.mutate({ deployment: { defaultRegion: event.target.value.trim() } })
                  }
                />
              </Row>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="updates">
          <Card>
            <CardContent className="divide-border/60 divide-y py-2">
              <Row
                title="Check automatically"
                description="Check GitHub Releases when packaged CloudForge starts."
              >
                <Switch
                  checked={settings?.updates.checkOnStartup ?? true}
                  onCheckedChange={(checkOnStartup) =>
                    update.mutate({ updates: { checkOnStartup } })
                  }
                />
              </Row>
              <Row
                title="Download automatically"
                description="Download an available update in the background. Installation waits for restart."
              >
                <Switch
                  checked={settings?.updates.autoDownload ?? false}
                  onCheckedChange={(autoDownload) => update.mutate({ updates: { autoDownload } })}
                />
              </Row>
              <Row
                title={updateStatusLabel(updateState)}
                description={`Current ${updateState.current}${updateState.latest ? ` · Latest ${updateState.latest}` : ''}${updateState.message ? ` · ${updateState.message}` : ''}`}
              >
                {updateState.status === 'available' ? (
                  <Button
                    onClick={() => downloadUpdate.mutate()}
                    disabled={downloadUpdate.isPending}
                  >
                    <Download className="size-4" /> Download update
                  </Button>
                ) : updateState.status === 'downloaded' ? (
                  <Button onClick={() => installUpdate.mutate()} disabled={installUpdate.isPending}>
                    <RotateCw className="size-4" /> Restart and install
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => checkUpdate.mutate()}
                    disabled={updaterBusy || checkUpdate.isPending}
                  >
                    {updateState.status === 'checking' ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RefreshCw className="size-4" />
                    )}
                    Check now
                  </Button>
                )}
              </Row>
              {updateState.status === 'downloading' ? (
                <div className="space-y-2 py-4">
                  <div className="bg-secondary h-2 overflow-hidden rounded-full">
                    <div
                      className="bg-primary h-full transition-[width]"
                      style={{ width: `${updateState.progress ?? 0}%` }}
                    />
                  </div>
                  <p className="text-muted-foreground text-right text-xs">
                    {updateState.progress ?? 0}% downloaded
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ssl">
          <Card>
            <CardContent className="divide-border/60 divide-y py-2">
              <Row
                title="Automatic renewal"
                description="Check managed certificates and renew them before expiry."
              >
                <Switch
                  checked={settings?.ssl.autoRenew ?? true}
                  onCheckedChange={(autoRenew) => update.mutate({ ssl: { autoRenew } })}
                />
              </Row>
              <Row
                title="Renew before"
                description="Number of remaining days that triggers renewal (1–90)."
              >
                <Input
                  className="w-24"
                  type="number"
                  min={1}
                  max={90}
                  defaultValue={settings?.ssl.renewBeforeDays ?? 30}
                  onBlur={(event) =>
                    update.mutate({ ssl: { renewBeforeDays: Number(event.target.value) || 30 } })
                  }
                />
              </Row>
              <Row
                title="Check interval"
                description="Hours between background certificate checks (1–168)."
              >
                <Input
                  className="w-24"
                  type="number"
                  min={1}
                  max={168}
                  defaultValue={settings?.ssl.checkIntervalHours ?? 24}
                  onBlur={(event) =>
                    update.mutate({ ssl: { checkIntervalHours: Number(event.target.value) || 24 } })
                  }
                />
              </Row>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="cloudflare">
          <Card>
            <CardContent className="divide-border/60 divide-y py-2">
              <Row
                title="Default credential"
                description="Cloudflare credential selected by automatic workflows."
              >
                <Select
                  className="w-56"
                  value={settings?.cloudflare.defaultCredentialId ?? ''}
                  onChange={(event) =>
                    update.mutate({ cloudflare: { defaultCredentialId: event.target.value } })
                  }
                >
                  <option value="">None</option>
                  {credentials
                    ?.filter((item) => item.kind === 'cloudflare')
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </Select>
              </Row>
              <Row
                title="Default zone"
                description="Zone ID used by automatic DNS and SSL workflows."
              >
                <Input
                  className="w-64"
                  defaultValue={settings?.cloudflare.defaultZoneId ?? ''}
                  onBlur={(event) =>
                    update.mutate({ cloudflare: { defaultZoneId: event.target.value.trim() } })
                  }
                />
              </Row>
              <Row
                title="Default TTL"
                description="1 means Cloudflare Automatic; otherwise 60–86400 seconds."
              >
                <Input
                  className="w-28"
                  type="number"
                  defaultValue={settings?.cloudflare.defaultTtl ?? 1}
                  onBlur={(event) =>
                    update.mutate({ cloudflare: { defaultTtl: Number(event.target.value) || 1 } })
                  }
                />
              </Row>
              <Row
                title="Proxy new records"
                description="Enable the Cloudflare proxy by default for eligible records."
              >
                <Switch
                  checked={settings?.cloudflare.defaultProxy ?? true}
                  onCheckedChange={(defaultProxy) =>
                    update.mutate({ cloudflare: { defaultProxy } })
                  }
                />
              </Row>
              <Row
                title="Automatic synchronization"
                description="Refresh Cloudflare changes in the background."
              >
                <Switch
                  checked={settings?.cloudflare.autoSync ?? true}
                  onCheckedChange={(autoSync) => update.mutate({ cloudflare: { autoSync } })}
                />
              </Row>
              <Row
                title="Auto refresh interval"
                description="Minutes between background synchronization checks."
              >
                <Input
                  className="w-28"
                  type="number"
                  min={1}
                  max={1440}
                  defaultValue={settings?.cloudflare.autoRefreshMinutes ?? 15}
                  onBlur={(event) =>
                    update.mutate({
                      cloudflare: { autoRefreshMinutes: Number(event.target.value) || 15 },
                    })
                  }
                />
              </Row>
              <Row
                title="Wait for propagation"
                description="Verify public DNS before starting certificate issuance."
              >
                <Switch
                  checked={settings?.cloudflare.waitForPropagation ?? true}
                  onCheckedChange={(waitForPropagation) =>
                    update.mutate({ cloudflare: { waitForPropagation } })
                  }
                />
              </Row>
              <Row
                title="Propagation timeout"
                description="Maximum seconds to wait for the expected DNS answer."
              >
                <Input
                  className="w-28"
                  type="number"
                  min={30}
                  max={3600}
                  defaultValue={settings?.cloudflare.propagationTimeoutSeconds ?? 300}
                  onBlur={(event) =>
                    update.mutate({
                      cloudflare: { propagationTimeoutSeconds: Number(event.target.value) || 300 },
                    })
                  }
                />
              </Row>
              <Row
                title="Automatic DNS creation"
                description="Allow managed workflows to create missing DNS records."
              >
                <Switch
                  checked={settings?.cloudflare.automaticDnsCreation ?? false}
                  onCheckedChange={(automaticDnsCreation) =>
                    update.mutate({ cloudflare: { automaticDnsCreation } })
                  }
                />
              </Row>
              <Row
                title="Automatic SSL"
                description="Continue from propagated DNS to the SSL workflow."
              >
                <Switch
                  checked={settings?.cloudflare.automaticSsl ?? false}
                  onCheckedChange={(automaticSsl) =>
                    update.mutate({ cloudflare: { automaticSsl } })
                  }
                />
              </Row>
              <Row
                title="Automatic HTTPS redirect"
                description="Enable HTTPS redirect after a certificate is installed."
              >
                <Switch
                  checked={settings?.cloudflare.automaticHttpsRedirect ?? true}
                  onCheckedChange={(automaticHttpsRedirect) =>
                    update.mutate({ cloudflare: { automaticHttpsRedirect } })
                  }
                />
              </Row>
              <Row
                title="Preferred SSL mode"
                description="Default encryption mode for managed Cloudflare zones."
              >
                <Select
                  className="w-40"
                  value={settings?.cloudflare.preferredSslMode ?? 'strict'}
                  onChange={(event) =>
                    update.mutate({
                      cloudflare: {
                        preferredSslMode: event.target.value as
                          'off' | 'flexible' | 'full' | 'strict',
                      },
                    })
                  }
                >
                  <option value="off">Off</option>
                  <option value="flexible">Flexible</option>
                  <option value="full">Full</option>
                  <option value="strict">Full (strict)</option>
                </Select>
              </Row>
              <Row
                title="Browser cache TTL"
                description="Default browser cache duration for managed zones."
              >
                <Input
                  className="w-28"
                  type="number"
                  min={0}
                  defaultValue={settings?.cloudflare.cacheTtl ?? 14400}
                  onBlur={(event) =>
                    update.mutate({ cloudflare: { cacheTtl: Number(event.target.value) || 0 } })
                  }
                />
              </Row>
              <Row
                title="Development mode"
                description="Preferred development-mode state for managed zones."
              >
                <Switch
                  checked={settings?.cloudflare.developmentMode ?? false}
                  onCheckedChange={(developmentMode) =>
                    update.mutate({ cloudflare: { developmentMode } })
                  }
                />
              </Row>
              <Row
                title="Confirm destructive actions"
                description="Require confirmation before DNS or zone deletion."
              >
                <Switch
                  checked={settings?.cloudflare.confirmDelete ?? true}
                  onCheckedChange={(confirmDelete) =>
                    update.mutate({ cloudflare: { confirmDelete } })
                  }
                />
              </Row>
              <Row
                title="Activity logging"
                description="Record Cloudflare changes without storing tokens or secret values."
              >
                <Switch
                  checked={settings?.cloudflare.activityLogging ?? true}
                  onCheckedChange={(activityLogging) =>
                    update.mutate({ cloudflare: { activityLogging } })
                  }
                />
              </Row>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="security">
          <Card>
            <CardContent className="divide-border/60 divide-y py-2">
              <Row title="Secret storage" description="Where CloudForge encrypts your credentials.">
                <span className="text-sm font-medium">
                  {security?.backedByOsKeychain ? 'OS keychain' : 'Local encrypted key'}
                </span>
              </Row>
              <Row
                title="Portable backup passphrase"
                description="At least 12 characters. You need the same passphrase on the other computer."
              >
                <Input
                  className="w-64"
                  type="password"
                  autoComplete="new-password"
                  value={backupPassphrase}
                  onChange={(event) => setBackupPassphrase(event.target.value)}
                  placeholder="Backup passphrase"
                />
              </Row>
              <Row
                title="Backup"
                description="Create a consistent database snapshot with portable encrypted credentials and Pulumi state."
              >
                <Button
                  variant="outline"
                  disabled={!backupReady}
                  onClick={() =>
                    void invoke('backup:create', { passphrase: backupPassphrase })
                      .then(({ path }) => {
                        if (path) toast.success(`Portable backup created: ${path}`);
                      })
                      .catch((error: Error) => toast.error(error.message))
                  }
                >
                  Create backup
                </Button>
              </Row>
              <Row title="Restore" description="Restore a backup and restart CloudForge.">
                <Button
                  variant="destructive"
                  disabled={!backupReady}
                  onClick={() => {
                    if (
                      !window.confirm(
                        'Restore a CloudForge backup? Current data is safety-backed-up and the app will restart.',
                      )
                    )
                      return;
                    void invoke('backup:restore', { passphrase: backupPassphrase }).catch(
                      (error: Error) => toast.error(error.message),
                    );
                  }}
                >
                  Restore backup
                </Button>
              </Row>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}

function updateStatusLabel(state: UpdateState): string {
  switch (state.status) {
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return 'An update is available';
    case 'downloading':
      return 'Downloading update…';
    case 'downloaded':
      return 'Update ready to install';
    case 'not-available':
      return 'CloudForge is up to date';
    case 'error':
      return 'Update check failed';
    default:
      return 'Application updates';
  }
}

function Row({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 py-4">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
