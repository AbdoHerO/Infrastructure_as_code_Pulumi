import type {
  CertificateDetails,
  CertificateEventSink,
  CertificateIssueConfig,
  CertificateManager,
  DeploymentTarget,
} from '@cloudforge/core';
import { DeploymentError, err, ok, type Result } from '@cloudforge/shared';
import { runPrivilegedRemote } from './ssh-nginx-manager.js';

export class SshCertificateManager implements CertificateManager {
  async issue(
    target: DeploymentTarget,
    config: CertificateIssueConfig,
    onEvent?: CertificateEventSink,
  ): Promise<Result<CertificateDetails, DeploymentError>> {
    const result = await runPrivilegedRemote(
      target,
      `set -e
command -v docker >/dev/null 2>&1 || { echo 'Docker is required for the configured Certbot workflow' >&2; exit 1; }
${httpsFirewallScript()}
mkdir -p ${quote(config.certificateVolume)} ${quote(config.webrootVolume)}
docker run --rm -v ${quote(`${config.certificateVolume}:/etc/letsencrypt`)} -v ${quote(`${config.webrootVolume}:/var/www/html`)} certbot/certbot certonly --webroot -w /var/www/html -d ${quote(config.domain)} --email ${quote(config.email)} --agree-tos --no-eff-email${config.forceRenewal ? ' --force-renewal' : ''}
`,
      onEvent,
    );
    if (!result.ok) return result;
    return this.inspect(target, config.certificateVolume, config.domain);
  }

  renew(
    target: DeploymentTarget,
    config: CertificateIssueConfig,
    onEvent?: CertificateEventSink,
  ): Promise<Result<CertificateDetails, DeploymentError>> {
    return this.issue(target, { ...config, forceRenewal: false }, onEvent);
  }

  async list(
    target: DeploymentTarget,
    certificateVolume: string,
  ): Promise<Result<CertificateDetails[], DeploymentError>> {
    const names = await runPrivilegedRemote(
      target,
      `find ${quote(`${certificateVolume}/live`)} -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null || true`,
    );
    if (!names.ok) return names;
    const output: CertificateDetails[] = [];
    for (const domain of names.value.stdout.split('\n').filter(Boolean)) {
      const inspected = await this.inspect(target, certificateVolume, domain);
      if (inspected.ok) output.push(inspected.value);
    }
    return ok(output);
  }

  async export(
    target: DeploymentTarget,
    certificateVolume: string,
    domain: string,
    format: 'pem' | 'crt' | 'key' | 'zip',
  ): Promise<Result<{ name: string; contentBase64: string }, DeploymentError>> {
    const live = `${certificateVolume}/live/${domain}`;
    const command =
      format === 'key'
        ? `base64 -w0 ${quote(`${live}/privkey.pem`)}`
        : format === 'crt'
          ? `base64 -w0 ${quote(`${live}/cert.pem`)}`
          : format === 'pem'
            ? `base64 -w0 ${quote(`${live}/fullchain.pem`)}`
            : `tar -czf - -C ${quote(live)} . | base64 -w0`;
    const result = await runPrivilegedRemote(target, command);
    if (!result.ok) return result;
    return ok({
      name: `${domain}.${format === 'zip' ? 'tar.gz' : format}`,
      contentBase64: result.value.stdout.trim(),
    });
  }

  private async inspect(
    target: DeploymentTarget,
    volume: string,
    domain: string,
  ): Promise<Result<CertificateDetails, DeploymentError>> {
    const file = `${volume}/live/${domain}/cert.pem`;
    const result = await runPrivilegedRemote(
      target,
      `openssl x509 -in ${quote(file)} -noout -issuer -startdate -enddate -fingerprint -sha256 -text`,
    );
    if (!result.ok) return result;
    const text = result.value.stdout;
    const start = field(text, 'notBefore=');
    const end = field(text, 'notAfter=');
    if (!start || !end) return err(new DeploymentError('Could not parse the issued certificate'));
    const expiresAt = new Date(end).toISOString();
    const sans = [...text.matchAll(/DNS:([^,\s]+)/g)]
      .map((match) => match[1] ?? '')
      .filter(Boolean);
    return ok({
      domain,
      issuer: field(text, 'issuer=') ?? 'Unknown',
      createdAt: new Date(start).toISOString(),
      expiresAt,
      daysRemaining: Math.max(
        0,
        Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000),
      ),
      sans,
      wildcard: sans.some((name) => name.startsWith('*.')),
      keyAlgorithm: /id-ecPublicKey|EC Public Key/i.test(text) ? 'ECDSA' : 'RSA',
      fingerprint: (field(text, 'sha256 Fingerprint=') ?? '').replace(/:/g, ''),
    });
  }
}

function httpsFirewallScript(): string {
  return `cloudforge_firewall_changed=0
cloudforge_open_tcp_port() {
  port="$1"
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw status 2>/dev/null | grep -Eq "(^|[[:space:]])$port/tcp[[:space:]].*ALLOW" || { ufw allow "$port/tcp"; cloudforge_firewall_changed=1; }
  elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
    firewall-cmd --quiet --query-port="$port/tcp" || { firewall-cmd --permanent --add-port="$port/tcp"; firewall-cmd --reload; cloudforge_firewall_changed=1; }
  elif command -v iptables >/dev/null 2>&1; then
    iptables -C INPUT -p tcp --dport "$port" -m comment --comment 'CloudForge managed service' -j ACCEPT 2>/dev/null || { iptables -I INPUT 1 -p tcp --dport "$port" -m comment --comment 'CloudForge managed service' -j ACCEPT; cloudforge_firewall_changed=1; }
  fi
}
cloudforge_open_tcp_port 80
cloudforge_open_tcp_port 443
if [ "$cloudforge_firewall_changed" = 1 ]; then
  if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save
  elif [ -d /etc/iptables ]; then iptables-save > /etc/iptables/rules.v4
  elif [ -d /etc/sysconfig ]; then iptables-save > /etc/sysconfig/iptables
  fi
fi`;
}
function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function field(text: string, prefix: string): string | null {
  const line = text
    .split('\n')
    .find((candidate) => candidate.toLowerCase().startsWith(prefix.toLowerCase()));
  return line ? line.slice(prefix.length).trim() : null;
}
