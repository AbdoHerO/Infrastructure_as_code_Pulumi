import { Card, CardContent } from '@cloudforge/ui';
import { APP } from '@cloudforge/shared';
import { PageHeader } from '../../components/PageHeader.js';

/** Product/branding information page. */
export function AboutPage(): JSX.Element {
  return (
    <>
      <PageHeader title="About" description="Product and build information." />
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
          <div className="bg-primary text-primary-foreground shadow-glow flex size-16 items-center justify-center rounded-2xl">
            <span className="text-xl font-bold">CF</span>
          </div>
          <div>
            <h2 className="text-xl font-semibold">{APP.name}</h2>
            <p className="text-muted-foreground text-sm">{APP.subtitle}</p>
          </div>
          <div className="text-primary flex gap-2 text-sm font-medium">
            {APP.tagline.map((word) => (
              <span key={word}>{word}</span>
            ))}
          </div>
          <p className="text-muted-foreground text-xs">Version {APP.version}</p>
        </CardContent>
      </Card>
    </>
  );
}
