# Upgrading to the unified runtime model

**Nothing on any VPS changes when you upgrade.** This page explains why that is
true, what did change, and how to check it yourself.

## Why the upgrade is inert

The runtime layer acts only on a stored plan. No existing target has one, and a
target without a plan reads as `legacy` — the mode in which CloudForge inspects
and never writes. Legacy plans are `inSync` by construction: there is nothing to
drift from when nothing is claimed.

There is no database migration. The plan is versioned JSON in `Setting`. No
table changed and no column was added. Schema-version-1 JSON is normalized in
memory with empty certificate and DNS collections and legacy defaults, then is
written as schema version 2 on its next normal synchronization or save.

So on upgrade:

- No container is recreated, renamed, restarted or disconnected.
- No Docker network or volume is created or removed.
- No firewall port is opened or closed.
- No Nginx site, SSL certificate, Cloudflare record or Pulumi resource is touched.
- No Jenkins job is reconfigured by Runtime. Loading or saving a pipeline only
  reconciles CloudForge's runtime plan after the existing Jenkins workflow
  succeeds.

Normal page refreshes now reconcile successful, CloudForge-owned feature state
into the plan. This is a database-only migration: it can add applications,
routes, certificate observations, and owned DNS records to the runtime JSON,
but it does not change the corresponding external resource.

## What actually changed in behaviour

Three fixes change what the application does with an _existing_ setup. All three
make it do less, not more.

### 1. Cloudflare no longer repoints records it did not create

Previously, configuring a pipeline for a domain overwrote whatever A, AAAA or
CNAME sat at that hostname and stamped `Managed by CloudForge` on it. If the
domain already served real traffic, that traffic silently moved to the VPS.

Now a record without CloudForge's marker is only touched if it already points at
the VPS — and even then it is left exactly as it is rather than claimed. A record
pointing anywhere else is refused, naming what is there and what to do:

> `app.example.com` already has an A record pointing at `198.51.100.7`, and
> CloudForge did not create it. Repointing it at `203.0.113.10` would move live
> traffic. Either point that record at `203.0.113.10` in Cloudflare yourself, or
> delete it, then save again.

**If you have a pipeline whose domain you set up by hand, its next save will
refuse until you point the record at the VPS in Cloudflare or delete it.** Doing
either is the explicit consent that was missing. Records CloudForge created carry
the marker and continue to work untouched.

### 2. Jenkins `HOST_PORT` is now enforced

`HOST_PORT` is set from the pipeline's application port, which is also the port
the generated Nginx site proxies to. Previously a run could override it, a
Jenkins-side edit was read back as though it were the plan, and switching domain
automation off left the parameter behind.

Now it is read-only in the run form and reasserted on every read. **If you have
been relying on typing a different `HOST_PORT` at run time, that no longer
works** — and it never worked correctly, because the Nginx site kept proxying to
the original port and the domain answered 502.

A `HOST_PORT` you wrote by hand on a pipeline that never had domain automation
enabled is left alone.

### 3. The Ansible firewall task now understands nftables

The playbook previously knew only ufw, firewalld and iptables. On a host where
nftables is the real filter it drove the iptables compatibility shim, or — where
no iptables binary exists — opened nothing and reported success. The same task
now opens the port properly. This is a fix in the direction of doing what it
already claimed to do.

The profile probe had the same gap in reverse: it could report an open port as
closed. If the Ansible page has been showing a firewall state you knew was wrong,
it should now be right.

## Checking it yourself

None of this requires trusting the description above.

### Before you upgrade

Record the current state so you can compare:

```sh
docker ps --format '{{.Names}}\t{{.Ports}}' | sort > /tmp/before-containers.txt
docker network ls > /tmp/before-networks.txt
ls /etc/nginx/conf.d/
```

### After you upgrade

Open the app and use it normally. Then on the VPS:

```sh
docker ps --format '{{.Names}}\t{{.Ports}}' | sort > /tmp/after-containers.txt
diff /tmp/before-containers.txt /tmp/after-containers.txt   # expect no output
docker network ls                                            # expect no new networks
```

An empty diff is the whole claim.

### The five checks worth doing

1. **Nginx Manager** lists your existing sites, with the right upstreams.
2. **SSL** shows the correct expiry for your certificates.
3. **Containers** lists everything, with Internal / Loopback / Public port badges.
4. **Ansible** loads profile states, and the firewall column matches reality.
5. **VPS Runtime** — the new page. Select a target and press _Inspect VPS_. It
   should report `legacy` mode and no drift. **This is the point:** a page that
   can change the topology, reporting that it is not going to.

### The one that matters most

Nginx config files were unified onto a single naming scheme. Open one existing
domain in **Nginx Manager**, press **Save**, then:

```sh
ls /etc/nginx/conf.d/
```

Expect **exactly one** `cloudforge-*.conf` for that domain. Two files for the
same `server_name` means the pre-unification file was left behind and Nginx is
serving whichever it read first.

## Adopting a target, when you are ready

Nothing below is required. Legacy mode is a valid permanent choice.

1. **VPS Runtime → Inspect VPS.** Read what is there. Nothing is written.
2. **Switch to `hybrid`.** CloudForge now manages only what you explicitly adopt.
   Everything else is still untouched.
3. **Adopt one resource** from the drift table. This writes a line to the plan
   and touches the VPS not at all — Docker labels are immutable after creation,
   so adoption cannot be anything else.
4. **Preview.** Read the operations. A preview never changes anything.
5. **Apply** only if the operations are what you want. Destructive ones need the
   resource's exact name typed.

Release is the inverse of adopt and is equally inert. There is no step here that
cannot be undone by pressing the other button, up until apply — and apply shows
you exactly what it will do first.

## Rolling back the application build

Runtime topology remains isolated behind optional Application-layer ports, so
an older application build can still be installed:

```sh
git checkout main && pnpm install && pnpm build
```

There is no relational database migration to reverse. An older build does not
understand schema-version-2 certificate and DNS collections, so back up the
database before downgrading and avoid editing runtime plans from both versions.
