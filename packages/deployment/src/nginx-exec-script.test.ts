import { describe, expect, it } from 'vitest';
import {
  MOUNT_PROBE,
  nginxExecPreamble,
  reloadScript,
  restoreScript,
} from './nginx-exec-script.js';
import { parsesAsShell } from './shell-syntax.test-helper.js';

describe('shell syntax', () => {
  // Guard the guard: without a working `sh` these would pass by never being able
  // to fail.
  it('has a working shell to check against', () => {
    expect(parsesAsShell('echo hello')).toBe(true);
    expect(parsesAsShell('if [ 1 ]; then')).toBe(false);
  });

  it.each([
    ['preamble', nginxExecPreamble()],
    ['restore', restoreScript("'/tmp/backup.tar.gz'")],
    ['reload', reloadScript()],
    ['the whole transaction', `set -e\n${nginxExecPreamble()}\n${reloadScript()}`],
  ])('generates a script that parses: %s', (_name, script) => {
    expect(parsesAsShell(script)).toBe(true);
  });
});

describe('nginxExecPreamble', () => {
  it('prefers a native binary, so existing hosts behave exactly as before', () => {
    // The container branch is reachable only when there is no native nginx. This
    // also matches what the status probe reports, and two parts of the app
    // describing the same host differently is its own bug.
    const script = nginxExecPreamble();

    expect(script).toContain('if ! command -v nginx >/dev/null 2>&1; then');
    expect(script.indexOf('command -v nginx')).toBeLessThan(script.indexOf('docker ps'));
  });

  it('runs nginx inside the container when there is no native binary', () => {
    expect(nginxExecPreamble()).toContain('docker exec "$cf_proxy" nginx "$@"');
  });

  it('reloads the container that is actually serving', () => {
    // `systemctl reload nginx` on a host whose nginx is a container reloads
    // nothing, or fails — either way the new config never takes effect.
    expect(nginxExecPreamble()).toContain('docker exec "$cf_proxy" nginx -s reload');
  });

  it('proves the container shares the host directory before trusting it', () => {
    // A container with its own baked-in /etc/nginx validates a config that has
    // nothing to do with the one just written, and reports success — which looks
    // exactly like it worked.
    const script = nginxExecPreamble();

    expect(script).toContain(`: > '${MOUNT_PROBE}'`);
    expect(script).toContain(`docker exec "$cf_proxy" test -f '${MOUNT_PROBE}'`);
    expect(script).toContain('does not share this host');
  });

  it('leaves no probe file behind on either path', () => {
    const script = nginxExecPreamble();
    const removals = script.split(`rm -f '${MOUNT_PROBE}'`).length - 1;

    // Once on the failure path, once on the success path.
    expect(removals).toBe(2);
  });

  it('hides the probe from nginx include globs', () => {
    // conf.d/*.conf never matches a dotfile, so an interrupted run cannot leave
    // something behind that nginx then tries to parse.
    expect(MOUNT_PROBE.split('/').pop()?.startsWith('.')).toBe(true);
    expect(MOUNT_PROBE.endsWith('.conf')).toBe(false);
  });

  it('refuses rather than guesses when there is nothing to edit', () => {
    const script = nginxExecPreamble();

    expect(script).toContain('[ -d /etc/nginx ] ||');
    expect(script).toContain('no running Nginx container was found');
  });
});

describe('restoreScript', () => {
  it('never removes the directory itself', () => {
    // The whole point. `rm -rf /etc/nginx` strands a bind mount on a deleted
    // inode: the restore lands in a new directory the container cannot see, and
    // it keeps serving the config that was just rolled back.
    const script = restoreScript("'/tmp/backup.tar.gz'");

    expect(script).not.toContain('rm -rf /etc/nginx');
    expect(script).toContain('find /etc/nginx -mindepth 1 -delete');
  });

  it('empties before extracting, so a rolled-back file cannot survive', () => {
    // Extraction alone leaves anything added since the archive was taken —
    // including the file whose failed validation caused the rollback.
    const script = restoreScript("'/tmp/backup.tar.gz'");

    expect(script.indexOf('-delete')).toBeLessThan(script.indexOf('tar -xzf'));
  });

  it('extracts the archive it is given', () => {
    expect(restoreScript("'/tmp/backup.tar.gz'")).toContain("tar -xzf '/tmp/backup.tar.gz' -C /");
  });
});

describe('reloadScript', () => {
  it('validates through the same indirection it reloads through', () => {
    // Validating with a native binary while a container serves the config is the
    // same class of mistake as reading nftables through the iptables shim.
    const script = reloadScript();

    expect(script).toContain('cf_nginx -t');
    expect(script).toContain('cf_nginx_reload');
    expect(script).not.toMatch(/(?<!cf_)\bnginx -t\b/);
  });

  it('records a failed reload rather than leaving the last success showing', () => {
    const script = reloadScript();

    expect(script).toContain('echo 0 > /var/lib/cloudforge/nginx/last-reload-ok');
    expect(script).toContain('echo 1 > /var/lib/cloudforge/nginx/last-reload-ok');
  });

  it('does not reload a configuration that failed to validate', () => {
    const script = reloadScript();

    expect(script.indexOf('cf_nginx -t')).toBeLessThan(script.indexOf('cf_nginx_reload'));
  });
});
