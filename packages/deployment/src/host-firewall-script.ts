/**
 * The one place that knows how to talk to a Linux host firewall.
 *
 * There were five copies of this shell before — in the Jenkins playbook, the
 * Ansible port probe, the certificate manager, the preflight check and the
 * bootstrap template — and they had drifted. Only preflight knew nftables
 * existed; only the probe could read a rule back; none could close a port; and
 * the marker comment differed between the writer and the reader, so a rule
 * CloudForge added could not always be recognised as its own.
 *
 * These are pure string builders so the shell can be tested without a VPS —
 * which is the only way it ever gets tested at all.
 *
 * Every generated script is POSIX `sh`, not bash: the target may be Alpine, and
 * `/bin/sh` there is not bash.
 */

/**
 * The comment stamped on every rule CloudForge adds, where the backend supports
 * comments at all.
 *
 * Exported and used by both the writer and the reader. Their two copies of this
 * string had already diverged once, which meant CloudForge could add a rule and
 * then fail to recognise it.
 */
export const FIREWALL_MARKER = 'CloudForge managed service';

const NFT_TABLE = 'cloudforge';
const NFT_CHAIN = 'input';

export interface FirewallPort {
  readonly port: number;
  readonly protocol: 'tcp' | 'udp';
}

/**
 * Reject anything that is not a plain port number.
 *
 * The callers all pass numbers from validated models, so this should never fire.
 * It exists because every one of these values is interpolated into a shell
 * command, and "should never" is not a security control.
 */
export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function assertPorts(ports: readonly FirewallPort[]): void {
  for (const entry of ports) {
    if (!isValidPort(entry.port)) throw new Error(`Invalid port ${String(entry.port)}`);
    if (entry.protocol !== 'tcp' && entry.protocol !== 'udp')
      throw new Error(`Invalid protocol ${String(entry.protocol)}`);
  }
}

/**
 * Decide which backend is in charge.
 *
 * The order matters and is not arbitrary: a host can have several of these
 * installed at once, and the one that actually filters traffic is the one that
 * is *running*. `ufw` and `firewalld` are checked for activity, not mere
 * presence — a Debian box ships `ufw` inactive by default, and treating that as
 * "the firewall" would make CloudForge report a port as blocked when nothing is
 * blocking it.
 *
 * nftables is checked before iptables because on a modern distro `iptables` is
 * usually a compatibility shim over nftables. Driving the shim while reading the
 * real table is how rules appear to vanish.
 *
 * `sudo` prefixes the commands that need root. Most callers leave it empty
 * because `runPrivilegedScript` already runs the whole script as root. The
 * Ansible profile probe cannot: it is one unprivileged command that escalates
 * per call, so it passes its own `'$S '` — a shell variable it sets to `sudo -n`
 * or to nothing. Reading a firewall needs root on every backend, and an
 * unprivileged `ufw status` fails in a way that looks exactly like "no firewall".
 */
export function detectBackendScript(sudo = ''): string {
  return `if command -v ufw >/dev/null 2>&1 && ${sudo}ufw status 2>/dev/null | grep -q '^Status: active'; then
  printf ufw
elif command -v firewall-cmd >/dev/null 2>&1 && ${sudo}systemctl is-active --quiet firewalld 2>/dev/null; then
  printf firewalld
elif command -v nft >/dev/null 2>&1 && ${sudo}nft list ruleset >/dev/null 2>&1; then
  printf nftables
elif command -v iptables >/dev/null 2>&1 && ${sudo}iptables -S >/dev/null 2>&1; then
  printf iptables
elif command -v ufw >/dev/null 2>&1 || command -v firewall-cmd >/dev/null 2>&1; then
  printf none
else
  printf unknown
fi`;
}

/**
 * Persist iptables rules, which are otherwise lost on reboot.
 *
 * ufw, firewalld and nftables persist their own rules. Raw iptables does not,
 * and a firewall rule that disappears on reboot is worse than one that was never
 * added: it works until the machine restarts at 3am.
 */
function persistIptables(): string {
  return `if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save >/dev/null 2>&1
elif [ -d /etc/iptables ]; then iptables-save > /etc/iptables/rules.v4
elif [ -d /etc/sysconfig ]; then iptables-save > /etc/sysconfig/iptables
fi`;
}

/** Ensure CloudForge's own nftables table and chain exist. Idempotent. */
function nftEnsureChain(): string {
  // A low priority and an `accept` policy: this chain adds permissions and must
  // never become the thing that blocks traffic. It sits alongside whatever else
  // is on the host rather than trying to own the ruleset.
  return `nft list table inet ${NFT_TABLE} >/dev/null 2>&1 || nft add table inet ${NFT_TABLE}
nft list chain inet ${NFT_TABLE} ${NFT_CHAIN} >/dev/null 2>&1 || nft add chain inet ${NFT_TABLE} ${NFT_CHAIN} '{ type filter hook input priority 0 ; policy accept ; }'`;
}

/**
 * Open ports. Idempotent, additive, and never removes anything.
 *
 * Prints `changed` if it altered the firewall and `unchanged` if every port was
 * already open — so a caller can tell a no-op from real work, and Activity does
 * not claim a change that did not happen.
 */
export function openPortsScript(ports: readonly FirewallPort[]): string {
  assertPorts(ports);
  const calls = ports.map((p) => `cloudforge_open ${String(p.port)} ${p.protocol}`).join('\n');
  return `${openPortsPreamble()}
${calls}
${persistIfChanged()}
if [ "$changed" = 1 ]; then printf changed; else printf unchanged; fi`;
}

/**
 * Everything `openPortsScript` needs before the first port: `$changed`,
 * `$backend`, and the `cloudforge_open` function itself.
 *
 * Exported for the one caller that cannot use `openPortsScript` — the Ansible
 * playbook, whose port is a Jinja expression (`{{ service_port }}`) that does not
 * exist yet when this string is built, so there is no number to hand in. It emits
 * its own `cloudforge_open "{{ service_port }}" tcp` instead. The playbook's
 * value is validated as an integer before it is ever rendered, so nothing
 * unchecked reaches the shell.
 */
export function openPortsPreamble(): string {
  return `changed=0
backend=$(${detectBackendScript()})
cloudforge_open() {
  port="$1"; proto="$2"
  case "$backend" in
    ufw)
      ufw status 2>/dev/null | grep -Eq "(^|[[:space:]])$port/$proto[[:space:]].*ALLOW" || { ufw allow "$port/$proto" >/dev/null 2>&1 && changed=1; }
      ;;
    firewalld)
      firewall-cmd --quiet --query-port="$port/$proto" 2>/dev/null || { firewall-cmd --permanent --add-port="$port/$proto" >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1 && changed=1; }
      ;;
    nftables)
      ${nftEnsureChain().split('\n').join('\n      ')}
      nft list chain inet ${NFT_TABLE} ${NFT_CHAIN} 2>/dev/null | grep -q "$proto dport $port accept" || { nft add rule inet ${NFT_TABLE} ${NFT_CHAIN} "$proto" dport "$port" accept comment '"${FIREWALL_MARKER}"' >/dev/null 2>&1 && changed=1; }
      ;;
    iptables)
      iptables -C INPUT -p "$proto" --dport "$port" -m comment --comment '${FIREWALL_MARKER}' -j ACCEPT 2>/dev/null || { iptables -I INPUT 1 -p "$proto" --dport "$port" -m comment --comment '${FIREWALL_MARKER}' -j ACCEPT && changed=1; }
      ;;
  esac
}`;
}

/**
 * Persist the rules, but only if something was added and only on iptables.
 *
 * Split out of `openPortsScript` so the Ansible playbook, which emits its own
 * `cloudforge_open` call rather than one this module generated, cannot forget the
 * step and leave behind a rule that works until the host reboots.
 */
export function persistIfChanged(): string {
  return `if [ "$changed" = 1 ] && [ "$backend" = iptables ]; then
${persistIptables()}
fi`;
}

/**
 * Answer `open`, `closed` or `unknown` for a single port.
 *
 * The Ansible profile probe reports one firewall verdict per service, inline and
 * next to that service's port, so it needs a per-port answer rather than the
 * whole ruleset `inspectScript` returns. Its own copy of this had drifted
 * furthest of the five: it had no nftables branch at all. On a host where
 * nftables is the real filter that copy either answered `unknown` forever, or —
 * worse — read the iptables compatibility shim, failed to see CloudForge's own
 * `inet cloudforge` table, and reported a port as closed while it was open.
 *
 * Emits a function and expects `$backend` to be set already, so a probe checking
 * several ports detects the backend once rather than once per port.
 *
 * A host whose firewall is installed but not running answers `open` rather than
 * `unknown`: nothing is filtering, so the port really is reachable, and that is a
 * fact rather than the absence of one. Only a host with no firewall tool at all
 * is `unknown`. The `iptables` and `nftables` branches say `open` when they find
 * no blocking rule for the same reason — a ruleset that accepts by default and
 * rejects nothing is not blocking the port, however few rules it has.
 */
export function portStateFunction(sudo = ''): string {
  return `cloudforge_port_state() {
  port="$1"; proto="\${2:-tcp}"
  case "$backend" in
    ufw)
      ${sudo}ufw status 2>/dev/null | grep -Eq "(^|[[:space:]])$port/$proto[[:space:]].*ALLOW" && printf open || printf closed
      ;;
    firewalld)
      ${sudo}firewall-cmd --quiet --query-port="$port/$proto" 2>/dev/null && printf open || printf closed
      ;;
    nftables)
      if ${sudo}nft list ruleset 2>/dev/null | grep -E "$proto dport" | grep -qE "(^|[^0-9])$port[^0-9]"; then printf open
      elif ${sudo}nft list ruleset 2>/dev/null | grep -qE 'policy (drop|reject)'; then printf closed
      else printf open; fi
      ;;
    iptables)
      if ${sudo}iptables -C INPUT -p "$proto" --dport "$port" -m comment --comment '${FIREWALL_MARKER}' -j ACCEPT 2>/dev/null; then printf open
      elif ${sudo}iptables -C INPUT -p "$proto" --dport "$port" -j ACCEPT 2>/dev/null; then printf open
      elif ${sudo}iptables -S INPUT 2>/dev/null | grep -Eq -- '-j (REJECT|DROP)'; then printf closed
      else printf open; fi
      ;;
    none)
      printf open
      ;;
    *)
      printf unknown
      ;;
  esac
}`;
}

/**
 * `openPortsScript` as something safe to paste inside a larger script.
 *
 * Three deliberate differences, each preserving how the callers already behave:
 * a subshell, so the helper function and `$changed` cannot collide with names in
 * the host script; output discarded, since the caller's stdout belongs to
 * whatever it is really doing; and `|| true`, because these callers run under
 * `set -e` and a firewall tool hiccuping must not abort a certificate issuance
 * that would otherwise have worked. Opening a port has always been best-effort
 * here — the verification that matters happens afterwards, by reading the
 * firewall back.
 */
export function openPortsFragment(ports: readonly FirewallPort[]): string {
  return `( ${openPortsScript(ports)} ) >/dev/null 2>&1 || true`;
}

/**
 * Close ports.
 *
 * Only ever removes exactly the ports it is given. There is no reconcile mode
 * and no "close everything not in the plan": a VPS's firewall carries rules put
 * there by people and other tools, and a port CloudForge did not open is not
 * CloudForge's to close.
 *
 * On iptables and nftables only the rule carrying CloudForge's marker is
 * removed, so a hand-written rule for the same port survives. ufw and firewalld
 * cannot record a comment on a port rule, so on those backends closing removes
 * the rule whoever created it — which is why the UI must say so and ask first.
 */
export function closePortsScript(ports: readonly FirewallPort[]): string {
  assertPorts(ports);
  const calls = ports.map((p) => `cloudforge_close ${String(p.port)} ${p.protocol}`).join('\n');
  return `changed=0
backend=$(${detectBackendScript()})
cloudforge_close() {
  port="$1"; proto="$2"
  case "$backend" in
    ufw)
      ufw status 2>/dev/null | grep -Eq "(^|[[:space:]])$port/$proto[[:space:]].*ALLOW" && { ufw delete allow "$port/$proto" >/dev/null 2>&1 && changed=1; }
      ;;
    firewalld)
      firewall-cmd --quiet --query-port="$port/$proto" 2>/dev/null && { firewall-cmd --permanent --remove-port="$port/$proto" >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1 && changed=1; }
      ;;
    nftables)
      handle=$(nft -a list chain inet ${NFT_TABLE} ${NFT_CHAIN} 2>/dev/null | grep "$proto dport $port accept" | grep -o 'handle [0-9]*' | awk '{print $2}' | head -n 1)
      if [ -n "$handle" ]; then nft delete rule inet ${NFT_TABLE} ${NFT_CHAIN} handle "$handle" >/dev/null 2>&1 && changed=1; fi
      ;;
    iptables)
      while iptables -C INPUT -p "$proto" --dport "$port" -m comment --comment '${FIREWALL_MARKER}' -j ACCEPT 2>/dev/null; do
        iptables -D INPUT -p "$proto" --dport "$port" -m comment --comment '${FIREWALL_MARKER}' -j ACCEPT || break
        changed=1
      done
      ;;
  esac
}
${calls}
if [ "$changed" = 1 ] && [ "$backend" = iptables ]; then
${persistIptables()}
fi
if [ "$changed" = 1 ]; then printf changed; else printf unchanged; fi`;
}

/**
 * Read the firewall back.
 *
 * Emits one `CF_FW|` line per fact so the parser never has to understand four
 * different tools' output formats. The alternative — parsing `ufw status` and
 * `nft list ruleset` and `iptables -S` in TypeScript — is what the old code did
 * in four places, differently.
 */
export function inspectScript(): string {
  return `backend=$(${detectBackendScript()})
printf 'CF_FW|backend|%s\\n' "$backend"
case "$backend" in
  ufw)
    printf 'CF_FW|active|1\\n'
    ufw status 2>/dev/null | grep -E '^[0-9]+/(tcp|udp)' | while read -r spec action rest; do
      port=\${spec%%/*}; proto=\${spec##*/}
      case "$action" in ALLOW*) printf 'CF_FW|rule|%s|%s|0|%s\\n' "$port" "$proto" "$spec $action $rest" ;; esac
    done
    ;;
  firewalld)
    printf 'CF_FW|active|1\\n'
    for spec in $(firewall-cmd --list-ports 2>/dev/null); do
      port=\${spec%%/*}; proto=\${spec##*/}
      printf 'CF_FW|rule|%s|%s|0|%s\\n' "$port" "$proto" "$spec"
    done
    ;;
  nftables)
    printf 'CF_FW|active|1\\n'
    nft list ruleset 2>/dev/null | grep -E '(tcp|udp) dport [0-9]+ accept' | while read -r line; do
      proto=$(printf '%s' "$line" | grep -oE '(tcp|udp) dport' | awk '{print $1}' | head -n 1)
      port=$(printf '%s' "$line" | grep -oE 'dport [0-9]+' | awk '{print $2}' | head -n 1)
      managed=0
      case "$line" in *'${FIREWALL_MARKER}'*) managed=1 ;; esac
      [ -n "$port" ] && printf 'CF_FW|rule|%s|%s|%s|%s\\n' "$port" "$proto" "$managed" "$line"
    done
    ;;
  iptables)
    printf 'CF_FW|active|1\\n'
    iptables -S INPUT 2>/dev/null | grep -E '\\-\\-dport [0-9]+' | grep -E '\\-j ACCEPT' | while read -r line; do
      proto=$(printf '%s' "$line" | grep -oE '\\-p (tcp|udp)' | awk '{print $2}' | head -n 1)
      port=$(printf '%s' "$line" | grep -oE '\\-\\-dport [0-9]+' | awk '{print $2}' | head -n 1)
      managed=0
      case "$line" in *'${FIREWALL_MARKER}'*) managed=1 ;; esac
      [ -n "$port" ] && printf 'CF_FW|rule|%s|%s|%s|%s\\n' "$port" "\${proto:-tcp}" "$managed" "$line"
    done
    ;;
  *)
    printf 'CF_FW|active|0\\n'
    ;;
esac`;
}

export interface ParsedFirewallRule {
  readonly port: number;
  readonly protocol: 'tcp' | 'udp';
  readonly managed: boolean;
  readonly raw: string;
}

export interface ParsedFirewallState {
  readonly backend: string;
  readonly active: boolean;
  readonly rules: readonly ParsedFirewallRule[];
}

/**
 * Parse `inspectScript` output.
 *
 * Tolerant of anything it does not recognise: a line it cannot read is dropped
 * rather than failing the whole inspection. Distributions phrase these tools'
 * output differently, and one surprising line should not blind CloudForge to the
 * rest of the firewall.
 */
export function parseFirewallState(output: string): ParsedFirewallState {
  let backend = 'unknown';
  let active = false;
  const rules: ParsedFirewallRule[] = [];

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('CF_FW|')) continue;
    const parts = trimmed.split('|');
    const kind = parts[1];
    if (kind === 'backend' && parts[2]) backend = parts[2];
    else if (kind === 'active') active = parts[2] === '1';
    else if (kind === 'rule') {
      const port = Number(parts[2]);
      const protocol = parts[3];
      if (!isValidPort(port)) continue;
      if (protocol !== 'tcp' && protocol !== 'udp') continue;
      rules.push({
        port,
        protocol,
        managed: parts[4] === '1',
        raw: parts.slice(5).join('|'),
      });
    }
  }
  return { backend, active, rules };
}
