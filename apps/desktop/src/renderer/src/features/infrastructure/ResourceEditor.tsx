import { Trash2 } from 'lucide-react';
import { Badge, Button, Card, CardContent, Input, Label, Switch } from '@cloudforge/ui';
import type { FirewallRule, ResourceSpec } from '@cloudforge/core';
import { FirewallRulesEditor } from './FirewallRulesEditor.js';

interface ResourceEditorProps {
  resource: ResourceSpec;
  onChange: (resource: ResourceSpec) => void;
  onRemove: () => void;
}

type MutableResource = Record<string, unknown>;

/** Generic, schema-driven editor for a single resource in the plan. */
export function ResourceEditor({ resource, onChange, onRemove }: ResourceEditorProps): JSX.Element {
  const record = resource as unknown as MutableResource;

  const update = (key: string, value: unknown): void => {
    onChange({ ...record, [key]: value } as unknown as ResourceSpec);
  };

  const scalarKeys = Object.keys(record).filter(
    (key) => key !== 'kind' && key !== 'name' && key !== 'rules',
  );

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center gap-3">
          <Badge variant="secondary">{resource.kind}</Badge>
          <Input
            className="h-8 max-w-xs"
            value={resource.name}
            onChange={(event) => update('name', event.target.value)}
          />
          <Button variant="ghost" size="icon" className="ml-auto" title="Remove" onClick={onRemove}>
            <Trash2 className="size-4" />
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {scalarKeys.map((key) => {
            const value = record[key];
            if (typeof value === 'boolean') {
              return (
                <div key={key} className="flex items-center justify-between gap-3">
                  <Label className="capitalize">{humanize(key)}</Label>
                  <Switch checked={value} onCheckedChange={(checked) => update(key, checked)} />
                </div>
              );
            }
            return (
              <div key={key} className="space-y-1.5">
                <Label className="capitalize">{humanize(key)}</Label>
                <Input
                  type={typeof value === 'number' ? 'number' : 'text'}
                  value={toText(value)}
                  onChange={(event) =>
                    update(
                      key,
                      typeof value === 'number' ? Number(event.target.value) : event.target.value,
                    )
                  }
                />
              </div>
            );
          })}
        </div>

        {resource.kind === 'firewall' ? (
          <FirewallRulesEditor
            rules={resource.rules}
            onChange={(rules: FirewallRule[]) => update('rules', rules)}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function humanize(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

/** Safely render an unknown scalar as input text. */
function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}
