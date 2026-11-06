import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Copy, RefreshCw, UserMinus, UserPlus, Users } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import {
  hostAccessInstructions,
  hostAccessKeyRequest,
  parseSshPublicKey,
  validateAccessUsername,
  type HostAccessState,
  type VpsTargetDto,
} from '@cloudforge/core';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  toast,
} from '@cloudforge/ui';
import { useConfirmation } from '../../components/ConfirmationDialogProvider.js';
import { copyToClipboard as copy } from '../../lib/clipboard.js';
import { invoke } from '../../lib/ipc.js';
import { useVpsTargets } from '../ansible/useAnsible.js';

type Language = 'en' | 'fr';

/**
 * SSH access for other people — a client, a colleague — to a saved server.
 *
 * They send their PUBLIC key; CloudForge creates their own account on the
 * server with that key (and sudo when asked), then shows how they connect and a
 * message ready to send. CloudForge's own keys are never shared: removing a
 * person's access later deletes their account and leaves CloudForge's untouched.
 */
export function ServerAccessCard(): JSX.Element {
  const confirm = useConfirmation();
  const targets = useVpsTargets();
  const [targetId, setTargetId] = useState('');
  const [state, setState] = useState<HostAccessState | null>(null);
  const [username, setUsername] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [sudo, setSudo] = useState(false);
  const [shown, setShown] = useState<{ username: string; sudo: boolean } | null>(null);
  const [language, setLanguage] = useState<Language>('en');

  const target: VpsTargetDto | undefined = targets.data?.find((t) => t.id === targetId);

  const inspect = useMutation({
    mutationFn: () => invoke('hostAccess:inspect', { targetId }),
    onSuccess: setState,
    onError: (error) => toast.error(error.message),
  });
  const grant = useMutation({
    mutationFn: () =>
      invoke('hostAccess:grant', { targetId, username: username.trim(), publicKey, sudo }),
    onSuccess: (value) => {
      setState(value);
      setShown({ username: username.trim(), sudo });
      toast.success(`${username.trim()} can now connect over SSH`);
      setUsername('');
      setPublicKey('');
      setSudo(false);
    },
    onError: (error) => toast.error(error.message),
  });
  const revoke = useMutation({
    mutationFn: (name: string) => invoke('hostAccess:revoke', { targetId, username: name }),
    onSuccess: (value, name) => {
      setState(value);
      if (shown?.username === name) setShown(null);
      toast.success(`The SSH access of ${name} was removed`);
    },
    onError: (error) => toast.error(error.message),
  });

  useEffect(() => {
    setState(null);
    setShown(null);
    if (targetId) inspect.mutate();
    // Re-read whenever another server is chosen; the mutation object is stable enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId]);

  // Checked as the person types, with the same rules the main process applies.
  const nameCheck = username.trim() ? validateAccessUsername(username) : null;
  const keyCheck = publicKey.trim() ? parseSshPublicKey(publicKey) : null;
  const ownAccount = username.trim() !== '' && username.trim() === target?.username;
  const ready = Boolean(targetId) && nameCheck?.ok === true && keyCheck?.ok === true && !ownAccount;
  const busy = inspect.isPending || grant.isPending || revoke.isPending;

  const instructions = useMemo(
    () =>
      target && shown
        ? hostAccessInstructions(target, shown.username, { sudo: shown.sudo, language })
        : null,
    [target, shown, language],
  );

  const askGrant = (): void => {
    const name = username.trim();
    const existing = state?.users.some((u) => u.username === name);
    void confirm({
      title: existing ? `Add this key to ${name}?` : `Give ${name} SSH access?`,
      description: `${existing ? `Adds the key to the account ${name}` : `Creates the account ${name} on ${target?.name ?? 'the server'} (${target?.host ?? ''}) with this public key`}${sudo ? ' and lets it use sudo: full administrator rights on the server' : ', without administrator rights'}. Nothing else on the server is changed.`,
      confirmLabel: existing ? 'Add key' : 'Give access',
      destructive: false,
    }).then((confirmed) => {
      if (confirmed) grant.mutate();
    });
  };
  const askRevoke = (name: string): void => {
    void confirm({
      title: `Remove the SSH access of ${name}?`,
      description: `Deletes the account ${name} and its home folder on ${target?.name ?? 'the server'}: their open sessions are closed and their key stops working. CloudForge's own access is not touched.`,
      confirmLabel: 'Remove access',
    }).then((confirmed) => {
      if (confirmed) revoke.mutate(name);
    });
  };

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="size-4" />
          SSH access for other people
        </CardTitle>
        <CardDescription>
          Give a client or a colleague their own SSH access to a server: they send you their{' '}
          <strong>public</strong> key, CloudForge creates their account and shows them how to
          connect. Never send anyone the private keys above: they are CloudForge&apos;s access to
          your servers.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <div>
            <Label>Server (saved VPS target)</Label>
            <Select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              <option value="">Select the server</option>
              {targets.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · {t.host}
                </option>
              ))}
            </Select>
          </div>
          <Button
            variant="outline"
            className="self-end"
            disabled={!targetId || busy}
            onClick={() => inspect.mutate()}
          >
            <RefreshCw className="size-4" /> Refresh
          </Button>
        </div>
        {targets.data?.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No saved VPS target yet: add the server in Ansible → Targets first.
          </p>
        )}

        <div className="rounded-md border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">1. Ask the person for their public key</p>
            <div className="flex gap-2">
              <LanguageSwitch value={language} onChange={setLanguage} />
              <Button
                size="sm"
                variant="outline"
                onClick={() => void copy(hostAccessKeyRequest(language), 'Message')}
              >
                <Copy className="size-4" /> Copy the request
              </Button>
            </div>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            A message explaining how to make a key (<code>ssh-keygen -t ed25519</code>) and to send
            only the <code>.pub</code> file.
          </p>
        </div>

        {targetId && (
          <div className="space-y-3 rounded-md border p-4">
            <p className="text-sm font-medium">2. Give access</p>
            <div className="grid gap-3 md:grid-cols-[240px_1fr]">
              <div>
                <Label htmlFor="access-username">Account name</Label>
                <Input
                  id="access-username"
                  placeholder="alex"
                  value={username}
                  autoComplete="off"
                  onChange={(event) => setUsername(event.target.value.toLowerCase())}
                />
                {nameCheck && !nameCheck.ok && (
                  <p className="text-destructive mt-1 text-xs">{nameCheck.error.message}</p>
                )}
                {ownAccount && (
                  <p className="text-destructive mt-1 text-xs">
                    {target?.username} is the account CloudForge connects with: choose another name.
                  </p>
                )}
              </div>
              <div>
                <Label htmlFor="access-key">Their public key (.pub)</Label>
                <Textarea
                  id="access-key"
                  rows={3}
                  className="font-mono text-xs"
                  placeholder="ssh-ed25519 AAAAC3Nza… name@computer"
                  value={publicKey}
                  spellCheck={false}
                  onChange={(event) => setPublicKey(event.target.value)}
                />
                {keyCheck && !keyCheck.ok && (
                  <p className="text-destructive mt-1 text-xs">{keyCheck.error.message}</p>
                )}
                {keyCheck?.ok && (
                  <p className="text-muted-foreground mt-1 text-xs">
                    {keyCheck.value.type}
                    {keyCheck.value.comment ? ` · ${keyCheck.value.comment}` : ''}
                  </p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Switch id="access-sudo" checked={sudo} onCheckedChange={setSudo} />
                <Label htmlFor="access-sudo">
                  {sudo
                    ? 'Administrator (sudo): full control of the server'
                    : 'No administrator rights'}
                </Label>
              </div>
              <Button disabled={!ready || busy} onClick={askGrant}>
                <UserPlus className="size-4" /> Give access
              </Button>
            </div>
          </div>
        )}

        {instructions && shown && (
          <div className="space-y-3 rounded-md border border-emerald-500/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">3. How {shown.username} connects</p>
              <div className="flex gap-2">
                <LanguageSwitch value={language} onChange={setLanguage} />
                <Button size="sm" onClick={() => void copy(instructions.message, 'Message')}>
                  <Copy className="size-4" /> Copy the message for {shown.username}
                </Button>
              </div>
            </div>
            <dl className="grid gap-2 text-sm md:grid-cols-[160px_1fr]">
              <dt className="text-muted-foreground">Command</dt>
              <dd className="flex items-center gap-2">
                <code className="bg-muted rounded px-2 py-1">{instructions.command}</code>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void copy(instructions.command, 'Command')}
                >
                  <Copy className="size-4" />
                </Button>
              </dd>
              <dt className="text-muted-foreground">Server fingerprint</dt>
              <dd className="break-all font-mono text-xs">{instructions.fingerprint}</dd>
              <dt className="text-muted-foreground">Address · port · account</dt>
              <dd>
                {target?.host} · {target?.port} · {shown.username}
              </dd>
            </dl>
            <pre className="bg-muted max-h-64 overflow-auto whitespace-pre-wrap rounded p-3 text-xs">
              {instructions.message}
            </pre>
          </div>
        )}

        {state && state.warnings.length > 0 && (
          <div className="space-y-1 rounded-md border border-amber-500/40 p-3 text-sm">
            {state.warnings.map((warning) => (
              <p key={warning} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                {warning}
              </p>
            ))}
          </div>
        )}

        {state && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Rights</TableHead>
                <TableHead>Keys</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    Nobody else has SSH access given by CloudForge on this server.
                  </TableCell>
                </TableRow>
              ) : (
                state.users.map((user) => (
                  <TableRow key={user.username}>
                    <TableCell className="font-medium">{user.username}</TableCell>
                    <TableCell>
                      <Badge variant={user.sudo ? 'warning' : 'secondary'}>
                        {user.sudo ? 'administrator (sudo)' : 'standard'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {user.keys.length === 0
                        ? 'no key'
                        : user.keys.map((key) => (
                            <div key={key.fingerprint} className="font-mono">
                              {key.type} {key.fingerprint}
                              {key.comment ? ` · ${key.comment}` : ''}
                            </div>
                          ))}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setShown({ username: user.username, sudo: user.sudo })}
                      >
                        Instructions
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => askRevoke(user.username)}
                      >
                        <UserMinus className="size-4" /> Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function LanguageSwitch({
  value,
  onChange,
}: {
  value: Language;
  onChange: (value: Language) => void;
}): JSX.Element {
  return (
    <Select
      className="h-8 w-auto"
      value={value}
      onChange={(event) => onChange(event.target.value as Language)}
      aria-label="Message language"
    >
      <option value="en">English</option>
      <option value="fr">Français</option>
    </Select>
  );
}
