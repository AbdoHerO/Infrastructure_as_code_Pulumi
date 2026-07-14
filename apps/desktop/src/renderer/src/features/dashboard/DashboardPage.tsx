import { BookOpen, Boxes, Cloud, Rocket, Server } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@cloudforge/ui';
import { APP } from '@cloudforge/shared';
import { PageHeader } from '../../components/PageHeader.js';
import { useProjects } from '../projects/useProjects.js';
import { ActivityTimeline } from '../activity/ActivityTimeline.js';
import { useActivity } from '../activity/useActivity.js';
import { StatCard } from './StatCard.js';
import { EnvironmentChart } from './EnvironmentChart.js';
import { useAppInfo } from './useAppInfo.js';
import { useEngineStatus } from './useEngineStatus.js';

/** The application landing dashboard: summary metrics, status and system info. */
export function DashboardPage(): JSX.Element {
  const { data: info } = useAppInfo();
  const { data: projects } = useProjects();
  const { data: engine } = useEngineStatus();
  const { data: activity } = useActivity(20);
  const projectCount = projects?.length ?? 0;

  const stats = [
    {
      label: 'Projects',
      value: projectCount,
      hint: projectCount === 0 ? 'No projects yet' : 'Managed infrastructures',
      icon: Boxes,
    },
    { label: 'Deployments', value: 0, hint: 'Nothing deployed', icon: Rocket },
    { label: 'Providers', value: 0, hint: 'Connect a provider', icon: Cloud },
    { label: 'Infrastructure', value: 0, hint: 'No resources', icon: Server },
  ];

  return (
    <>
      <PageHeader title="Dashboard" description={`${APP.subtitle} — ${APP.tagline.join(' ')}`} />

      {projectCount === 0 ? (
        <Card className="border-primary/30 bg-primary/5 mb-6">
          <CardContent className="flex flex-col items-start justify-between gap-4 py-5 sm:flex-row sm:items-center">
            <div>
              <p className="font-semibold">
                New to CloudForge? Start with the guided documentation.
              </p>
              <p className="text-muted-foreground mt-1 text-sm">
                Configure Oracle credentials, create your first project, preview it safely, and
                connect with SSH.
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" asChild>
                <Link to="/documentation?doc=getting-started">
                  <BookOpen />
                  Getting started
                </Link>
              </Button>
              <Button asChild>
                <Link to="/documentation?doc=first-instance">Create first instance</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat, index) => (
          <StatCard key={stat.label} index={index} {...stat} />
        ))}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <ActivityTimeline items={(activity ?? []).slice(0, 7)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>System</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5 text-sm">
            <InfoRow label="Version" value={info ? `v${info.version}` : '—'} />
            <InfoRow label="Platform" value={info ? `${info.platform} · ${info.arch}` : '—'} />
            <InfoRow label="Electron" value={info?.versions.electron ?? '—'} />
            <InfoRow label="Node" value={info?.versions.node ?? '—'} />
            <InfoRow label="Chrome" value={info?.versions.chrome ?? '—'} />
            <InfoRow
              label="IaC engine"
              value={engine ? (engine.available ? 'Pulumi ready' : 'Pulumi not installed') : '—'}
            />
          </CardContent>
        </Card>
      </div>

      <div className="mt-4">
        <EnvironmentChart projects={projects ?? []} />
      </div>
    </>
  );
}

function InfoRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
