import { useState, type ReactNode } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Select,
  Switch,
  toast,
} from '@cloudforge/ui';
import type { McpCriticalMode, McpSettings, McpSettingsPatch } from '@shared/mcp/types.js';
import { useConfirmation } from '../../components/ConfirmationDialogProvider.js';
import { invoke } from '../../lib/ipc.js';
import { useMcpStatus, useUpdateMcpSettings } from './useMcp.js';

async function copy(text: string, label: string): Promise<void> {
  try {
    await invoke('app:copyText', { text });
    toast.success(`${label} copied`);
  } catch (error) {
    toast.error(`Could not copy: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Settings → MCP: lets AI clients use CloudForge, and decides what they may do. */
export function McpSettingsPanel(): JSX.Element {
  const confirm = useConfirmation();
  const status = useMcpStatus();
  const update = useUpdateMcpSettings();
  const [regenerating, setRegenerating] = useState(false);
  const settings = status.data?.settings;

  if (!status.data || !settings) {
    return <p className="text-muted-foreground py-6 text-sm">Loading…</p>;
  }

  const save = (patch: McpSettingsPatch): void => {
    update.mutate(patch, { onError: (error) => toast.error(error.message) });
  };

  /** Widening what an AI may do is worth one deliberate click. */
  const widen = async (
    title: string,
    description: string,
    patch: McpSettingsPatch,
  ): Promise<void> => {
    const confirmed = await confirm({ title, description, confirmLabel: 'Allow' });
    if (confirmed) save(patch);
  };

  const setTier = (tier: keyof McpSettings['tiers'], value: boolean): void =>
    save({ tiers: { [tier]: value } });

  const setSecrets = (allowed: boolean): void => {
    if (!allowed) return setTier('secret', false);
    void widen(
      'Let MCP clients read secrets?',
      'Passwords, private keys and tokens would be sent to the AI client, and through it to its provider. Turn this on only for a client you trust, and only while you need it.',
      { tiers: { secret: true } },
    );
  };
  const setShell = (allowed: boolean): void => {
    if (!allowed) return setTier('shell', false);
    void widen(
      'Let MCP clients run commands on your servers?',
      'A client could run anything the saved SSH account can, on every saved server, without asking you each time.',
      { tiers: { shell: true } },
    );
  };
  const setCritical = (mode: McpCriticalMode): void => {
    if (mode !== 'allow') return save({ tiers: { critical: mode } });
    void widen(
      'Stop asking before critical actions?',
      'A client could delete projects, destroy cloud resources, terminate instances and give people access to your servers without your approval.',
      { tiers: { critical: 'allow' } },
    );
  };
  const setProjectSwitch = (allowed: boolean): void => {
    if (!allowed) return save({ allowProjectSwitch: false });
    void widen(
      'Let MCP clients open and switch projects?',
      "A project's passkey would pass through the AI client to open it.",
      { allowProjectSwitch: true },
    );
  };

  const setToolset = (id: string, enabled: boolean): void =>
    save({
      disabledToolsets: enabled
        ? settings.disabledToolsets.filter((item) => item !== id)
        : [...settings.disabledToolsets, id],
    });

  const copyConfig = async (which: 'claudeCodeCommand' | 'claudeDesktopJson'): Promise<void> => {
    try {
      const config = await invoke('mcp:clientConfig', undefined);
      await copy(config[which], which === 'claudeCodeCommand' ? 'Command' : 'Configuration');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not read the configuration');
    }
  };

  const copyToken = async (): Promise<void> => {
    try {
      await copy((await invoke('mcp:revealToken', undefined)).token, 'Token');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not read the token');
    }
  };

  const regenerate = async (): Promise<void> => {
    const confirmed = await confirm({
      title: 'Replace the access token?',
      description:
        'Every connected client is disconnected and needs the new token to connect again.',
      confirmLabel: 'Replace token',
    });
    if (!confirmed) return;
    setRegenerating(true);
    try {
      await invoke('mcp:regenerateToken', undefined);
      toast.success('Token replaced');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not replace the token');
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>MCP server</CardTitle>
          <CardDescription>
            Lets an AI assistant such as Claude use CloudForge the way you do:{' '}
            {status.data.toolCount} tools on the project open in this window. It only listens on
            this computer, and only while CloudForge is open.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-border/60 divide-y py-2">
          <Row title="Enable MCP server" description={statusLine(status.data)}>
            <Switch checked={settings.enabled} onCheckedChange={(enabled) => save({ enabled })} />
          </Row>
          <Row title="Port" description="Restart clients after changing it.">
            <Input
              key={settings.port}
              className="w-24"
              type="number"
              min={1024}
              max={65535}
              defaultValue={settings.port}
              onBlur={(event) => {
                const port = Number(event.target.value);
                if (port !== settings.port) save({ port });
              }}
            />
          </Row>
          <Row
            title="Connected clients"
            description={
              status.data.clients.length === 0
                ? 'None right now.'
                : status.data.clients
                    .map((client) => `${client.name} ${client.version}`.trim())
                    .join(', ')
            }
          >
            <Badge variant={status.data.clients.length > 0 ? 'success' : 'secondary'}>
              {status.data.clients.length}
            </Badge>
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connect a client</CardTitle>
          <CardDescription>
            What you copy here contains the access token. Treat it like a password.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void copyConfig('claudeCodeCommand')}>
            <Copy className="mr-2 size-4" /> Command for Claude Code
          </Button>
          <Button variant="outline" onClick={() => void copyConfig('claudeDesktopJson')}>
            <Copy className="mr-2 size-4" /> Configuration for Claude Desktop
          </Button>
          <Button variant="outline" onClick={() => void copyToken()}>
            <Copy className="mr-2 size-4" /> Token
          </Button>
          <Button variant="ghost" disabled={regenerating} onClick={() => void regenerate()}>
            <RefreshCw className="mr-2 size-4" /> Replace token
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What clients may do</CardTitle>
          <CardDescription>
            A client cannot change any of this. Everything it changes appears in the activity feed.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-border/60 divide-y py-2">
          <Row title="Read" description="See projects, servers, settings, logs and status.">
            <Switch
              checked={settings.tiers.read}
              onCheckedChange={(value) => setTier('read', value)}
            />
          </Row>
          <Row
            title="Make changes"
            description="Create and update things, deploy, install software, open firewall ports."
          >
            <Switch
              checked={settings.tiers.write}
              onCheckedChange={(value) => setTier('write', value)}
            />
          </Row>
          <Row
            title="Critical actions"
            description="Delete, destroy, terminate, cause downtime, cost money, give access, restore, restart."
          >
            <Select
              className="w-44"
              value={settings.tiers.critical}
              onChange={(event) => setCritical(event.target.value as McpCriticalMode)}
            >
              <option value="ask">Ask me each time</option>
              <option value="allow">Allow without asking</option>
              <option value="off">Never allow</option>
            </Select>
          </Row>
          <Row
            title="Read secrets"
            description="Passwords, private keys and tokens would reach the AI and its provider."
          >
            <Switch checked={settings.tiers.secret} onCheckedChange={setSecrets} />
          </Row>
          <Row
            title="Run commands on servers"
            description="The SSH terminal, and running a command on any saved server."
          >
            <Switch checked={settings.tiers.shell} onCheckedChange={setShell} />
          </Row>
          <Row
            title="Use this computer"
            description="Read and create files at given paths, the clipboard, open links. Existing files are never replaced."
          >
            <Switch
              checked={settings.tiers.local}
              onCheckedChange={(value) => setTier('local', value)}
            />
          </Row>
          <Row
            title="Open and switch projects"
            description="A project's passkey would pass through the AI to open it."
          >
            <Switch checked={settings.allowProjectSwitch} onCheckedChange={setProjectSwitch} />
          </Row>
          <Row
            title="Time to decide"
            description="Seconds before an unanswered request is refused."
          >
            <Input
              key={settings.approvalTimeoutSeconds}
              className="w-24"
              type="number"
              min={15}
              max={600}
              defaultValue={settings.approvalTimeoutSeconds}
              onBlur={(event) => {
                const seconds = Number(event.target.value);
                if (seconds !== settings.approvalTimeoutSeconds) {
                  save({ approvalTimeoutSeconds: seconds });
                }
              }}
            />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Toolsets</CardTitle>
          <CardDescription>
            Switch off what a client does not need. It keeps the AI focused and takes those tools
            away from it.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-x-8 gap-y-3 py-4 md:grid-cols-2">
          {status.data.toolsets.map((toolset) => (
            <div key={toolset.id} className="flex items-center justify-between gap-4 text-sm">
              <span>
                {toolset.label}{' '}
                <span className="text-muted-foreground text-xs">{toolset.tools}</span>
              </span>
              <Switch
                checked={!settings.disabledToolsets.includes(toolset.id)}
                onCheckedChange={(enabled) => setToolset(toolset.id, enabled)}
              />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function statusLine(status: {
  readonly running: boolean;
  readonly url: string | null;
  readonly error: string | null;
}): string {
  if (status.error) return status.error;
  return status.running && status.url ? `Listening at ${status.url}` : 'Switched off.';
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
