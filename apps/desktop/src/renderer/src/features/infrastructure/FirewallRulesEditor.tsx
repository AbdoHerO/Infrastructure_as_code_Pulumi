import { Plus, X } from 'lucide-react';
import { Button, Input, Select } from '@cloudforge/ui';
import type { FirewallRule } from '@cloudforge/core';

interface FirewallRulesEditorProps {
  rules: readonly FirewallRule[];
  onChange: (rules: FirewallRule[]) => void;
}

const PROTOCOLS: FirewallRule['protocol'][] = ['tcp', 'udp', 'icmp', 'all'];
const DIRECTIONS: FirewallRule['direction'][] = ['ingress', 'egress'];

/** Compact editor for a firewall's rule list. */
export function FirewallRulesEditor({ rules, onChange }: FirewallRulesEditorProps): JSX.Element {
  const updateRule = (index: number, patch: Partial<FirewallRule>): void => {
    onChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
  };
  const removeRule = (index: number): void => {
    onChange(rules.filter((_, i) => i !== index));
  };
  const addRule = (): void => {
    onChange([...rules, { protocol: 'tcp', port: 443, source: '0.0.0.0/0', direction: 'ingress' }]);
  };

  return (
    <div className="border-border/60 space-y-2 rounded-lg border p-3">
      <p className="text-muted-foreground text-xs font-medium">Rules</p>
      {rules.map((rule, index) => (
        <div key={index} className="flex items-center gap-2">
          <Select
            className="h-8 w-24"
            value={rule.protocol}
            onChange={(e) =>
              updateRule(index, { protocol: e.target.value as FirewallRule['protocol'] })
            }
          >
            {PROTOCOLS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
          <Input
            className="h-8 w-20"
            type="number"
            placeholder="port"
            value={rule.port ?? ''}
            onChange={(e) => updateRule(index, { port: Number(e.target.value) || undefined })}
          />
          <Input
            className="h-8 flex-1"
            placeholder="0.0.0.0/0"
            value={rule.source}
            onChange={(e) => updateRule(index, { source: e.target.value })}
          />
          <Select
            className="h-8 w-28"
            value={rule.direction}
            onChange={(e) =>
              updateRule(index, { direction: e.target.value as FirewallRule['direction'] })
            }
          >
            {DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
          <Button variant="ghost" size="icon" className="size-8" onClick={() => removeRule(index)}>
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" onClick={addRule}>
        <Plus className="size-4" /> Add rule
      </Button>
    </div>
  );
}
