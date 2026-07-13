import { Boxes, Cloud, Rocket, Server } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@cloudforge/ui';
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
            <InfoRow label="Version" value={`v${info?.version ?? APP.version}`} />
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
