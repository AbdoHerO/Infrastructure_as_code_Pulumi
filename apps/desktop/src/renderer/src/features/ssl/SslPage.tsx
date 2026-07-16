import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, CheckCircle2, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import type { CertificateDetails, ManagedNginxSite } from '@cloudforge/core';
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
  LogTerminal,
  Select,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@cloudforge/ui';
import { PageHeader } from '../../components/PageHeader.js';
import { useConfirmation } from '../../components/ConfirmationDialogProvider.js';
import { invoke, subscribe } from '../../lib/ipc.js';
import { useVpsTargets } from '../ansible/useAnsible.js';
import { useCredentials } from '../secrets/useCredentials.js';

export function SslPage(): JSX.Element {
  const confirm = useConfirmation();
  const targets = useVpsTargets();
  const credentials = useCredentials();
  const cloudflareCredentials = useMemo(
    () => credentials.data?.filter((credential) => credential.kind === 'cloudflare') ?? [],
    [credentials.data],
  );
  const streamId = useMemo(() => crypto.randomUUID(), []);
  const [targetId, setTargetId] = useState('');
  const [domain, setDomain] = useState('');
  const [email, setEmail] = useState('');
  const [certificateVolume, setCertificateVolume] = useState('/opt/cloudforge/certs');
  const [webrootVolume, setWebrootVolume] = useState('/opt/cloudforge/www');
  const [forceRenewal, setForceRenewal] = useState(false);
  const [authority, setAuthority] = useState<'letsencrypt' | 'cloudflare-origin-ca'>('letsencrypt');
  const [cloudflareCredentialId, setCloudflareCredentialId] = useState('');
  const [includeWildcard, setIncludeWildcard] = useState(false);
  const [keyAlgorithm, setKeyAlgorithm] = useState<'rsa' | 'ecc'>('ecc');
  const [validityDays, setValidityDays] = useState<7 | 30 | 90 | 365 | 730 | 1095 | 5475>(5475);
  const [verificationStartedAt, setVerificationStartedAt] = useState<number | null>(null);
  const [certificates, setCertificates] = useState<CertificateDetails[]>([]);
  const [sites, setSites] = useState<ManagedNginxSite[]>([]);
  const [dns, setDns] = useState<{
    matches: boolean;
    domainIps: readonly string[];
    targetIps: readonly string[];
    status: 'pending' | 'propagated' | 'error';
    provider: 'cloudflare' | 'public-dns';
    proxied: boolean;
    sslMode: string;
    certificateRequirement: 'required' | 'recommended';
    message: string;
  } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  useEffect(() => {
    if (!targets.data) return;
    if (!targets.data.some((target) => target.id === targetId)) {
      setTargetId(targets.data[0]?.id ?? '');
    }
  }, [targetId, targets.data]);
  useEffect(() => {
    if (
      cloudflareCredentialId &&
      cloudflareCredentials.some((credential) => credential.id === cloudflareCredentialId)
    )
      return;
    setCloudflareCredentialId(cloudflareCredentials[0]?.id ?? '');
  }, [cloudflareCredentialId, cloudflareCredentials]);
  useEffect(() => {
    if (!targetId) return;
    void invoke('nginx:listSites', { targetId })
      .then((items) => setSites(items.filter((item) => item.managed !== false)))
      .catch(() => setSites([]));
  }, [targetId]);
  useEffect(
    () =>
      subscribe('ssl:log', (payload) => {
        if (payload.streamId === streamId)
          setLogs((current) => [...current.slice(-500), payload.event.message.trimEnd()]);
      }),
    [streamId],
  );
  const verify = useMutation({
    mutationFn: () =>
      invoke('ssl:verifyDns', {
        targetId,
        domain,
        ...(authority === 'cloudflare-origin-ca' && cloudflareCredentialId
          ? { cloudflareCredentialId }
          : {}),
      }),
    onSuccess: (result) => {
      setDns(result);
      if (result.matches) {
        setVerificationStartedAt(null);
        toast.success('DNS matches the selected VPS');
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const verifyDns = verify.mutate;
  useEffect(() => {
    if (
      dns?.status !== 'pending' ||
      verify.isPending ||
      verificationStartedAt === null ||
      Date.now() - verificationStartedAt >= 300_000
    )
      return;
    const timer = window.setTimeout(() => verifyDns(), 5_000);
    return () => window.clearTimeout(timer);
  }, [dns?.status, verificationStartedAt, verify.isPending, verifyDns]);
  const list = useMutation({
    mutationFn: () => invoke('ssl:list', { targetId, certificateVolume }),
    onSuccess: (items) => {
      setCertificates(items);
      if (items.length === 0) {
        toast.info('No certificates have been issued in this volume yet');
      } else {
        toast.success(`Loaded ${items.length} certificate${items.length === 1 ? '' : 's'}`);
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const issue = useMutation({
    mutationFn: () =>
      invoke('ssl:issue', {
        targetId,
        streamId,
        config: {
          domain,
          email,
          certificateVolume,
          webrootVolume,
          forceRenewal,
          authority,
          cloudflareCredentialId,
          includeWildcard,
          keyAlgorithm,
          validityDays,
        },
      }),
    onSuccess: (certificate) => {
      toast.success(`Certificate issued for ${certificate.domain}`);
      setCertificates((current) => [
        certificate,
        ...current.filter((item) => item.domain !== certificate.domain),
      ]);
    },
    onError: (error) => toast.error(error.message),
  });
  const exportCertificate = async (
    certificate: CertificateDetails,
    format: 'pem' | 'crt' | 'key' | 'zip',
  ): Promise<void> => {
    if (
      format === 'key' &&
      !(await confirm({
        title: 'Export private key?',
        description:
          'The unencrypted certificate private key will be saved to this computer. Anyone with this file can impersonate the origin server.',
        confirmLabel: 'Export private key',
      }))
    )
      return;
    try {
      const exported = await invoke('ssl:export', {
        targetId,
        certificateVolume,
        domain: certificate.domain,
        format,
      });
      const binary = atob(exported.contentBase64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes]));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = exported.name;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Certificate export failed');
    }
  };
  return (
    <div className="space-y-6">
      <PageHeader
        title="SSL & Domains"
        description="Secure managed Nginx domains with Cloudflare Origin CA or public Let’s Encrypt certificates."
      />
      <Card>
        <CardContent className="grid gap-3 pt-6 md:grid-cols-[1fr_auto]">
          <div>
            <Label>VPS target</Label>
            <Select
              value={targetId}
              onChange={(event) => {
                setTargetId(event.target.value);
                setDns(null);
                setVerificationStartedAt(null);
              }}
            >
              <option value="">Select target</option>
              {targets.data?.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name} · {target.host}
                </option>
              ))}
            </Select>
          </div>
          <Button
            className="self-end"
            variant="outline"
            disabled={!targetId || list.isPending}
            onClick={() => list.mutate()}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${list.isPending ? 'animate-spin' : ''}`} />
            {list.isPending ? 'Loading…' : 'Load certificates'}
          </Button>
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-4">
        <Metric label="Certificates" value={String(certificates.length)} />
        <Metric
          label="Valid"
          value={String(certificates.filter((item) => item.daysRemaining > 0).length)}
        />
        <Metric
          label="Expiring ≤30d"
          value={String(certificates.filter((item) => item.daysRemaining <= 30).length)}
        />
        <Metric
          label="Expired"
          value={String(certificates.filter((item) => item.daysRemaining <= 0).length)}
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>New certificate</CardTitle>
          <CardDescription>
            CloudForge generates keys on the VPS, installs the certificate, validates Nginx, reloads
            safely, and keeps secrets out of the renderer.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Certificate authority">
            <Select
              value={authority}
              onChange={(event) => {
                setAuthority(event.target.value as typeof authority);
                setDns(null);
                setVerificationStartedAt(null);
              }}
            >
              <option value="cloudflare-origin-ca">
                Cloudflare Origin CA · proxied Cloudflare domains
              </option>
              <option value="letsencrypt">Let’s Encrypt · direct/public domains</option>
            </Select>
          </Field>
          <Field label="Domain">
            <Select
              value={domain}
              onChange={(event) => {
                setDomain(event.target.value);
                setDns(null);
                setVerificationStartedAt(null);
              }}
            >
              <option value="">Choose a CloudForge Nginx site</option>
              {sites.map((site) => (
                <option key={site.domain} value={site.domain}>
                  {site.domain} · {site.upstreamHost}:{site.upstreamPort}
                </option>
              ))}
            </Select>
          </Field>
          {authority === 'letsencrypt' ? (
            <Field label="Let’s Encrypt email">
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
          ) : (
            <Field label="Cloudflare credential">
              <Select
                value={cloudflareCredentialId}
                onChange={(event) => setCloudflareCredentialId(event.target.value)}
              >
                <option value="">Select Cloudflare credential</option>
                {cloudflareCredentials.map((credential) => (
                  <option key={credential.id} value={credential.id}>
                    {credential.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Certificate volume">
            <Input
              value={certificateVolume}
              onChange={(event) => setCertificateVolume(event.target.value)}
            />
          </Field>
          {authority === 'letsencrypt' ? (
            <>
              <Field label="Webroot volume">
                <Input
                  value={webrootVolume}
                  onChange={(event) => setWebrootVolume(event.target.value)}
                />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={forceRenewal} onCheckedChange={setForceRenewal} />
                Force renewal
              </label>
            </>
          ) : (
            <>
              <Field label="Private key algorithm">
                <Select
                  value={keyAlgorithm}
                  onChange={(event) => setKeyAlgorithm(event.target.value as 'rsa' | 'ecc')}
                >
                  <option value="ecc">ECDSA P-256 · recommended</option>
                  <option value="rsa">RSA 2048</option>
                </Select>
              </Field>
              <Field label="Origin certificate validity">
                <Select
                  value={String(validityDays)}
                  onChange={(event) =>
                    setValidityDays(Number(event.target.value) as typeof validityDays)
                  }
                >
                  <option value="365">1 year</option>
                  <option value="1095">3 years</option>
                  <option value="5475">15 years</option>
                </Select>
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={includeWildcard} onCheckedChange={setIncludeWildcard} />
                Also cover *.{domain || 'example.com'}
              </label>
            </>
          )}
          <div className="col-span-full flex items-center gap-3">
            <Button
              variant="outline"
              disabled={!targetId || !domain || verify.isPending}
              onClick={() => {
                setVerificationStartedAt(Date.now());
                verify.mutate();
              }}
            >
              {verify.isPending ? (
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="mr-2 h-4 w-4" />
              )}
              {verify.isPending ? 'Checking DNS…' : 'Verify DNS'}
            </Button>
            {dns && (
              <Badge
                variant={
                  dns.matches ? 'success' : dns.status === 'pending' ? 'warning' : 'destructive'
                }
              >
                {dns.matches ? (
                  <CheckCircle2 className="mr-1 h-3 w-3" />
                ) : (
                  <XCircle className="mr-1 h-3 w-3" />
                )}
                {dns.matches
                  ? 'DNS matches VPS'
                  : dns.status === 'pending'
                    ? 'Propagation pending · checking automatically'
                    : 'DNS mismatch'}
              </Badge>
            )}
            <Button
              disabled={
                !dns?.matches ||
                issue.isPending ||
                (authority === 'letsencrypt' ? !email : !cloudflareCredentialId)
              }
              onClick={() => {
                void confirm({
                  title: 'Issue and apply SSL certificate?',
                  description: `${authority === 'cloudflare-origin-ca' ? 'Create a Cloudflare Origin CA certificate' : 'Issue a Let’s Encrypt certificate'} for ${domain || 'this domain'}, update its managed Nginx configuration, validate it, and reload Nginx?`,
                  confirmLabel: 'Issue certificate',
                  destructive: false,
                }).then((confirmed) => {
                  if (confirmed) issue.mutate();
                });
              }}
            >
              Issue certificate
            </Button>
          </div>
          {dns && (
            <div className="border-border col-span-full space-y-1 rounded-md border p-3 text-sm">
              <p className="font-medium">
                {dns.provider === 'cloudflare'
                  ? `Cloudflare ${dns.proxied ? 'proxied' : 'DNS-only'} · SSL ${dns.sslMode}`
                  : 'Public DNS · direct to VPS'}
              </p>
              <p>{dns.message}</p>
              <p className="text-muted-foreground text-xs">
                Public DNS: {dns.domainIps.join(', ') || 'pending'} · Origin VPS:{' '}
                {dns.targetIps.join(', ')} · Origin certificate: {dns.certificateRequirement}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Certificates</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Domain</TableHead>
                <TableHead>Issuer</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Remaining</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Fingerprint</TableHead>
                <TableHead>Export</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {certificates.map((certificate) => (
                <TableRow key={certificate.domain}>
                  <TableCell className="font-medium">{certificate.domain}</TableCell>
                  <TableCell>{certificate.issuer}</TableCell>
                  <TableCell>{new Date(certificate.expiresAt).toLocaleDateString()}</TableCell>
                  <TableCell>{certificate.daysRemaining} days</TableCell>
                  <TableCell>{certificate.keyAlgorithm}</TableCell>
                  <TableCell className="max-w-40 truncate font-mono text-xs">
                    {certificate.fingerprint}
                  </TableCell>
                  <TableCell className="space-x-1">
                    {(['pem', 'crt', 'key', 'zip'] as const).map((format) => (
                      <Button
                        key={format}
                        size="sm"
                        variant="outline"
                        onClick={() => void exportCertificate(certificate, format)}
                      >
                        {format.toUpperCase()}
                      </Button>
                    ))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {logs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Certificate operation output</CardTitle>
          </CardHeader>
          <CardContent>
            <LogTerminal lines={logs} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-5">
        <CalendarClock className="text-muted-foreground h-5 w-5" />
        <div>
          <div className="text-muted-foreground text-xs">{label}</div>
          <div className="font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
