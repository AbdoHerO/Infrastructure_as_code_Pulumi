# Cloudflare

CloudForge manages Cloudflare as an independent **service provider**. It is not a
cloud infrastructure provider and is never passed to Pulumi. Oracle and AWS
provisioning remain isolated from this module.

## Getting started

1. Sign in to the Cloudflare dashboard.
2. Open **My Profile → API Tokens → Create Token**.
3. Prefer a custom token with only the permissions you need.
4. In CloudForge open **Secrets → New credential → Cloudflare**.
5. Enter a name and API token. Account ID and default zone are optional.
6. Open **Cloudflare**, select the credential, and choose **Test connection**.

Create this token from the general **API Tokens** page. An R2 token created from
the R2 object-storage wizard is valid for its advertised account/R2 operations,
but it does not automatically receive Zone DNS or Zone Settings permissions.
CloudForge tests the real Account and Zone capabilities instead of relying on a
token-verification endpoint that differs between user-owned and account-owned
tokens.

The API token is encrypted by the existing credential repository. The renderer
receives only the credential ID and non-secret account data. Tokens are never
included in IPC payloads, logs, activities, diagnostics, or UI state.

## Recommended token permissions

Choose the smallest set appropriate for the features you use:

| Scope   | Permission                      | Required for                                      |
| ------- | ------------------------------- | ------------------------------------------------- |
| Account | Account Settings: Read          | Account name and identifier                       |
| Zone    | Zone: Read                      | Discover zones and plans                          |
| Zone    | DNS: Read                       | List and verify DNS records                       |
| Zone    | DNS: Edit                       | Create, edit, duplicate, and delete DNS           |
| Zone    | Zone Settings: Read             | SSL, security and cache dashboard                 |
| Zone    | Zone Settings: Edit             | SSL mode, HTTPS, TLS, Brotli and development mode |
| Zone    | SSL and Certificates: Edit      | Create Cloudflare Origin CA certificates          |
| Zone    | Cache Purge: Purge              | Purge zone cache                                  |
| Zone    | Analytics: Read                 | Traffic analytics                                 |
| Zone    | Firewall Services: Read         | WAF and managed-rule visibility                   |
| Zone    | Page Rules: Edit                | Page Rule management                              |
| Zone    | Single Redirect: Edit           | Modern Redirect Rules management                  |
| Account | Workers Scripts: Read           | Workers inventory                                 |
| Account | Workers R2 Storage: Read        | R2 bucket inventory                               |
| Account | Access: Apps and Policies: Read | Zero Trust application inventory                  |

Restrict **Zone Resources** to the zones CloudForge should manage. Add the
optional Account ID when the token can access several accounts.

For Account API Tokens, an account resource such as
`com.cloudflare.api.account.<ACCOUNT_ID>` does not by itself grant zone DNS
access. The policy must also target the zone resource (or all zones nested under
the account). The permission names must include **DNS Read** or **DNS Write**;
account permissions such as **Account DNS Settings** and **DNS View** are
different APIs.

## Dashboard and zones

The dashboard displays the account, API status, selected-zone plan, number of
zones and records, proxy count, SSL and cache modes, firewall/Page Rule counts,
and last synchronization time. The Zones tab shows status, plan, nameservers,
creation date and the zone ID.

Deleting a zone removes it from Cloudflare, not merely from CloudForge. Keep
**Settings → Cloudflare → Confirm destructive actions** enabled.

## DNS management

The DNS editor supports A, AAAA, CNAME, TXT, MX, SRV, CAA, NS, PTR, HTTPS,
TLSA, SSHFP, URI, and SVCB records. Generic Laravel, Node, Next.js, WordPress,
mail, API, subdomain, and load-balancer templates prefill the visual editor.
CloudForge validates record names, IPv4/IPv6 content, duplicates, CNAME loops,
priority, TTL bounds and proxy eligibility in the Application layer.

Examples:

| Use            | Type  | Name                          | Content            | Proxy |
| -------------- | ----- | ----------------------------- | ------------------ | ----- |
| Website        | A     | `example.com`                 | VPS public IPv4    | On    |
| API            | A     | `api.example.com`             | VPS public IPv4    | On    |
| Alias          | CNAME | `www.example.com`             | `example.com`      | On    |
| Mail exchanger | MX    | `example.com`                 | `mail.example.com` | Off   |
| Verification   | TXT   | `_acme-challenge.example.com` | provider value     | Off   |

The editor also accepts convenient relative names. `@` becomes the selected
zone apex, `www` becomes `www.example.com`, and `*.api` becomes
`*.api.example.com`. CloudForge normalizes these values in the Application layer
before duplicate validation or an API request.

TTL `1` means Cloudflare Automatic. Only A, AAAA, and CNAME records can use the
Cloudflare proxy.

### Link a domain to a CloudForge VPS

1. Obtain the instance public IP from **Infrastructure → Stack outputs**.
2. Create an apex A record: name `@`, content equal to the VPS public IPv4.
3. Create `www` as a proxied CNAME to the apex domain.
4. Create each application subdomain as an A record to the same VPS or a CNAME
   to the apex.
5. In **Nginx**, create one site per hostname and point it to that application's
   unique localhost port.
6. Use **SSL & Domains** to verify DNS and install the origin certificate.

A wildcard A record (`*`) can cover otherwise undefined subdomains, but explicit
records are clearer and can have different proxy/TTL policies. An explicit
record always takes precedence over the wildcard.

Mail records must remain DNS-only. Preserve the mail provider's MX priorities,
SPF/DKIM/DMARC TXT values, and any mail CNAME records exactly as provided. The
Cloudflare proxy supports web traffic, not SMTP/IMAP/POP ports.

Use **Refresh** after edits made outside CloudForge. Background synchronization
detects zone, DNS, SSL, firewall/security, and cache changes according to the
Cloudflare settings interval. Activity records actions and synchronization
events without tokens.

## SSL/TLS and caching

For a selected zone, CloudForge can change encryption mode, minimum TLS, TLS
1.3, HSTS, Always Use HTTPS, Automatic HTTPS Rewrites, Brotli, and Development
Mode. Cache purge removes all cached content for the selected zone.

For production origins with a valid certificate, prefer **Full (strict)**.
Flexible mode does not encrypt the Cloudflare-to-origin connection.

Cloudflare Universal SSL protects the visitor-to-Cloudflare connection for a
proxied record. It does not replace the certificate on the VPS when using Full
or Full (strict). The SSL & Domains page therefore shows whether a domain is
proxied, its Cloudflare encryption mode, and whether an origin certificate is
required or recommended. Proxied verification compares the Cloudflare origin
record with the VPS instead of incorrectly comparing Cloudflare edge IPs.

CloudForge can now create the required VPS certificate directly. In **SSL &
Domains**, select **Cloudflare Origin CA**, the Cloudflare credential, key type,
validity, and optional wildcard coverage. The main process requests an Origin CA
certificate from Cloudflare using a CSR generated on the VPS. It installs the
certificate, validates/reloads the managed Nginx site, and enables Full (strict)
and Always Use HTTPS. No certificate or private-key copy/paste is required.

The only required manual Cloudflare preparation is creating/updating the API
token so its Zone Resources include the domain and it has **SSL and
Certificates: Edit**. DNS records and the zone must already be active. CloudForge
does not require the Cloudflare dashboard's manual Origin Server certificate
wizard.

## Automatic DNS and SSL

Cloudflare preferences are stored under **Settings → Cloudflare**:

- default credential and zone;
- default TTL and proxy mode;
- propagation wait and timeout;
- background synchronization interval;
- automatic DNS creation, SSL, and HTTPS redirect;
- preferred SSL mode, delete confirmation, and activity logging.

The safe workflow is: provision the VM, obtain its public IP, create/update the
Cloudflare record, wait for DNS, issue the origin certificate, update the
CloudForge-managed Nginx site, validate Nginx, and reload. A failed DNS,
certificate, or Nginx validation stops the workflow; it does not apply a broken
configuration.

When the orange-cloud proxy is enabled, public DNS returns Cloudflare edge IPs,
not the VPS address. CloudForge uses the Cloudflare record content to verify the
origin and public DNS only to confirm propagation.

## Security, analytics, Workers, R2, and Zero Trust

Security/WAF, Workers and routes, R2 buckets, Zero Trust applications and
policies, and Gateway rules are initially read-only. Missing data normally means
the token lacks the relevant permission or the account plan does not expose that
API. DNS, supported zone settings, cache purge, Page Rules, and Redirect Rules
use explicit mutation endpoints and activity audit records.

## Troubleshooting

### Authentication failed

- Confirm the token was copied without quotes or whitespace.
- Confirm the token is active under **My Profile → API Tokens**.
- Verify Account and Zone resource restrictions include the selected zone.
- Do not use an R2 S3 Access Key ID or Secret Access Key as the Cloudflare API
  token. R2 credentials authenticate the S3-compatible endpoint, not Zone DNS.
- A burst of invalid attempts can return 429. Correct the stored credential and
  wait for Cloudflare's temporary authentication limit before testing again.

### Zone list is empty

Add Zone: Read and ensure the token includes the zone. If multiple accounts are
available, save the Account ID in the Cloudflare credential.

### DNS update is forbidden

Add DNS: Edit for the zone. DNS: Read alone permits listing but not changes.

If both listing and editing fail with `Authentication error`, recreate the token
with **Zone → DNS → Read** and **Zone → DNS → Edit**, and include the affected
zone under **Zone Resources**. A token that only has Account or R2 permissions
can still list an account or zone while DNS access remains forbidden.

### A setting is unavailable

Some settings depend on the Cloudflare plan. CloudForge reports the structured
Cloudflare API error and does not silently substitute another setting.

### Analytics or platform inventory is empty

Grant the matching read scope. CloudForge deliberately treats optional read-only
surfaces as unavailable when a token or plan does not expose them.

## Architecture

`@cloudforge/core` owns the provider-independent `ServiceProvider` and
`CloudflareProvider` ports plus `CloudflareService`. The
`@cloudforge/service-providers` package implements the HTTPS adapter. Electron's
main-process composition root injects it; typed IPC exposes use cases to React.
The adapter base URL can be overridden with `CLOUDFLARE_API_BASE_URL` for tests
or controlled network environments.
