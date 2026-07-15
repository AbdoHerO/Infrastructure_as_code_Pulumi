import { useEffect, useMemo, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Loader2, Plug, Unplug } from 'lucide-react';
import { Badge, Button, Card, CardContent, Label, Select, toast } from '@cloudforge/ui';
import { PageHeader } from '../../components/PageHeader.js';
import { invoke, subscribe } from '../../lib/ipc.js';
import { useVpsTargets } from '../ansible/useAnsible.js';

type ConnectionState = 'disconnected' | 'connecting' | 'connected';

/** Interactive PTY backed by a saved, fingerprint-verified CloudForge VPS target. */
export function TerminalPage(): JSX.Element {
  const targets = useVpsTargets();
  const [targetId, setTargetId] = useState('');
  const [state, setState] = useState<ConnectionState>('disconnected');
  const sessionId = useMemo(() => crypto.randomUUID(), []);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connectedRef = useRef(false);

  useEffect(() => {
    if (!targets.data) return;
    if (!targets.data.some((target) => target.id === targetId)) {
      setTargetId(targets.data[0]?.id ?? '');
    }
  }, [targetId, targets.data]);

  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: 'Cascadia Code, Consolas, ui-monospace, monospace',
      fontSize: 14,
      scrollback: 10_000,
      theme: {
        background: '#09090b',
        foreground: '#f4f4f5',
        cursor: '#a78bfa',
        selectionBackground: '#4c1d9566',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    if (hostRef.current) terminal.open(hostRef.current);
    fit.fit();
    terminal.writeln('\x1b[1;35mCloudForge SSH Terminal\x1b[0m');
    terminal.writeln('Select a saved VPS target and connect.\r\n');
    terminalRef.current = terminal;
    fitRef.current = fit;

    const input = terminal.onData((data) => {
      if (!connectedRef.current) return;
      void invoke('terminal:write', { sessionId, data }).catch((error: Error) => {
        connectedRef.current = false;
        setState('disconnected');
        terminal.writeln(`\r\n\x1b[31m${error.message}\x1b[0m`);
      });
    });
    const dataSubscription = subscribe('terminal:data', (payload) => {
      if (payload.sessionId === sessionId) terminal.write(payload.data);
    });
    const closeSubscription = subscribe('terminal:closed', (payload) => {
      if (payload.sessionId !== sessionId) return;
      connectedRef.current = false;
      setState('disconnected');
      terminal.writeln(
        `\r\n\x1b[33m[SSH session closed${payload.reason ? `: ${payload.reason}` : ''}]\x1b[0m`,
      );
    });
    const observer = new ResizeObserver(() => {
      fit.fit();
      if (!connectedRef.current) return;
      void invoke('terminal:resize', {
        sessionId,
        columns: Math.max(20, terminal.cols),
        rows: Math.max(5, terminal.rows),
      }).catch(() => undefined);
    });
    if (hostRef.current) observer.observe(hostRef.current);

    return () => {
      observer.disconnect();
      input.dispose();
      dataSubscription();
      closeSubscription();
      if (connectedRef.current) void invoke('terminal:close', { sessionId }).catch(() => undefined);
      connectedRef.current = false;
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  const connect = async (): Promise<void> => {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (!terminal || !fit || !targetId) return;
    setState('connecting');
    terminal.clear();
    terminal.writeln('\x1b[36mConnecting through CloudForge…\x1b[0m');
    fit.fit();
    try {
      await invoke('terminal:open', {
        targetId,
        sessionId,
        columns: Math.max(20, terminal.cols),
        rows: Math.max(5, terminal.rows),
      });
      connectedRef.current = true;
      setState('connected');
      terminal.focus();
    } catch (error) {
      setState('disconnected');
      const message = error instanceof Error ? error.message : 'Could not open the SSH terminal';
      terminal.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
      toast.error(message);
    }
  };

  const disconnect = async (): Promise<void> => {
    if (!connectedRef.current) return;
    connectedRef.current = false;
    setState('disconnected');
    try {
      await invoke('terminal:close', { sessionId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not close the SSH terminal');
    }
  };

  const selected = targets.data?.find((target) => target.id === targetId);
  return (
    <div className="space-y-5">
      <PageHeader
        title="SSH Terminal"
        description="Open an interactive shell through a saved, encrypted and fingerprint-verified VPS target."
      />
      <Card>
        <CardContent className="grid gap-4 pt-6 md:grid-cols-[1fr_auto_auto] md:items-end">
          <div className="space-y-1.5">
            <Label>VPS target</Label>
            <Select
              value={targetId}
              disabled={state !== 'disconnected'}
              onChange={(event) => setTargetId(event.target.value)}
            >
              <option value="">Select a saved target…</option>
              {targets.data?.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name} · {target.username}@{target.host}
                </option>
              ))}
            </Select>
          </div>
          <Badge variant={state === 'connected' ? 'success' : 'secondary'}>{state}</Badge>
          {state === 'connected' ? (
            <Button variant="destructive" onClick={() => void disconnect()}>
              <Unplug className="size-4" /> Disconnect
            </Button>
          ) : (
            <Button disabled={!targetId || state === 'connecting'} onClick={() => void connect()}>
              {state === 'connecting' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plug className="size-4" />
              )}
              Connect
            </Button>
          )}
          {selected ? (
            <p className="text-muted-foreground text-xs md:col-span-3">
              CloudForge decrypts the saved credential only in the main process and verifies{' '}
              {selected.hostKeySha256} before opening the shell.
            </p>
          ) : null}
        </CardContent>
      </Card>
      <Card className="overflow-hidden border-zinc-800 bg-[#09090b]">
        <div ref={hostRef} className="h-[min(68vh,680px)] min-h-[420px] p-3" />
      </Card>
    </div>
  );
}
