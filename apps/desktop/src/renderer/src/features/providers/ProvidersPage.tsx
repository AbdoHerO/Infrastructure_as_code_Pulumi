import { Link } from 'react-router-dom';
import { Cloud } from 'lucide-react';
import { Button, Card, CardContent } from '@cloudforge/ui';
import { PageHeader } from '../../components/PageHeader.js';
import { ProviderCard } from './ProviderCard.js';
import { useProviderCredentials } from './useProviders.js';

/** The Cloud Providers module: test connections and discover resources. */
export function ProvidersPage(): JSX.Element {
  const { data: providers, isLoading } = useProviderCredentials();

  return (
    <>
      <PageHeader
        title="Cloud Providers"
        description="Test connections and discover regions and shapes."
        actions={
          <Button asChild variant="outline">
            <Link to="/secrets">Manage credentials</Link>
          </Button>
        }
      />

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading providers…</p>
      ) : !providers || providers.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="bg-secondary text-muted-foreground flex size-14 items-center justify-center rounded-2xl">
              <Cloud className="size-7" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">No cloud providers connected</p>
              <p className="text-muted-foreground text-sm">
                Add an Oracle Cloud (or other provider) credential to get started.
              </p>
            </div>
            <Button asChild>
              <Link to="/secrets">Add credential</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {providers.map((credential) => (
            <ProviderCard key={credential.id} credential={credential} />
          ))}
        </div>
      )}
    </>
  );
}
