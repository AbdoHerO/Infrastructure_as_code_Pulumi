# SSL & Domains

**Manage → SSL & Domains** uses saved `VpsTarget` records and never sends SSH
secrets to the renderer. The issuance workflow is:

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

The webroot workflow issues exact domains. Wildcard certificates require DNS-01
and are rejected with an explicit message until a DNS-provider adapter is
configured; existing wildcard certificates are still discovered and displayed.

Managed registrations are stored in Settings. The main process checks them on
startup and at the configured interval. It renews certificates at or below the
configured remaining-day threshold (default 30), reloads Nginx only after a
successful renewal, and records renewed/failed notification events in Activity.
Settings support thresholds from 1–90 days and intervals from 1–168 hours.

The certificate adapter also supports PEM, CRT, private-key, and compressed
archive export. Private-key export remains a deliberate privileged operation and
must never be logged or included in Activity metadata.
