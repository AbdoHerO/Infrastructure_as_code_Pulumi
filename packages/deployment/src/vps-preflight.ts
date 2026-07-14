import type {
  AnsibleProfileId,
  VpsFacts,
  VpsPreflightCheck,
  VpsPreflightReport,
} from '@cloudforge/core';

export type RawVpsFacts = Record<string, string>;

const SUPPORTED_OS = new Set(['ubuntu', 'debian', 'rhel', 'centos', 'rocky', 'almalinux', 'ol']);
const SUPPORTED_ARCH = new Set(['x86_64', 'amd64', 'aarch64', 'arm64']);

export function preflightCommand(
  port?: number,
  ownedService?: string,
  repositoryHost?: string,
): string {
  const safePort = port && Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 0;
  const safeService = ownedService && /^[a-z0-9_.-]+$/.test(ownedService) ? ownedService : '';
  const safeRepositoryHost =
    repositoryHost && /^[a-z0-9.-]+$/.test(repositoryHost) ? repositoryHost : '';
  return `set +e
emit() { printf 'CF:%s=%s\\n' "$1" "$2"; }
if [ -r /etc/os-release ]; then . /etc/os-release; fi
emit hostname "$(hostname 2>/dev/null)"
emit os_id "\${ID:-unknown}"
emit os_name "\${PRETTY_NAME:-unknown}"
emit os_version "\${VERSION_ID:-unknown}"
emit arch "$(uname -m 2>/dev/null)"
emit kernel "$(uname -sr 2>/dev/null)"
if command -v apt-get >/dev/null 2>&1; then PM=apt; elif command -v dnf >/dev/null 2>&1; then PM=dnf; elif command -v yum >/dev/null 2>&1; then PM=yum; else PM=none; fi
emit package_manager "$PM"
emit init "$(ps -p 1 -o comm= 2>/dev/null | tr -d ' ')"
if [ "$(id -u)" -eq 0 ]; then PRIV=root; elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then PRIV=sudo; else PRIV=none; fi
emit privilege "$PRIV"
PY="$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3)"
emit python_path "$PY"
emit python_version "$([ -n "$PY" ] && "$PY" -c 'import platform; print(platform.python_version())' 2>/dev/null)"
emit pip "$([ -n "$PY" ] && "$PY" -m pip --version >/dev/null 2>&1 && echo yes || echo no)"
emit venv "$([ -n "$PY" ] && "$PY" -m venv --help >/dev/null 2>&1 && echo yes || echo no)"
if [ -x /opt/cloudforge/ansible/bin/ansible-playbook ]; then A=/opt/cloudforge/ansible/bin/ansible-playbook; else A=''; fi
emit ansible_path "$A"
emit ansible_version "$([ -n "$A" ] && "$A" --version 2>/dev/null | head -n 1)"
emit memory_mb "$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)"
emit disk_mb "$(df -Pm /opt 2>/dev/null | awk 'NR==2 {print $4}')"
[ -n "$(df -Pm /opt 2>/dev/null | awk 'NR==2 {print $4}')" ] || emit disk_mb "$(df -Pm / 2>/dev/null | awk 'NR==2 {print $4}')"
emit coreutils "$(command -v sh >/dev/null && command -v base64 >/dev/null && command -v mkdir >/dev/null && command -v rm >/dev/null && echo yes || echo no)"
emit dns "$(getent hosts pypi.org >/dev/null 2>&1 && echo yes || echo no)"
if command -v curl >/dev/null 2>&1; then curl -fsSIL --max-time 8 https://pypi.org/simple/ansible-core/ >/dev/null 2>&1; NET=$?; elif command -v wget >/dev/null 2>&1; then wget -q --spider --timeout=8 https://pypi.org/simple/ansible-core/; NET=$?; else NET=2; fi
emit https "$([ "$NET" -eq 0 ] && echo yes || ([ "$NET" -eq 2 ] && echo no-tool || echo no))"
emit package_lock "$(pgrep -x 'apt|apt-get|dpkg|dnf|yum' >/dev/null 2>&1 && echo busy || echo free)"
emit time_sync "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo unknown)"
if command -v ufw >/dev/null 2>&1; then FW="ufw:$(ufw status 2>/dev/null | head -n 1)"; elif command -v firewall-cmd >/dev/null 2>&1; then FW="firewalld:$(firewall-cmd --state 2>/dev/null)"; elif command -v nft >/dev/null 2>&1; then FW=nftables; else FW=unknown; fi
emit firewall "$FW"
emit selinux "$(getenforce 2>/dev/null || echo unavailable)"
emit docker "$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
emit compose "$(docker compose version --short 2>/dev/null)"
if command -v dpkg-query >/dev/null 2>&1; then CONFLICTS="$(dpkg-query -W -f='\${binary:Package} \${db:Status-Abbrev}\\n' docker.io docker-compose docker-compose-v2 podman-docker containerd runc 2>/dev/null | awk '$2 ~ /^ii/ {print $1}' | paste -sd, -)"; else CONFLICTS="$(rpm -q docker podman-docker containerd runc 2>/dev/null | grep -v 'not installed' | paste -sd, -)"; fi
emit docker_conflicts "$CONFLICTS"
emit ss "$(command -v ss >/dev/null 2>&1 && echo yes || echo no)"
if [ -n '${safeRepositoryHost}' ]; then
  if command -v curl >/dev/null 2>&1; then curl -sSIL --max-time 8 'https://${safeRepositoryHost}/' >/dev/null 2>&1; REPO=$?; elif command -v wget >/dev/null 2>&1; then wget -q --spider --timeout=8 'https://${safeRepositoryHost}/'; REPO=$?; else REPO=2; fi
  emit profile_https "$([ "$REPO" -eq 0 ] && echo yes || ([ "$REPO" -eq 2 ] && echo no-tool || echo no))"
else emit profile_https not-required; fi
if [ ${safePort} -gt 0 ] && command -v ss >/dev/null 2>&1; then emit port_busy "$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq '(^|:)${safePort}$' && echo yes || echo no)"; else emit port_busy unknown; fi
if [ -n '${safeService}' ]; then
  if [ '${safeService}' = jenkins ] || [ '${safeService}' = nginx ]; then emit owned_service "$(systemctl is-active '${safeService}' 2>/dev/null)"; else emit owned_service "$(docker inspect -f '{{.State.Status}}' '${safeService}' 2>/dev/null)"; fi
else emit owned_service unknown; fi`;
}

export function parsePreflightOutput(output: string): RawVpsFacts {
  const facts: RawVpsFacts = {};
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('CF:')) continue;
    const separator = line.indexOf('=', 3);
    if (separator < 0) continue;
    facts[line.slice(3, separator)] = line.slice(separator + 1).trim();
  }
  return facts;
}

export function buildPreflightReport(
  raw: RawVpsFacts,
  profileId: AnsibleProfileId | undefined,
  port?: number,
): VpsPreflightReport {
  const checks: VpsPreflightCheck[] = [];
  const add = (item: VpsPreflightCheck): void => {
    checks.push(item);
  };
  add(
    check(
      'ssh',
      'connection',
      'Verified SSH connection',
      'ready',
      'Connected using the trusted host fingerprint.',
    ),
  );

  const osSupported = SUPPORTED_OS.has(raw.os_id ?? '');
  add(
    check(
      'os',
      'system',
      'Supported Linux distribution',
      osSupported ? 'ready' : 'blocked',
      osSupported
        ? `${raw.os_name} is supported.`
        : `${nonEmpty(raw.os_name, 'Unknown OS')} is not supported by the built-in profiles.`,
    ),
  );
  const archSupported = SUPPORTED_ARCH.has(raw.arch ?? '');
  add(
    check(
      'architecture',
      'system',
      'Supported CPU architecture',
      archSupported ? 'ready' : 'blocked',
      archSupported
        ? `${raw.arch} is supported.`
        : `${nonEmpty(raw.arch, 'Unknown architecture')} is unsupported.`,
    ),
  );
  add(
    check(
      'privilege',
      'system',
      'Non-interactive administrator access',
      raw.privilege === 'root' || raw.privilege === 'sudo' ? 'ready' : 'blocked',
      raw.privilege === 'root'
        ? 'Connected as root.'
        : raw.privilege === 'sudo'
          ? 'Passwordless sudo is available.'
          : 'Use root or grant this user passwordless sudo.',
    ),
  );
  add(
    check(
      'package-manager',
      'system',
      'Package manager',
      raw.package_manager !== 'none' ? 'ready' : 'blocked',
      raw.package_manager !== 'none'
        ? `${raw.package_manager} detected.`
        : 'APT, DNF, or YUM is required.',
    ),
  );
  add(
    check(
      'package-lock',
      'system',
      'Package manager availability',
      raw.package_lock === 'free' ? 'ready' : 'blocked',
      raw.package_lock === 'free'
        ? 'No package operation is running.'
        : 'Another package installation or update is currently running.',
    ),
  );
  add(
    check(
      'coreutils',
      'system',
      'POSIX shell utilities',
      raw.coreutils === 'yes' ? 'ready' : 'blocked',
      raw.coreutils === 'yes'
        ? 'Required shell and core utilities are available.'
        : 'sh, base64, mkdir, and rm are required.',
    ),
  );

  const pythonReady = versionAtLeast(raw.python_version, 3, 10);
  add(
    check(
      'python',
      'runtime',
      'Compatible Python',
      pythonReady ? 'ready' : 'repairable',
      pythonReady
        ? `Python ${raw.python_version} is available.`
        : 'Python 3.10 or newer will be installed.',
    ),
  );
  add(
    check(
      'venv',
      'runtime',
      'Python virtual environments',
      raw.venv === 'yes' ? 'ready' : 'repairable',
      raw.venv === 'yes' ? 'venv is available.' : 'Python venv support will be installed.',
    ),
  );
  add(
    check(
      'pip',
      'runtime',
      'Python package installer',
      raw.pip === 'yes' ? 'ready' : 'repairable',
      raw.pip === 'yes' ? 'pip is available.' : 'pip will be installed.',
    ),
  );
  const ansibleReady = Boolean(raw.ansible_path) && ansibleVersionSupported(raw.ansible_version);
  add(
    check(
      'ansible',
      'runtime',
      'CloudForge-managed Ansible',
      ansibleReady ? 'ready' : 'repairable',
      ansibleReady
        ? (raw.ansible_version ?? 'Ansible is ready.')
        : 'A compatible isolated ansible-core runtime will be installed.',
    ),
  );

  add(
    check(
      'dns',
      'network',
      'DNS resolution',
      raw.dns === 'yes' ? 'ready' : 'blocked',
      raw.dns === 'yes'
        ? 'Public DNS resolution works.'
        : 'The VPS cannot resolve required package hosts.',
    ),
  );
  add(
    check(
      'https',
      'network',
      'Outbound HTTPS',
      raw.https === 'yes' ? 'ready' : raw.https === 'no-tool' ? 'repairable' : 'blocked',
      raw.https === 'yes'
        ? 'PyPI is reachable over HTTPS.'
        : raw.https === 'no-tool'
          ? 'curl and CA certificates will be installed, then connectivity will be retested.'
          : 'Outbound HTTPS to PyPI failed. Check routing, DNS, time, proxy, and cloud egress rules.',
    ),
  );
  add(
    check(
      'clock',
      'system',
      'System clock synchronization',
      raw.time_sync === 'yes' ? 'ready' : 'warning',
      raw.time_sync === 'yes'
        ? 'The system clock is synchronized.'
        : 'Clock synchronization could not be confirmed; incorrect time breaks TLS.',
    ),
  );

  const memoryMb = numeric(raw.memory_mb);
  const diskFreeMb = numeric(raw.disk_mb);
  add(
    check(
      'disk',
      'resources',
      'Free disk space',
      diskFreeMb >= 1024 ? (diskFreeMb < 4096 ? 'warning' : 'ready') : 'blocked',
      `${diskFreeMb} MB is free on the installation filesystem.`,
    ),
  );
  const minimumMemory = profileId === 'jenkins' ? 512 : 256;
  add(
    check(
      'memory',
      'resources',
      'Available memory',
      memoryMb >= minimumMemory
        ? profileId === 'jenkins' && memoryMb < 4096
          ? 'warning'
          : 'ready'
        : 'blocked',
      `${memoryMb} MB RAM detected${profileId === 'jenkins' ? '; Jenkins recommends 4096 MB or more' : ''}.`,
    ),
  );

  if (profileId) {
    const needsSystemd = raw.init !== 'systemd';
    add(
      check(
        'systemd',
        'profile',
        'systemd service manager',
        needsSystemd ? 'blocked' : 'ready',
        needsSystemd
          ? `PID 1 is ${nonEmpty(raw.init, 'unknown')}; this profile requires systemd.`
          : 'systemd is available.',
      ),
    );
    const repository = profileRepositoryHost(profileId);
    if (repository) {
      add(
        check(
          'profile-repository',
          'network',
          `${profileId === 'jenkins' ? 'Jenkins' : 'Docker'} package repository`,
          raw.profile_https === 'yes'
            ? 'ready'
            : raw.profile_https === 'no-tool'
              ? 'repairable'
              : 'blocked',
          raw.profile_https === 'yes'
            ? `${repository} is reachable over HTTPS.`
            : raw.profile_https === 'no-tool'
              ? 'curl and CA certificates will be installed, then connectivity will be retested.'
              : `${repository} is unreachable. Check egress, DNS, proxy, TLS time, or repository policy.`,
        ),
      );
    }
    if (profileId === 'docker' || profileId === 'dockhand' || profileId === 'portainer') {
      const conflicts = raw.docker_conflicts ?? '';
      add(
        check(
          'docker-conflicts',
          'profile',
          'Docker package conflicts',
          conflicts ? 'blocked' : 'ready',
          conflicts
            ? `Conflicting packages require an explicit migration decision: ${conflicts}`
            : 'No conflicting Docker packages were detected.',
        ),
      );
      add(
        check(
          'docker-firewall',
          'profile',
          'Docker firewall behavior',
          'warning',
          `Host firewall: ${nonEmpty(raw.firewall, 'unknown')}. Published Docker ports can bypass UFW/firewalld policy; review DOCKER-USER rules.`,
        ),
      );
    }
    if (profileId === 'portainer' && raw.selinux === 'Enforcing')
      add(
        check(
          'selinux',
          'profile',
          'Portainer and SELinux',
          'warning',
          'SELinux is enforcing; Portainer may require an explicitly reviewed privileged/container-label configuration.',
        ),
      );
    if (port) {
      const owned = ['active', 'running'].includes(raw.owned_service ?? '');
      const available = raw.port_busy === 'no' || owned;
      const portStatus = raw.ss !== 'yes' ? 'repairable' : available ? 'ready' : 'blocked';
      add(
        check(
          'port',
          'profile',
          `TCP port ${port}`,
          portStatus,
          raw.ss !== 'yes'
            ? 'The iproute/ss networking utility will be installed before the port is checked.'
            : available
              ? owned
                ? 'The selected profile already owns this listening port.'
                : 'The port is available.'
              : raw.port_busy === 'yes'
                ? 'Another process already uses this port.'
                : 'Port availability could not be determined because ss is unavailable.',
        ),
      );
      add(
        check(
          'cloud-firewall',
          'profile',
          'Cloud firewall exposure',
          'warning',
          `CloudForge cannot infer an arbitrary provider firewall. Allow TCP ${port} only from the sources that need access.`,
        ),
      );
    }
  }

  const hasBlocked = checks.some((item) => item.status === 'blocked');
  const hasRepairable = checks.some((item) => item.status === 'repairable');
  const packageManager = raw.package_manager ?? 'none';
  const repairPackages = hasRepairable
    ? packageManager === 'apt'
      ? ['ca-certificates', 'curl', 'iproute2', 'python3', 'python3-venv', 'python3-pip']
      : packageManager === 'dnf' || packageManager === 'yum'
        ? ['ca-certificates', 'curl', 'iproute', 'python3.11', 'python3.11-pip']
        : []
    : [];
  const facts: VpsFacts = {
    hostname: raw.hostname ?? '',
    osId: raw.os_id ?? '',
    osName: raw.os_name ?? '',
    osVersion: raw.os_version ?? '',
    architecture: raw.arch ?? '',
    kernel: raw.kernel ?? '',
    packageManager,
    initSystem: raw.init ?? '',
    pythonVersion: nullableNonEmpty(raw.python_version),
    ansibleVersion: nullableNonEmpty(raw.ansible_version),
    memoryMb,
    diskFreeMb,
    firewall: raw.firewall ?? 'unknown',
    selinux: raw.selinux ?? 'unknown',
  };
  return {
    status: hasBlocked ? 'blocked' : hasRepairable ? 'needs-repair' : 'ready',
    checkedAt: new Date().toISOString(),
    profileId: profileId ?? null,
    facts,
    checks,
    repairPackages,
  };
}

export function profilePort(
  profileId: AnsibleProfileId | undefined,
  variables: Readonly<Record<string, unknown>> = {},
): number | undefined {
  if (!profileId || profileId === 'docker') return undefined;
  if (profileId === 'nginx') return 80;
  const fallback = profileId === 'dockhand' ? 3000 : profileId === 'portainer' ? 9443 : 8080;
  const port = Number(variables.port ?? fallback);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : fallback;
}

export function ownedService(profileId: AnsibleProfileId | undefined): string | undefined {
  return profileId === 'dockhand' ||
    profileId === 'portainer' ||
    profileId === 'jenkins' ||
    profileId === 'nginx'
    ? profileId
    : undefined;
}

export function profileRepositoryHost(profileId: AnsibleProfileId | undefined): string | undefined {
  if (profileId === 'docker' || profileId === 'dockhand' || profileId === 'portainer')
    return 'download.docker.com';
  if (profileId === 'jenkins') return 'pkg.jenkins.io';
  return undefined;
}

function check(
  id: string,
  category: VpsPreflightCheck['category'],
  label: string,
  status: VpsPreflightCheck['status'],
  message: string,
): VpsPreflightCheck {
  return { id, category, label, status, message };
}

function numeric(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function nonEmpty(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  return value;
}

function nullableNonEmpty(value: string | undefined): string | null {
  if (!value) return null;
  return value;
}

function versionAtLeast(value: string | undefined, major: number, minor: number): boolean {
  const match = /^(\d+)\.(\d+)/.exec(value ?? '');
  return Boolean(
    match &&
    (Number(match[1]) > major || (Number(match[1]) === major && Number(match[2]) >= minor)),
  );
}

function ansibleVersionSupported(value: string | undefined): boolean {
  const match = /core\s+(\d+)\.(\d+)/.exec(value ?? '');
  return Boolean(
    match && Number(match[1]) === 2 && Number(match[2]) >= 16 && Number(match[2]) < 22,
  );
}
