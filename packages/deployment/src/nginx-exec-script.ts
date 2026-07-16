/**
 * How to run Nginx on a host, whether it is installed natively or serving from a
 * container.
 *
 * The status probe has always been able to see a containerised Nginx. Everything
 * that *changes* a config refused it outright — `command -v nginx || exit 1` —
 * so a VPS whose proxy runs in Docker could be inspected and never edited.
 *
 * Pure string builders, so the shell is testable without a VPS. Every script is
 * POSIX `sh`, not bash.
 */

/**
 * A file written on the host and then looked for inside the container.
 *
 * Editing `/etc/nginx` only means anything if the container serving those files
 * reads the same directory. A container with its own baked-in `/etc/nginx` will
 * cheerfully validate a config that has nothing to do with the one just written
 * and report success — the worst possible outcome, because it looks like it
 * worked. This proves the two are one directory before anything is trusted.
 *
 * A dotfile, so that Nginx's own `conf.d/*.conf` includes can never pick it up
 * even if it is left behind by an interrupted run.
 */
export const MOUNT_PROBE = '/etc/nginx/.cloudforge-mount-probe';

/**
 * Work out how to run Nginx, and refuse rather than guess.
 *
 * Native wins when both exist. That is not a preference — it is what the status
 * probe already reports, and disagreeing with it would mean two parts of the app
 * describing the same host differently. It also means every existing native
 * install behaves exactly as it did before this file existed: the container
 * branch is reachable only when there is no native binary at all.
 *
 * Defines `cf_nginx`, to run Nginx, and `cf_nginx_reload`, to reload the running
 * server, so no caller repeats the branch.
 */
export function nginxExecPreamble(): string {
  return `[ -d /etc/nginx ] || { echo 'There is no /etc/nginx on this host, so there is no host-managed Nginx configuration to edit.' >&2; exit 1; }
cf_proxy=''
if ! command -v nginx >/dev/null 2>&1; then
  if command -v docker >/dev/null 2>&1; then
    cf_proxy=$(docker ps --filter ancestor=nginx --format '{{.Names}}' | head -n1 || true)
  fi
  [ -n "$cf_proxy" ] || { echo 'Nginx is not installed on this host, and no running Nginx container was found.' >&2; exit 1; }
  : > '${MOUNT_PROBE}'
  if ! docker exec "$cf_proxy" test -f '${MOUNT_PROBE}' 2>/dev/null; then
    rm -f '${MOUNT_PROBE}'
    echo "The Nginx container $cf_proxy does not share this host's /etc/nginx, so editing these files would not change what it serves." >&2
    exit 1
  fi
  rm -f '${MOUNT_PROBE}'
fi
cf_nginx() {
  if [ -n "$cf_proxy" ]; then docker exec "$cf_proxy" nginx "$@"; else nginx "$@"; fi
}
cf_nginx_reload() {
  if [ -n "$cf_proxy" ]; then docker exec "$cf_proxy" nginx -s reload
  elif command -v systemctl >/dev/null 2>&1; then systemctl reload nginx
  else nginx -s reload
  fi
}`;
}

/**
 * Put `/etc/nginx` back exactly as an archive has it, without replacing the
 * directory itself.
 *
 * `rm -rf /etc/nginx` is simpler and is what this used to do. It is also wrong
 * the moment the directory is bind-mounted into a container: removing the
 * directory strands the container's mount on a deleted inode, so the restore
 * lands in a *new* directory the container cannot see, and it keeps serving the
 * very config that was just rolled back — until someone restarts it and finds
 * out. Emptying the directory in place keeps the inode, so the container sees the
 * restore at once.
 *
 * Emptying first rather than extracting over the top, because extraction alone
 * leaves behind anything added since the archive was taken — including the file
 * whose failed validation caused the rollback.
 *
 * `find -delete` implies `-depth`, so children go before their parents and
 * `-mindepth 1` spares `/etc/nginx` itself.
 */
export function restoreScript(quotedArchive: string): string {
  return `find /etc/nginx -mindepth 1 -delete
tar -xzf ${quotedArchive} -C /`;
}

/**
 * Validate, then reload, then record what happened.
 *
 * Requires `nginxExecPreamble` to have run. The timestamp and outcome are written
 * either way, so the status card can report a reload that failed instead of
 * showing the last one that worked and implying all is well.
 */
export function reloadScript(): string {
  return `mkdir -p /var/lib/cloudforge/nginx
if ! cf_nginx -t; then date -u +%Y-%m-%dT%H:%M:%SZ > /var/lib/cloudforge/nginx/last-reload-at; echo 0 > /var/lib/cloudforge/nginx/last-reload-ok; exit 1; fi
cf_nginx_reload
date -u +%Y-%m-%dT%H:%M:%SZ > /var/lib/cloudforge/nginx/last-reload-at
echo 1 > /var/lib/cloudforge/nginx/last-reload-ok`;
}
