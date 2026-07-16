# SSL & Domains

**Manage → SSL & Domains** uses saved `VpsTarget` records and never sends SSH
secrets to the renderer.

## Choose the certificate mode

CloudForge supports two origin strategies from the same page:

- **Cloudflare Origin CA** — for orange-cloud proxied domains managed by a
  Cloudflare credential. CloudForge creates the private key and CSR on the VPS,
  requests the certificate through the Cloudflare API, installs it, validates
  and reloads Nginx, and changes the zone to **Full (strict)** with Always Use
  HTTPS. The private key never leaves the VPS.
- **Let's Encrypt** — for DNS-only or non-Cloudflare domains reached directly
  from the public internet. CloudForge uses the existing ACME webroot/Certbot
  workflow and manages renewal.

For Cloudflare Origin CA, the selected API token needs **Zone → SSL and
Certificates → Edit**, in addition to Zone/DNS Read and the Zone Settings
permissions used by verification and Full (strict). The token can be restricted
to the zones CloudForge manages.

## Before issuing a certificate

1. Select the VPS target that runs the matching Nginx site.
2. Confirm ports 80 and 443 are allowed by both the provider firewall and the
   VPS host firewall.
3. Create the domain in **Nginx** and point its upstream to the application's
   real host port.
4. Create the A/AAAA or CNAME record in **Cloudflare** or the authoritative DNS
   provider.
5. For Let's Encrypt, enter any monitored mailbox you control in **Let's Encrypt email**. It is not
   a special address issued by Let's Encrypt; it is used for ACME registration
   and important certificate notices.

**Load certificates** inventories certificates already present in the selected
certificate volume. It does not issue a new certificate. A new VPS therefore
normally shows zero until the first successful issuance.

## Cloudflare Origin CA workflow

After updating the Cloudflare token permission, no certificate work is required
in the Cloudflare dashboard:

1. select **Cloudflare Origin CA** and the stored Cloudflare credential;
2. optionally enable wildcard coverage for the selected base domain;
3. choose ECDSA P-256 or RSA 2048 and the validity period;
4. verify DNS, then select **Issue certificate**.

CloudForge generates the key and CSR through the selected `VpsTarget`, calls
Cloudflare from the Electron main process, installs the returned certificate
under the configured certificate volume, confirms that its public key matches
the private key, backs up an existing certificate, applies the Nginx site using
the normal validation/rollback transaction, and finally enables Full (strict).
Only the CSR is sent to Cloudflare. The API token, private key, and certificate
content are never sent to React.

Wildcard coverage creates SANs for the selected domain and one-level wildcard,
for example `hanoutplus.ma` and `*.hanoutplus.ma`. It does not cover a deeper
name such as `x.api.hanoutplus.ma`.

Origin CA certificates are trusted by Cloudflare, not by browsers connecting
directly to the VPS. Keep the DNS record proxied. Use Let's Encrypt when clients
must connect directly to the origin.

## Let's Encrypt safe issuance workflow

The issuance workflow is:

1. resolve the requested domain's A/AAAA records;
2. resolve the selected VPS host and require an address intersection;
3. create the configured certificate and webroot directories;
4. run the Certbot Docker image with configured domain, email, and volumes;
5. parse the issued X.509 certificate with OpenSSL;
6. enable SSL and HTTP redirect on a matching CloudForge Nginx site;
7. validate/reload Nginx through the Nginx safety transaction; and
8. persist a non-secret renewal registration and Activity entry.

DNS mismatch blocks issuance. The Certbot image, agreement flags, and webroot
mode are fixed policy, while domain, email, certificate volume, webroot volume,
and force-renewal are explicit request configuration.

The **Issue certificate** button is enabled only when the target, domain, valid
email, certificate/webroot volumes, and current DNS verification are ready.
Changing any of those values invalidates the previous verification. A
**Propagation pending** state is not a failure: CloudForge continues checking
until the configured timeout, and the button remains safely disabled meanwhile.

## Cloudflare proxy behavior

For a DNS-only record, public DNS must resolve directly to the VPS. For an
orange-cloud proxied record, public DNS correctly returns Cloudflare edge
addresses instead. CloudForge queries the Cloudflare origin record and compares
its content with the VPS while using public DNS only to verify propagation.

Cloudflare Universal SSL covers the browser-to-Cloudflare connection. With SSL
mode **Full** or **Full (strict)**, the Cloudflare-to-VPS connection also needs an
origin certificate. Prefer **Full (strict)** after the VPS certificate is
installed. Do not treat a Cloudflare edge certificate as a replacement for the
origin certificate.

The Let's Encrypt webroot workflow issues exact domains. Wildcard coverage in
the current UI is provided by Cloudflare Origin CA for proxied domains; public
Let's Encrypt wildcard certificates will require a future DNS-01 workflow.

Managed registrations are stored in Settings. The main process checks them on
startup and at the configured interval. It renews certificates at or below the
configured remaining-day threshold (default 30), reloads Nginx only after a
successful renewal, and records renewed/failed notification events in Activity.
Settings support thresholds from 1–90 days and intervals from 1–168 hours.

To verify automatic renewal, confirm the certificate appears in the certificate
table, its renewal registration is enabled in Settings, and Activity contains
the issuance record. The scheduler runs in the Electron main process; CloudForge
must run at least periodically for scheduled checks. Certbot also remains
idempotent unless **Force renewal** is explicitly enabled.

The certificate adapter also supports PEM, CRT, private-key, and compressed
archive export. Private-key export remains a deliberate privileged operation and
must never be logged or included in Activity metadata.

## Troubleshooting

- **DNS has no A or AAAA record** — create the apex/subdomain record and refresh.
- **DNS mismatch** — correct the record content or select the VPS that owns the
  expected public IP.
- **Propagation pending** — wait for the authoritative record and recursive DNS
  caches; keep CloudForge open or select **Verify DNS** again later.
- **Cloudflare proxied but mismatch is reported** — select a Cloudflare
  credential with Zone/DNS Read access so origin-aware verification can run.
- **Certbot fails** — verify public port 80, Nginx webroot routing, outbound HTTPS,
  email syntax, and Let's Encrypt rate limits in the live error details.
- **Origin CA request is denied** — update the selected token with **Zone → SSL
  and Certificates → Edit**, confirm its Zone Resources include the domain, then
  test the Cloudflare connection again.
- **Origin certificate works through Cloudflare but not by VPS IP** — expected:
  Origin CA is not a public browser trust chain. Keep the record proxied.
- **Certificate exists but HTTPS fails** — open the Nginx site, confirm its
  certificate path and SSL status, run `nginx -t` through CloudForge, then reload.
