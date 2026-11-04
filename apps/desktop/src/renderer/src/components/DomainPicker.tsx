import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, RefreshCw, XCircle } from 'lucide-react';
import { isValidDomain, normalizeDomain, type DomainCheck } from '@cloudforge/core';
import { Input, Label, Select } from '@cloudforge/ui';
import { useCredentials } from '../features/secrets/useCredentials.js';
import { invoke } from '../lib/ipc.js';

/** One or more DNS labels in front of the Cloudflare domain: `blog`, `shop.eu`. */
const SUBDOMAIN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export interface DomainSelection {
  /** Empty until a whole domain is chosen. */
  readonly domain: string;
  readonly cloudflareCredentialId: string | null;
  readonly cloudflareZoneId: string | null;
  /** Checked on the server, and free. */
  readonly ready: boolean;
}

export const NO_DOMAIN: DomainSelection = {
  domain: '',
  cloudflareCredentialId: null,
  cloudflareZoneId: null,
  ready: false,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Availability({
  domain,
  check,
}: {
  domain: string;
  check: DomainCheck | null;
}): JSX.Element {
  if (!check)
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <RefreshCw className="size-4 animate-spin" /> Checking whether {domain} is free…
      </p>
    );
  if (!check.available)
    return (
      <div className="border-destructive/40 bg-destructive/5 rounded-md border p-3 text-sm">
        <p className="text-destructive flex items-center gap-2 font-medium">
          <XCircle className="size-4 shrink-0" /> {domain} cannot be used. Choose another subdomain.
        </p>
        <ul className="text-muted-foreground mt-1 list-disc pl-6">
          {check.conflicts.map((conflict) => (
            <li key={conflict}>{conflict}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="text-sm">
      <p className="text-success flex items-center gap-2 font-medium">
        <CheckCircle2 className="size-4 shrink-0" /> {domain} is free
      </p>
      {check.notes.map((note) => (
        <p key={note} className="text-muted-foreground pl-6">
          {note}
        </p>
      ))}
    </div>
  );
}

/**
 * Choose where an application is published: a domain from the Cloudflare account,
 * the domain itself or a new subdomain, with a live check that nothing else uses
 * it. The deploy repeats the check on the server side; this one is for the person.
 */
export function DomainPicker({
  idPrefix,
  targetId,
  onChange,
  refreshKey,
  alsoTaken = [],
}: {
  idPrefix: string;
  targetId: string;
  onChange: (selection: DomainSelection) => void;
  /** Check again when this changes, e.g. after a site was removed. */
  refreshKey?: unknown;
  /** Domains already chosen elsewhere in the same form. */
  alsoTaken?: readonly string[];
}): JSX.Element {
  const credentials = useCredentials();
  const accounts = useMemo(
    () => credentials.data?.filter((credential) => credential.kind === 'cloudflare') ?? [],
    [credentials.data],
  );
  const [credentialId, setCredentialId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [mode, setMode] = useState<'subdomain' | 'root'>('subdomain');
  const [subdomain, setSubdomain] = useState('');
  const [manualDomain, setManualDomain] = useState('');
  const [check, setCheck] = useState<DomainCheck | null>(null);

  // Preselect the first account once; choosing "not on Cloudflare" stays chosen.
  const [accountPicked, setAccountPicked] = useState(false);
  useEffect(() => {
    if (accountPicked || !credentials.data) return;
    setAccountPicked(true);
    if (accounts[0]) setCredentialId(accounts[0].id);
  }, [accountPicked, credentials.data, accounts]);

  const zones = useQuery({
    queryKey: ['cloudflare', 'zones', credentialId],
    queryFn: () => invoke('cloudflare:zones', { credentialId }),
    enabled: credentialId !== '',
  });
  useEffect(() => {
    const available = zones.data ?? [];
    if (available.length > 0 && !available.some((zone) => zone.id === zoneId))
      setZoneId(available[0]?.id ?? '');
  }, [zoneId, zones.data]);
  const zone = zones.data?.find((item) => item.id === zoneId);

  const subdomainValid = SUBDOMAIN.test(subdomain);
  const chosen = credentialId
    ? mode === 'root'
      ? (zone?.name ?? '')
      : zone && subdomainValid
        ? `${subdomain}.${zone.name}`
        : ''
    : normalizeDomain(manualDomain);
  const domain = isValidDomain(chosen) ? chosen : '';
  const cloudflareCredentialId = credentialId === '' ? null : credentialId;
  const cloudflareZoneId = credentialId === '' || zoneId === '' ? null : zoneId;
  const takenInForm = domain !== '' && alsoTaken.includes(domain);

  useEffect(() => {
    setCheck(null);
    if (!targetId || domain === '' || takenInForm) return;
    let current = true;
    const timer = setTimeout(() => {
      invoke('domains:check', { targetId, domain, cloudflareCredentialId, cloudflareZoneId })
        .then((result) => {
          if (current) setCheck(result);
        })
        .catch((error: unknown) => {
          if (current)
            setCheck({
              domain,
              available: false,
              conflicts: [`Could not check the domain: ${message(error)}`],
              notes: [],
            });
        });
    }, 600);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [targetId, domain, takenInForm, cloudflareCredentialId, cloudflareZoneId, refreshKey]);

  const visibleCheck: DomainCheck | null = takenInForm
    ? {
        domain,
        available: false,
        conflicts: ['It is already chosen above in this form.'],
        notes: [],
      }
    : check?.domain === domain
      ? check
      : null;
  const ready = visibleCheck?.available === true;
  useEffect(() => {
    onChange({ domain, cloudflareCredentialId, cloudflareZoneId, ready });
    // Parents pass an inline callback; only the selection itself should fire this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain, cloudflareCredentialId, cloudflareZoneId, ready]);

  return (
    <div className="grid gap-3 md:col-span-2">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-account`}>Cloudflare account</Label>
          <Select
            id={`${idPrefix}-account`}
            value={credentialId}
            onChange={(event) => setCredentialId(event.target.value)}
          >
            {accounts.map((credential) => (
              <option key={credential.id} value={credential.id}>
                {credential.name}
              </option>
            ))}
            <option value="">Domain not on Cloudflare (I set DNS myself)</option>
          </Select>
        </div>
        {credentialId === '' ? (
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-manual`}>Domain</Label>
            <Input
              id={`${idPrefix}-manual`}
              value={manualDomain}
              placeholder="app.example.com"
              onChange={(event) => setManualDomain(event.target.value)}
            />
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-zone`}>Domain</Label>
            <Select
              id={`${idPrefix}-zone`}
              value={zoneId}
              disabled={zones.isLoading}
              onChange={(event) => setZoneId(event.target.value)}
            >
              {zones.isLoading ? <option value="">Loading your domains…</option> : null}
              {!zones.isLoading && (zones.data ?? []).length === 0 ? (
                <option value="">No domain in this Cloudflare account</option>
              ) : null}
              {(zones.data ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
      {credentialId !== '' ? (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-mode`}>Use</Label>
            <Select
              id={`${idPrefix}-mode`}
              value={mode}
              onChange={(event) => setMode(event.target.value === 'root' ? 'root' : 'subdomain')}
            >
              <option value="subdomain">A subdomain</option>
              <option value="root">The domain itself</option>
            </Select>
          </div>
          {mode === 'subdomain' ? (
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-subdomain`}>Subdomain</Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`${idPrefix}-subdomain`}
                  value={subdomain}
                  placeholder="app"
                  autoComplete="off"
                  onChange={(event) => setSubdomain(event.target.value.trim().toLowerCase())}
                />
                <span className="text-muted-foreground whitespace-nowrap text-sm">
                  .{zone?.name ?? 'domain'}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {zones.isError ? (
        <p className="text-destructive text-sm">
          Could not load the Cloudflare domains: {message(zones.error)}
        </p>
      ) : null}
      {credentialId !== '' && mode === 'subdomain' && subdomain !== '' && !subdomainValid ? (
        <p className="text-destructive text-sm">
          A subdomain uses letters, digits and hyphens, e.g. app or files.eu
        </p>
      ) : null}
      {domain !== '' && subdomain.includes('.') && mode === 'subdomain' && credentialId !== '' ? (
        <p className="text-warning text-sm">
          Cloudflare’s free certificate covers one level only (app.{zone?.name}), not {subdomain}.
          {zone?.name}. Behind the Cloudflare proxy, browsers would show a certificate error, so use
          DNS only for this name.
        </p>
      ) : null}
      {domain !== '' ? <Availability domain={domain} check={visibleCheck} /> : null}
    </div>
  );
}

/** A URL the operating-system browser may open: the app only lets HTTPS leave. */
export function SiteLink({ url, label }: { url: string; label: string }): JSX.Element {
  return url.startsWith('https://') ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="text-primary inline-flex items-center gap-1 hover:underline"
    >
      {label} <ExternalLink className="size-3" />
    </a>
  ) : (
    <span>{label}</span>
  );
}
