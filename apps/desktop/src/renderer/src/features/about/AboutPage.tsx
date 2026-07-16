import { Link } from 'react-router-dom';
import {
  BookOpen,
  Check,
  ClipboardCopy,
  ExternalLink,
  FileText,
  Github,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, toast } from '@cloudforge/ui';
import { APP } from '@cloudforge/shared';
import iconUrl from '@desktop-build/icon.png';
import { PageHeader } from '../../components/PageHeader.js';
import { invoke } from '../../lib/ipc.js';
import { useAppInfo } from '../dashboard/useAppInfo.js';

const CAPABILITIES = [
  'Oracle Cloud',
  'AWS',
  'Pulumi',
  'SSH',
  'Ansible',
  'Docker',
  'Nginx',
  'Firewall',
  'SSL',
  'Cloudflare',
  'Jenkins',
];

const WORKFLOW_GUIDES = [
  { label: 'Cloudflare & DNS', doc: 'cloudflare' },
  { label: 'Jenkins Pipelines', doc: 'jenkins-pipelines' },
  { label: 'SSL & Domains', doc: 'ssl-domains' },
  { label: 'Ansible & VPS', doc: 'ansible' },
] as const;

export function AboutPage(): JSX.Element {
  const { data: info, isLoading } = useAppInfo();

  const openExternal = async (link: 'github' | 'releases'): Promise<void> => {
    try {
      await invoke('app:openExternal', { link });
    } catch (error) {
      toast.error('Could not open the browser', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const copyDiagnostics = async (): Promise<void> => {
    try {
      await invoke('app:copyDiagnostics', undefined);
      toast.success('Diagnostic information copied', {
        description: 'No credentials or project data are included.',
      });
    } catch (error) {
      toast.error('Could not copy diagnostics', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <>
      <PageHeader title="About" description="Product, build, and system information." />
      <Card className="overflow-hidden">
        <div className="from-primary/10 via-background to-background border-border border-b bg-gradient-to-br px-8 py-10">
          <div className="flex flex-col items-start gap-6 sm:flex-row sm:items-center">
            <img src={iconUrl} alt="CloudForge" className="size-24 rounded-2xl shadow-lg" />
            <div className="min-w-0">
              <h1 className="text-3xl font-bold tracking-tight">{APP.name}</h1>
              <p className="text-muted-foreground mt-1 text-base">{APP.subtitle}</p>
              <p className="text-primary mt-3 text-sm font-medium">
                Provision • Configure • Deploy • Monitor • Secure
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Badge variant="success">
                  Version {info?.version ?? (isLoading ? 'Loading…' : '—')}
                </Badge>
                <Badge variant="outline">Build {info?.build.number ?? '—'}</Badge>
                {info?.packaged ? (
                  <Badge variant="secondary">Production</Badge>
                ) : (
                  <Badge variant="warning">Development</Badge>
                )}
              </div>
            </div>
          </div>
        </div>
        <CardContent className="grid gap-8 px-8 py-8 lg:grid-cols-[1.2fr_1fr]">
          <div>
            <h2 className="text-lg font-semibold">Modern infrastructure, one desktop</h2>
            <p className="text-muted-foreground mt-2 max-w-2xl text-sm leading-6">
              CloudForge lets DevOps engineers provision cloud infrastructure, configure Linux
              services, manage DNS and TLS, and run application delivery pipelines from one
              local-first desktop application.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {CAPABILITIES.map((capability) => (
                <Badge key={capability} variant="secondary">
                  <Check className="size-3" />
                  {capability}
                </Badge>
              ))}
            </div>
            <div className="mt-7 grid gap-2 sm:grid-cols-2">
              <Button asChild>
                <Link to="/documentation">
                  <BookOpen />
                  Open documentation
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link to="/updates">
                  <RefreshCw />
                  Check for updates
                </Link>
              </Button>
              <Button variant="outline" onClick={() => void openExternal('releases')}>
                <FileText />
                Release notes
                <ExternalLink />
              </Button>
              <Button variant="outline" onClick={() => void openExternal('github')}>
                <Github />
                GitHub
                <ExternalLink />
              </Button>
              <Button variant="outline" asChild>
                <Link to="/documentation?doc=privacy">
                  <ShieldCheck />
                  Privacy
                </Link>
              </Button>
              <Button variant="outline" onClick={() => void copyDiagnostics()}>
                <ClipboardCopy />
                Copy diagnostics
              </Button>
            </div>
            <div className="border-border mt-7 border-t pt-5">
              <h3 className="text-sm font-semibold">Operational guides</h3>
              <p className="text-muted-foreground mt-1 text-xs">
                Offline, version-matched instructions bundled with this installation.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {WORKFLOW_GUIDES.map((guide) => (
                  <Button key={guide.doc} variant="outline" size="sm" asChild>
                    <Link to={`/documentation?doc=${guide.doc}`}>{guide.label}</Link>
                  </Button>
                ))}
              </div>
            </div>
          </div>

          <section aria-labelledby="system-information">
            <h2 id="system-information" className="text-lg font-semibold">
              System information
            </h2>
            <div className="border-border mt-3 overflow-hidden rounded-lg border">
              <InfoRow label="Version" value={info?.version} />
              <InfoRow label="Build" value={info?.build.number} />
              <InfoRow label="Git commit" value={info?.build.commit} mono />
              <InfoRow label="Built" value={formatDate(info?.build.builtAt)} />
              <InfoRow label="Electron" value={info?.versions.electron} />
              <InfoRow label="Node" value={info?.versions.node} />
              <InfoRow label="Chrome" value={info?.versions.chrome} />
              <InfoRow
                label="Operating system"
                value={info ? `${info.os.type} ${info.os.release}` : undefined}
              />
              <InfoRow label="Architecture" value={info?.arch} />
              <InfoRow label="Locale" value={info?.locale} last />
            </div>
            <p className="text-muted-foreground mt-3 text-xs">
              Diagnostics contain technical build details only. Credentials, secrets, and
              infrastructure data are never copied.
            </p>
          </section>
        </CardContent>
      </Card>
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Product information</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="text-muted-foreground">Copyright © 2026 CloudForge. All rights reserved.</p>
          <div className="flex gap-2">
            <Button variant="link" size="sm" asChild>
              <Link to="/documentation?doc=license">License</Link>
            </Button>
            <Button variant="link" size="sm" asChild>
              <Link to="/documentation?doc=privacy">Privacy</Link>
            </Button>
            <Button variant="link" size="sm" onClick={() => void openExternal('github')}>
              Repository
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function InfoRow({
  label,
  value,
  mono = false,
  last = false,
}: {
  label: string;
  value: string | undefined;
  mono?: boolean;
  last?: boolean;
}): JSX.Element {
  return (
    <div
      className={`flex items-center justify-between gap-4 px-3 py-2.5 text-xs ${last ? '' : 'border-border border-b'}`}
    >
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono' : 'font-medium'}>{value ?? '—'}</span>
    </div>
  );
}

function formatDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
