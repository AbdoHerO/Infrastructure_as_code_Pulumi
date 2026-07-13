import { Card, CardContent } from '@cloudforge/ui';
import type { LucideIcon } from 'lucide-react';
import { PageHeader } from './PageHeader.js';

interface PlaceholderPageProps {
  title: string;
  description: string;
  icon: LucideIcon;
  phase: string;
}

/**
 * Temporary landing surface for modules delivered in later phases. Communicates
 * scope and the phase in which the module lands, rather than showing a blank page.
 */
export function PlaceholderPage({
  title,
  description,
  icon: Icon,
  phase,
}: PlaceholderPageProps): JSX.Element {
  return (
    <>
      <PageHeader title={title} description={description} />
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <div className="bg-secondary text-muted-foreground flex size-14 items-center justify-center rounded-2xl">
            <Icon className="size-7" />
          </div>
          <div className="space-y-1">
            <p className="font-medium">{title} is on the roadmap</p>
            <p className="text-muted-foreground max-w-md text-sm">
              This module will be delivered in <span className="text-foreground">{phase}</span>. The
              navigation, routing and design system are already wired in.
            </p>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
