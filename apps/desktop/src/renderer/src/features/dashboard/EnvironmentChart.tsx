import { Card, CardContent, CardHeader, CardTitle } from '@cloudforge/ui';
import { ENVIRONMENTS, type Environment, type ProjectDto } from '@cloudforge/core';

const BAR_COLOR: Record<Environment, string> = {
  development: 'bg-primary',
  staging: 'bg-warning',
  production: 'bg-success',
};

/** Horizontal bar chart of projects grouped by environment. */
export function EnvironmentChart({ projects }: { projects: readonly ProjectDto[] }): JSX.Element {
  const counts = ENVIRONMENTS.map((environment) => ({
    environment,
    count: projects.filter((project) => project.environment === environment).length,
  }));
  const max = Math.max(1, ...counts.map((c) => c.count));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Projects by environment</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {counts.map(({ environment, count }) => (
          <div key={environment} className="flex items-center gap-3">
            <span className="text-muted-foreground w-24 shrink-0 text-sm capitalize">
              {environment}
            </span>
            <div className="bg-secondary h-2.5 flex-1 overflow-hidden rounded-full">
              <div
                className={`h-full rounded-full ${BAR_COLOR[environment]} transition-all`}
                style={{ width: `${(count / max) * 100}%` }}
                role="img"
                aria-label={`${count} ${environment} projects`}
              />
            </div>
            <span className="w-6 shrink-0 text-right text-sm font-medium tabular-nums">
              {count}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
