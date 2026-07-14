import { useState, type ReactNode } from 'react';
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
import { PageHeader } from '../../components/PageHeader.js';
import { useThemeStore } from '../../app/theme/theme-store.js';
import { useSecurityStatus } from '../secrets/useCredentials.js';
import { useSettings, useUpdateSettings } from './useSettings.js';
import { invoke } from '../../lib/ipc.js';
import { toast } from '@cloudforge/ui';

/** The Settings module with grouped, tabbed sections. */
export function SettingsPage(): JSX.Element {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  const { data: security } = useSecurityStatus();
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const backupReady = backupPassphrase.length >= 12;

  return (
    <>
      <PageHeader title="Settings" description="Configure CloudForge to your workflow." />

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          <TabsTrigger value="deployment">Deployment</TabsTrigger>
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
