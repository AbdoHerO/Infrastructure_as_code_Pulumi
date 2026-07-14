import { useMemo, useState } from 'react';
import { Download, FolderOpen, RefreshCw, Search } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  Input,
  LogTerminal,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@cloudforge/ui';
import { PageHeader } from '../../components/PageHeader.js';
import { ActivityTimeline } from '../activity/ActivityTimeline.js';
import { useActivity } from '../activity/useActivity.js';
import { openLogFolder, useLogInfo, useLogTail } from './useAppLog.js';

const CATEGORIES = ['all', 'project', 'infrastructure', 'deployment'] as const;

/** The Logs module: an activity feed and the raw application log file. */
export function LogsPage(): JSX.Element {
  return (
    <>
      <PageHeader title="Logs" description="Activity events and the raw application log." />
      <Tabs defaultValue="activity">
        <TabsList>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="app-log">Application log</TabsTrigger>
        </TabsList>
        <TabsContent value="activity">
          <ActivityTab />
        </TabsContent>
        <TabsContent value="app-log">
          <AppLogTab />
        </TabsContent>
      </Tabs>
    </>
  );
}

function ActivityTab(): JSX.Element {
  const { data: activity, isLoading } = useActivity(500);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('all');

  const filtered = useMemo(() => {
    const items = activity ?? [];
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (category !== 'all' && !item.type.startsWith(category)) return false;
      if (q && !`${item.message} ${item.type}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [activity, query, category]);

  const exportJson = (): void => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'cloudforge-activity.json';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1">
          <Search className="text-muted-foreground absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
          <Input
            className="pl-8"
            placeholder="Search events…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Select
          className="w-48"
          value={category}
          onChange={(event) => setCategory(event.target.value as (typeof CATEGORIES)[number])}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c === 'all' ? 'All categories' : c}
            </option>
          ))}
        </Select>
        <Button variant="outline" onClick={exportJson} disabled={filtered.length === 0}>
          <Download className="size-4" /> Export
        </Button>
      </div>

      <Card>
        <CardContent className="py-2">
          {isLoading ? (
            <p className="text-muted-foreground py-8 text-center text-sm">Loading…</p>
          ) : (
            <ActivityTimeline items={filtered} />
          )}
        </CardContent>
      </Card>
    </>
  );
}

function AppLogTab(): JSX.Element {
  const { data: info } = useLogInfo();
  const { data: lines, refetch, isFetching } = useLogTail(400);

  return (
    <>
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Application log file</p>
            <p className="text-muted-foreground truncate font-mono text-xs">{info?.path ?? '—'}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (info?.path) {
                  void navigator.clipboard.writeText(info.path);
                  toast.success('Log path copied');
                }
              }}
            >
              Copy path
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={`size-4 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
            </Button>
            <Button size="sm" onClick={() => void openLogFolder()}>
              <FolderOpen className="size-4" /> Open folder
            </Button>
          </div>
        </CardContent>
      </Card>

      <LogTerminal
        className="h-[60vh]"
        lines={lines ?? []}
        emptyMessage="The log is empty or hasn't been written yet."
      />
    </>
  );
}
