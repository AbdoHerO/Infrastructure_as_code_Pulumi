import type { ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Label,
  Select,
  Switch,
  Textarea,
} from '@cloudforge/ui';
import type {
  AvailabilityDomain,
  ComputeResource,
  FirewallResource,
  FirewallRule,
  NetworkResource,
  ResourceSpec,
  Shape,
  SubnetResource,
  VolumeResource,
} from '@cloudforge/core';
import { FirewallRulesEditor } from './FirewallRulesEditor.js';

/** Everything a resource editor needs to offer live / cross-referenced choices. */
export interface EditorContext {
  /** Names of networks/subnets/instances in the current plan (for references). */
  readonly networks: readonly string[];
  readonly subnets: readonly string[];
  readonly instances: readonly string[];
  /** Live values from the linked provider account (empty when unavailable). */
  readonly shapes: readonly Shape[];
  readonly availabilityDomains: readonly AvailabilityDomain[];
  readonly liveLoading: boolean;
}

interface ResourceEditorProps {
  resource: ResourceSpec;
  context: EditorContext;
  onChange: (resource: ResourceSpec) => void;
  onRemove: () => void;
}

/** Curated fallbacks used when the account's live values aren't available. */
const FALLBACK_SHAPES = [
  'VM.Standard.E2.1.Micro',
  'VM.Standard.A1.Flex',
  'VM.Standard.E3.Flex',
  'VM.Standard.E4.Flex',
  'VM.Standard.E5.Flex',
];
const OS_IMAGES = [
  'ubuntu-22.04',
  'ubuntu-24.04',
  'ubuntu-20.04',
  'oracle-linux-9',
  'oracle-linux-8',
];
const OCID_OPTION = '__ocid__';

/** OCI-aware editor for a single resource, dispatching on its kind. */
export function ResourceEditor({
  resource,
  context,
  onChange,
  onRemove,
}: ResourceEditorProps): JSX.Element {
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center gap-3">
          <Badge variant="secondary">{resource.kind}</Badge>
          <Input
            className="h-8 max-w-xs"
            value={resource.name}
            onChange={(event) => onChange({ ...resource, name: event.target.value })}
          />
          <Button variant="ghost" size="icon" className="ml-auto" title="Remove" onClick={onRemove}>
            <Trash2 className="size-4" />
          </Button>
        </div>

        {resource.kind === 'network' ? (
          <NetworkFields resource={resource} onChange={onChange} />
        ) : resource.kind === 'subnet' ? (
          <SubnetFields resource={resource} context={context} onChange={onChange} />
        ) : resource.kind === 'firewall' ? (
          <FirewallFields resource={resource} context={context} onChange={onChange} />
        ) : resource.kind === 'compute' ? (
          <ComputeFields resource={resource} context={context} onChange={onChange} />
        ) : (
          <VolumeFields resource={resource} context={context} onChange={onChange} />
        )}
      </CardContent>
    </Card>
  );
}

function NetworkFields({
  resource,
  onChange,
}: {
  resource: NetworkResource;
  onChange: (r: ResourceSpec) => void;
}): JSX.Element {
  return (
    <Grid>
      <Field label="CIDR block" hint="Address range for the VCN, e.g. 10.0.0.0/16">
        <Input
          value={resource.cidrBlock}
          onChange={(event) => onChange({ ...resource, cidrBlock: event.target.value })}
        />
      </Field>
    </Grid>
  );
}

function SubnetFields({
  resource,
  context,
  onChange,
}: {
  resource: SubnetResource;
  context: EditorContext;
  onChange: (r: ResourceSpec) => void;
}): JSX.Element {
  return (
    <Grid>
      <Field label="Network">
        <RefSelect
          value={resource.networkName}
          options={context.networks}
          placeholder="Select a network…"
          onChange={(networkName) => onChange({ ...resource, networkName })}
        />
      </Field>
      <Field label="CIDR block" hint="Must sit within the network's range, e.g. 10.0.1.0/24">
        <Input
          value={resource.cidrBlock}
          onChange={(event) => onChange({ ...resource, cidrBlock: event.target.value })}
        />
      </Field>
      <ToggleField
        label="Public subnet"
        hint="Public subnets route through the internet gateway"
        checked={resource.public}
        onChange={(value) => onChange({ ...resource, public: value })}
      />
    </Grid>
  );
}

function FirewallFields({
  resource,
  context,
  onChange,
}: {
  resource: FirewallResource;
  context: EditorContext;
  onChange: (r: ResourceSpec) => void;
}): JSX.Element {
  return (
    <div className="space-y-3">
      <Grid>
        <Field label="Network">
          <RefSelect
            value={resource.networkName}
            options={context.networks}
            placeholder="Select a network…"
            onChange={(networkName) => onChange({ ...resource, networkName })}
          />
        </Field>
      </Grid>
      <FirewallRulesEditor
        rules={resource.rules}
        onChange={(rules: FirewallRule[]) => onChange({ ...resource, rules })}
      />
    </div>
  );
}

function ComputeFields({
  resource,
  context,
  onChange,
}: {
  resource: ComputeResource;
  context: EditorContext;
  onChange: (r: ResourceSpec) => void;
}): JSX.Element {
  const patch = (changes: Partial<ComputeResource>): void => onChange({ ...resource, ...changes });
  const isFlex = resource.shape.includes('Flex');
  const matched = context.shapes.find((s) => s.id === resource.shape);
  const shapeOptions = unique([
    ...context.shapes.map((s) => s.id),
    ...(context.shapes.length === 0 ? FALLBACK_SHAPES : []),
    resource.shape,
  ]);
  const usingOcid = resource.image.trim().startsWith('ocid1.image');

  return (
    <div className="space-y-3">
      <Grid>
        <Field
          label="Shape"
          hint={
            context.liveLoading
              ? 'Loading shapes from your account…'
              : context.shapes.length === 0
                ? 'Built-in list (link a provider to load your account’s shapes)'
                : matched
                  ? `${matched.ocpus ?? '?'} OCPU · ${matched.memoryGb ?? '?'} GB base`
                  : 'From your account'
          }
        >
          <Select value={resource.shape} onChange={(event) => patch({ shape: event.target.value })}>
            {shapeOptions.map((shape) => (
              <option key={shape} value={shape}>
                {shape}
              </option>
            ))}
          </Select>
        </Field>

        {isFlex ? (
          <>
            <Field label="OCPUs (vCPU)" hint="Flexible shapes only">
              <Input
                type="number"
                min={1}
                value={numText(resource.ocpus)}
                onChange={(event) => patch({ ocpus: toNumber(event.target.value) })}
              />
            </Field>
            <Field label="Memory (GB)" hint="Flexible shapes only">
              <Input
                type="number"
                min={1}
                value={numText(resource.memoryGb)}
                onChange={(event) => patch({ memoryGb: toNumber(event.target.value) })}
              />
            </Field>
          </>
        ) : null}

        <Field label="Operating system / image">
          <Select
            value={usingOcid ? OCID_OPTION : resource.image}
            onChange={(event) =>
              patch({ image: event.target.value === OCID_OPTION ? '' : event.target.value })
            }
          >
            {unique([...OS_IMAGES, ...(usingOcid ? [] : [resource.image])]).map((image) => (
              <option key={image} value={image}>
                {image}
              </option>
            ))}
            <option value={OCID_OPTION}>Custom image OCID…</option>
          </Select>
        </Field>
        {usingOcid ? (
          <Field label="Image OCID">
            <Input
              placeholder="ocid1.image.oc1..."
              value={resource.image}
              onChange={(event) => patch({ image: event.target.value })}
            />
          </Field>
        ) : null}

        <Field label="Boot volume (GB)" hint="Blank uses the image default (~47 GB)">
          <Input
            type="number"
            min={47}
            value={numText(resource.bootVolumeGb)}
            onChange={(event) => patch({ bootVolumeGb: toNumber(event.target.value) })}
          />
        </Field>

        <Field label="Subnet">
          <RefSelect
            value={resource.subnetName}
            options={context.subnets}
            placeholder="Select a subnet…"
            onChange={(subnetName) => patch({ subnetName })}
          />
        </Field>

        <Field
          label="Availability domain"
          hint={context.availabilityDomains.length === 0 ? undefined : 'From your account'}
        >
          <Select
            value={resource.availabilityDomain ?? ''}
            onChange={(event) => patch({ availabilityDomain: event.target.value })}
          >
            <option value="">Auto (first available)</option>
            {context.availabilityDomains.map((ad) => (
              <option key={ad.id} value={ad.name}>
                {ad.name}
              </option>
            ))}
            {resource.availabilityDomain &&
            !context.availabilityDomains.some((ad) => ad.name === resource.availabilityDomain) ? (
              <option value={resource.availabilityDomain}>{resource.availabilityDomain}</option>
            ) : null}
          </Select>
        </Field>

        <ToggleField
          label="Assign public IP"
          checked={resource.assignPublicIp}
          onChange={(value) => patch({ assignPublicIp: value })}
        />
      </Grid>

      <Field label="SSH public key" hint="Paste the public key used to log in (SSH-key auth)">
        <Textarea
          className="font-mono text-xs"
          rows={3}
          placeholder="ssh-rsa AAAA… or ssh-ed25519 AAAA…"
          value={resource.sshPublicKey}
          onChange={(event) => patch({ sshPublicKey: event.target.value })}
        />
      </Field>
    </div>
  );
}

function VolumeFields({
  resource,
  context,
  onChange,
}: {
  resource: VolumeResource;
  context: EditorContext;
  onChange: (r: ResourceSpec) => void;
}): JSX.Element {
  return (
    <Grid>
      <Field label="Size (GB)">
        <Input
          type="number"
          min={50}
          value={numText(resource.sizeGb)}
          onChange={(event) =>
            onChange({ ...resource, sizeGb: toNumber(event.target.value) ?? 50 })
          }
        />
      </Field>
      <Field label="Attach to instance" hint="Optional — leave as None for an unattached volume">
        <Select
          value={resource.attachTo ?? ''}
          onChange={(event) => onChange({ ...resource, attachTo: event.target.value })}
        >
          <option value="">None</option>
          {context.instances.map((instance) => (
            <option key={instance} value={instance}>
              {instance}
            </option>
          ))}
        </Select>
      </Field>
    </Grid>
  );
}

/** A reference selector that always includes the current (possibly stale) value. */
function RefSelect({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string;
  options: readonly string[];
  placeholder: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const all = unique([...(value ? [value] : []), ...options]);
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="" disabled>
        {placeholder}
      </option>
      {all.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </Select>
  );
}

function Grid({ children }: { children: ReactNode }): JSX.Element {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

function ToggleField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string | undefined;
  checked: boolean;
  onChange: (value: boolean) => void;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div>
        <Label>{label}</Label>
        {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/** Render an optional number as input text (blank when undefined). */
function numText(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

/** Parse input text to a number, treating blank as undefined. */
function toNumber(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}
