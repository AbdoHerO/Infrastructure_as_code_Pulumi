# Firewall Manager

**Manage → Firewall** loads the firewall attached to a live compute instance and
updates it in place through a provider capability. Presentation code never calls
OCI directly. `CloudProvider` exposes the optional provider-independent
`getInstanceFirewall` and `updateInstanceFirewall` capabilities; Oracle maps them
to OCI VNIC, subnet, and Security List APIs, and AWS maps them to the instance's
security groups. Azure NSGs and OCI NSGs can implement the same capability later.

The page shows instance status, subnet, public/private IPs, live rules, local
changes, protocol/direction/CIDR/port/stateless fields, and common service
templates. Validation rejects malformed CIDRs, invalid ranges, and duplicate
identifiers. It warns about duplicate rules and SSH/all-traffic exposure to the
world. Applying uses OCI `PUT securityLists/{id}`, or on AWS adds, edits and removes
individual security group rules, and never recreates the subnet or compute instance.

On AWS, rules are always stateful, and a rule naming another security group is not
shown and never touched. New rules go to the instance's first security group.

Each successful change writes a before/after snapshot to Activity history. This
is the audit source for who/when/what; no provider credentials are included.

OCI currently attaches the first subnet Security List exposed by the instance's
primary attached VNIC. A future NSG implementation must present each attachment
explicitly instead of silently merging different rule owners.
