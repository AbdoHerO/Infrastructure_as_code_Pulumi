# VPS Runtime

**Manage → VPS Runtime** is the single authoritative model of what a VPS's
container topology is meant to be: its Docker networks, which services attach to
them under which aliases, which ports are published to the world versus bound to
loopback, who owns each resource, and which firewall ports the whole arrangement
needs open.

Before this existed, those facts had no home. Each feature had grown its own
partial answer — the Ansible page knew about native service ports, Jenkins knew
about `HOST_PORT`, Nginx knew about upstreams, the Firewall page knew about the
cloud security list, and the Containers page knew what was running. None of them
could see the others, so nothing in the application could answer "can this port
actually carry traffic?" or "is CloudForge allowed to touch this container?".

## The governing rule

**A resource CloudForge does not own is never drift.**

Everything else follows from that. A VPS carries containers, networks, volumes,
firewall rules and DNS records put there by people and by other tools, for
reasons this application cannot see. The runtime layer reports on them, and
refuses to change them.

## Modes

Every target has a runtime mode. A target that has never been configured has no
stored plan at all, and absence is answered with the empty legacy plan rather
than an error — the honest description of no recorded intent is a plan that
changes nothing.

| Mode      | Meaning                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------- |
| `legacy`  | Read-only. CloudForge inspects and never writes. **The default, including on upgrade.**        |
| `hybrid`  | CloudForge manages only what has been explicitly adopted. Everything else is left untouched.   |
| `managed` | CloudForge keeps the VPS matching the plan. Resources it does not own are still never touched. |

Upgrading to this release changes nothing on any VPS. Every existing target
reads as `legacy` because it has no stored plan, and legacy mode is always
`inSync` by construction — there is nothing to drift from when nothing is
claimed.

## Ownership and adoption

Ownership is read from Docker labels, which CloudForge stamps on resources it
creates. A resource without them is `unmanaged`.

**Adoption is a plan edit, not an operation on the VPS.** This is not a
convenience — it is forced by Docker. Labels are immutable after creation: there
is no `docker network update` at all, and `docker container update` does not
touch labels. The only way to relabel a network is to destroy and recreate it,
disconnecting every container on it. So adopting records in the plan that
CloudForge owns a resource, and touches the VPS not at all.

Adoption requires the resource to exist. Releasing is its inverse and is equally
inert.

## Preview and apply

`apply` is the only channel in the module that changes a VPS, and it cannot be
called on its own:

1. `preview` reads live state, works out the operations, and mints a token bound
   to a fingerprint of that exact change.
2. `apply` sends the token back. The main process re-derives the change from live
   state and refuses a token whose fingerprint no longer matches — so a VPS that
   moved between preview and apply cannot be acted on with stale intent.
3. Blockers refuse the apply outright. Destructive operations additionally
   require the resource's exact name, typed.
4. The token is spent either way.

### What CloudForge does and does not do

It does not create, restart or remove containers. Containers belong to Compose
and to Jenkins. What the runtime layer owns is the topology _around_ them —
networks, attachments and aliases. Where a change genuinely requires a container
to be recreated, the operation is `manual`: it is reported, explained, and not
performed.

`network.remove` deliberately carries no `--force`. Docker's own refusal to
delete a network that is in use is a safety net worth keeping.

## Firewalls

A port carries traffic only when the VPS's own firewall **and** the cloud
provider's security list allow it. Those were previously edited on different
screens with nothing relating them, so "the port is open" was a claim neither
screen could actually make.

Requirements come from three places and are merged into one list:

- The plan's services, for ports published to the world. A `host-loopback` port
  is reachable from the VPS itself and nowhere else; no firewall rule can change
  that and none is asked for.
- The plan's routes. Port 80 is required even when every route is HTTPS, because
  ACME's HTTP-01 challenge needs it.
- Natively installed Ansible profiles, read from what is actually running. A
  Jenkins on 8080 is the same kind of fact to a firewall as a Compose service on 8080.

SSH is never included. CloudForge is talking to the VPS over SSH; if that port
were shut, nothing here would be running.

`unknown` is a first-class answer. A firewall that could not be read is not the
same as a host with no firewall, and reporting the second when the first is true
would tell a user their port is reachable when it is not.

Opening is additive and idempotent. There is no counterpart that closes what the
plan stopped needing — a port CloudForge did not open is not its to close.

## Where the shell lives

Every line of firewall shell is generated by
`packages/deployment/src/host-firewall-script.ts` and nowhere else. There were
five drifted copies before: only one knew nftables existed, only one could read a
rule back, none could close a port, and the marker comment differed between the
writer and the reader — so CloudForge could add a rule and then fail to recognise
it as its own.

nftables is detected before iptables, because on a modern distro `iptables` is
usually a compatibility shim over nftables, and driving the shim while reading
the real table is how rules appear to vanish.

## Related modules

| Module            | What the runtime model changed                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ansible           | Profiles declare their ports, so the rest of the system can see a native service. The playbook and the probe share the one firewall implementation.                                                                                                                             |
| Jenkins Pipelines | `HOST_PORT` is a parameter CloudForge owns. See [JENKINS-PIPELINES.md](JENKINS-PIPELINES.md).                                                                                                                                                                                   |
| Nginx             | A route's reachability is validated against the plan's proxy mode: a host-based Nginx cannot resolve a container name, so such a route is rejected rather than 502. A containerised proxy can now be edited, validated and reloaded — see [NGINX-MANAGER.md](NGINX-MANAGER.md). |
| Cloudflare        | A DNS record CloudForge did not create is never repointed. See [CLOUDFLARE.md](CLOUDFLARE.md).                                                                                                                                                                                  |
| Firewall          | Provider security-list rules can be passed into the connectivity check, which respects direction, CIDR, port range and protocol.                                                                                                                                                |

## Security

The renderer names a target and an intent. It never sends a command string, an
SSH credential, a host key or a private key, and never receives one. Docker
management runs through verified SSH with a pinned host fingerprint; there is no
unauthenticated Docker TCP socket. Plans hold topology, never secrets — the
validator rejects a label whose key looks like a credential.
