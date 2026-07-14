# Infrastructure Updates and Replacements

CloudForge uses the saved project/stack name and stable Pulumi logical resource
names as resource identity. Editing a property on the same logical resource asks
Pulumi and the OCI provider to update that resource. Renaming a logical resource
changes its URN and appears as create/delete unless an alias or import migration
is deliberately supplied.

## Mandatory preview approval

Apply requires a preview token bound to the exact persisted plan. Saving or
changing the plan invalidates that approval. Preview displays every resource as
Create, Update, Replace, Delete, or No change, including changed properties and
replacement properties. Replace/Delete require an additional destructive
confirmation in the UI. The Application layer enforces the token even if a UI
caller is bypassed.

## OCI compute behavior

Pulumi's OCI provider schema is the source of truth for update versus replace.
CloudForge does not add blanket `replaceOnChanges`. In particular, `metadata`,
`shape`, and supported `shapeConfig` changes are allowed to use the provider's
in-place update path. Properties reported by Pulumi as `*-replace`—commonly
identity/location/source changes such as availability domain, subnet/VNIC
placement, or image/source details—are shown as replacement before Apply.

Boot-volume size increases are generally updates; shrinking or changing source
can require replacement or be rejected by OCI. Firewall Security List rules and
tags are updates. Because provider behavior can evolve, the actual preview is
authoritative rather than this explanatory list.

CloudForge does not use `deleteBeforeReplace`; Pulumi's safe default replacement
ordering applies when the provider permits it. A replacement can still change
public IP and can lose data stored only on the boot disk, so the UI treats every
replacement as destructive. `protect`, `ignoreChanges`, aliases, and imports are
not silently inferred: they require an explicit lifecycle/import workflow so
CloudForge cannot hide drift or adopt the wrong cloud resource.
