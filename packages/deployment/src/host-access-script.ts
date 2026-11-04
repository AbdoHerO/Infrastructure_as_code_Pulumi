/**
 * The shell that gives other people SSH access to a server: one Linux account
 * per person, their public key in its `authorized_keys`, and optionally a sudo
 * rule.
 *
 * Pure string builders, so the shell is tested without a VPS. Every script is
 * POSIX `sh` (the target may be Alpine) and runs as root through
 * `runPrivilegedScript`.
 *
 * Safety rules, enforced here as well as above:
 * - only accounts whose GECOS comment is {@link HOST_ACCESS_MARKER} are ever
 *   changed or removed; any other existing account is refused;
 * - the account CloudForge itself is connected as (`SUDO_USER`) is refused;
 * - the key arrives base64-encoded, so its text can never be read as shell;
 * - a sudo rule is checked with `visudo -c` before it is put in place;
 * - the SSH server's configuration is read, never edited.
 */
import { HOST_ACCESS_MARKER } from '@cloudforge/core';
import { base64, quote } from './ssh-transport.js';

const USERNAME = /^[a-z][a-z0-9_-]{1,31}$/;

function assertUsername(username: string): void {
  // Validated by the service already; checked again because it is interpolated into shell.
  if (!USERNAME.test(username)) throw new Error(`Invalid account name ${username}`);
}

/** Where the sudo rule of an access account lives. */
export function sudoRulePath(username: string): string {
  assertUsername(username);
  return `/etc/sudoers.d/cloudforge-access-${username}`;
}

/**
 * Print the access accounts and their keys, then what could block their login.
 *
 *   USER<TAB>name<TAB>sudo (0 or 1)
 *   KEY<TAB>name<TAB>ssh-keygen -l line ("256 SHA256:… comment (ED25519)")
 *   WARN<TAB>message
 */
const LIST_FUNCTIONS = `MARK=${quote(HOST_ACCESS_MARKER)}
cf_list() {
  while IFS=: read -r name _pw _uid _gid gecos home _shell; do
    [ "$gecos" = "$MARK" ] || continue
    if [ -f "/etc/sudoers.d/cloudforge-access-$name" ]; then s=1; else s=0; fi
    printf 'USER\\t%s\\t%s\\n' "$name" "$s"
    f="$home/.ssh/authorized_keys"
    if [ -s "$f" ]; then
      ssh-keygen -lf "$f" 2>/dev/null | while IFS= read -r line; do
        printf 'KEY\\t%s\\t%s\\n' "$name" "$line"
      done
    fi
  done < /etc/passwd
}
cf_warn() {
  sshd_bin=""
  for b in /usr/sbin/sshd /usr/local/sbin/sshd; do [ -x "$b" ] && sshd_bin=$b && break; done
  [ -n "$sshd_bin" ] || return 0
  cfg=$("$sshd_bin" -T 2>/dev/null) || return 0
  if printf '%s\\n' "$cfg" | grep -qi '^pubkeyauthentication no'; then
    printf 'WARN\\tPublic-key login is switched off in the SSH server (PubkeyAuthentication no): nobody can log in with a key.\\n'
  fi
  users=$(printf '%s\\n' "$cfg" | awk 'tolower($1) == "allowusers" { $1 = ""; sub(/^ /, ""); print }' | tr '\\n' ' ')
  if [ -n "$users" ]; then
    printf 'WARN\\tThe SSH server lets in only these accounts (AllowUsers): %s- an account not listed cannot log in.\\n' "$users"
  fi
  groups=$(printf '%s\\n' "$cfg" | awk 'tolower($1) == "allowgroups" { $1 = ""; sub(/^ /, ""); print }' | tr '\\n' ' ')
  if [ -n "$groups" ]; then
    printf 'WARN\\tThe SSH server lets in only members of these groups (AllowGroups): %s- other accounts cannot log in.\\n' "$groups"
  fi
}`;

export function inspectAccessScript(): string {
  return `set -eu
${LIST_FUNCTIONS}
cf_list
cf_warn
`;
}

/** Refuse unless the account is absent or is one CloudForge created. */
function ownedOrAbsent(username: string): string {
  return `U=${quote(username)}
if [ "\${SUDO_USER:-}" = "$U" ]; then
  echo "$U is the account CloudForge connects with: give this person their own account." >&2
  exit 3
fi
entry=$(grep "^$U:" /etc/passwd || true)
if [ -n "$entry" ] && [ "$(printf '%s' "$entry" | cut -d: -f5)" != "$MARK" ]; then
  echo "The account $U already exists on this server and was not created by CloudForge: choose another name." >&2
  exit 3
fi`;
}

/**
 * Create the account when needed, add the key when it is not there yet, and
 * give or take the sudo rule.
 */
export function grantAccessScript(grant: {
  readonly username: string;
  readonly publicKey: string;
  readonly sudo: boolean;
}): string {
  assertUsername(grant.username);
  if (/[\r\n]/.test(grant.publicKey)) throw new Error('One public key line only');
  const rule = sudoRulePath(grant.username);
  return `set -eu
${LIST_FUNCTIONS}
${ownedOrAbsent(grant.username)}
KEY=$(printf '%s' '${base64(grant.publicKey)}' | base64 -d)
SUDO=${grant.sudo ? '1' : '0'}
if [ "$SUDO" = 1 ] && { [ ! -d /etc/sudoers.d ] || ! command -v visudo >/dev/null 2>&1; }; then
  echo "sudo is not installed on this server: give the access without administrator rights, or install sudo first." >&2
  exit 4
fi
if [ -z "$entry" ]; then
  shell=/bin/sh
  [ -x /bin/bash ] && shell=/bin/bash
  if command -v useradd >/dev/null 2>&1; then
    useradd --create-home --shell "$shell" --comment "$MARK" "$U"
  else
    adduser -D -s "$shell" -g "$MARK" "$U"
  fi
  # No password at all: key-only, but not a "locked" account, which sshd refuses without PAM.
  if command -v usermod >/dev/null 2>&1; then usermod -p '*' "$U"; else printf '%s:*\\n' "$U" | chpasswd -e; fi
fi
home=$(grep "^$U:" /etc/passwd | cut -d: -f6)
group=$(id -gn "$U")
mkdir -p "$home/.ssh"
f="$home/.ssh/authorized_keys"
touch "$f"
blob=$(printf '%s\\n' "$KEY" | awk '{ print $2 }')
if ! awk '{ print $2 }' "$f" | grep -qxF "$blob"; then
  printf '%s\\n' "$KEY" >> "$f"
fi
chown -R "$U:$group" "$home/.ssh"
chmod 700 "$home/.ssh"
chmod 600 "$f"
if [ "$SUDO" = 1 ]; then
  tmp=$(mktemp)
  printf '%s ALL=(ALL) NOPASSWD:ALL\\n' "$U" > "$tmp"
  chmod 440 "$tmp"
  if visudo -cf "$tmp" >/dev/null 2>&1; then
    mv "$tmp" ${rule}
  else
    rm -f "$tmp"
    echo "The sudo rule for $U was refused by visudo: the access was given without administrator rights." >&2
    exit 5
  fi
else
  rm -f ${rule}
fi
`;
}

/** Remove the account, its home folder (and keys) and its sudo rule. */
export function revokeAccessScript(username: string): string {
  assertUsername(username);
  const rule = sudoRulePath(username);
  return `set -eu
${LIST_FUNCTIONS}
${ownedOrAbsent(username)}
rm -f ${rule}
if [ -n "$entry" ]; then
  # Close the person's open sessions first: an account in use cannot be deleted.
  pkill -KILL -u "$U" 2>/dev/null || true
  sleep 1
  if command -v userdel >/dev/null 2>&1; then
    userdel -r "$U" 2>/dev/null || userdel -f -r "$U" 2>/dev/null || true
  else
    deluser --remove-home "$U" 2>/dev/null || true
  fi
  if grep -q "^$U:" /etc/passwd; then
    echo "The account $U could not be removed." >&2
    exit 6
  fi
fi
`;
}

export interface ParsedAccessKey {
  readonly fingerprint: string;
  readonly type: string;
  readonly bits: number;
  readonly comment: string;
}

export interface ParsedAccessState {
  readonly users: { username: string; sudo: boolean; keys: ParsedAccessKey[] }[];
  readonly warnings: string[];
}

/** Read the USER / KEY / WARN lines printed by the scripts above. */
export function parseAccessState(stdout: string): ParsedAccessState {
  const users: ParsedAccessState['users'] = [];
  const warnings: string[] = [];
  for (const line of stdout.split('\n')) {
    const [kind, first = '', second = ''] = line.replace(/\r$/, '').split('\t');
    if (kind === 'USER' && USERNAME.test(first)) {
      users.push({ username: first, sudo: second === '1', keys: [] });
    } else if (kind === 'KEY') {
      const key = parseKeygenLine(second);
      const user = users.find((u) => u.username === first);
      if (key && user) user.keys.push(key);
    } else if (kind === 'WARN' && first) {
      warnings.push(first);
    }
  }
  return { users, warnings };
}

/** `256 SHA256:abc… comment words (ED25519)` → its parts. */
export function parseKeygenLine(line: string): ParsedAccessKey | null {
  const match = /^(\d+)\s+(SHA256:\S+)\s*(.*?)\s*\(([A-Z0-9-]+)\)\s*$/.exec(line.trim());
  if (!match) return null;
  return {
    bits: Number(match[1]),
    fingerprint: match[2] ?? '',
    comment: (match[3] ?? '').trim() === 'no comment' ? '' : (match[3] ?? '').trim(),
    type: match[4] ?? '',
  };
}
