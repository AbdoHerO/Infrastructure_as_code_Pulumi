import type {
  CertificateDetails,
  CertificateEventSink,
  CertificateIssueConfig,
  CertificateManager,
  DeploymentTarget,
} from '@cloudforge/core';
import { DeploymentError, err, ok, type Result } from '@cloudforge/shared';
import { runPrivilegedRemote } from './ssh-nginx-manager.js';
import { openPortsFragment } from './host-firewall-script.js';
import { quote } from './ssh-transport.js';
import { randomUUID } from 'node:crypto';

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
${openPortsFragment([
  { port: 80, protocol: 'tcp' },
  { port: 443, protocol: 'tcp' },
])}
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

  async prepareOriginCertificate(
    target: DeploymentTarget,
    config: CertificateIssueConfig,
    hostnames: readonly string[],
    onEvent?: CertificateEventSink,
  ): Promise<Result<{ csr: string; workspace: string }, DeploymentError>> {
    const workspace = `/tmp/cloudforge-origin-${randomUUID()}`;
    const subjectAltName = hostnames.map((hostname) => `DNS:${hostname}`).join(',');
    const keyCommand =
      config.keyAlgorithm === 'ecc'
        ? `openssl ecparam -name prime256v1 -genkey -noout -out "$workspace/privkey.pem"`
        : `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$workspace/privkey.pem"`;
    onEvent?.({
      stream: 'step',
      message: 'Generating the Origin CA private key and CSR securely on the VPS',
    });
    const result = await runPrivilegedRemote(
      target,
      `set -eu
command -v openssl >/dev/null 2>&1 || { echo 'OpenSSL is required for Origin CA certificates' >&2; exit 1; }
workspace=${quote(workspace)}
umask 077
mkdir -p "$workspace"
${keyCommand}
openssl req -new -key "$workspace/privkey.pem" -subj ${quote(`/CN=${config.domain}`)} -addext ${quote(`subjectAltName=${subjectAltName}`)} -out "$workspace/request.csr"
base64 -w0 "$workspace/request.csr"
`,
      onEvent,
    );
    return result.ok
      ? ok({ csr: Buffer.from(result.value.stdout.trim(), 'base64').toString('utf8'), workspace })
      : result;
  }

  async installOriginCertificate(
    target: DeploymentTarget,
    config: CertificateIssueConfig,
    workspace: string,
    certificate: string,
    onEvent?: CertificateEventSink,
  ): Promise<Result<CertificateDetails, DeploymentError>> {
    if (!validWorkspace(workspace))
      return err(new DeploymentError('The Origin CA certificate workspace is invalid'));
    const live = `${config.certificateVolume}/live/${config.domain}`;
    const backup = `${config.certificateVolume}/backups/${config.domain}-${Date.now()}`;
    onEvent?.({
      stream: 'step',
      message: 'Installing the Cloudflare Origin CA certificate on the VPS',
    });
    const installed = await runPrivilegedRemote(
      target,
      `set -eu
workspace=${quote(workspace)}
live=${quote(live)}
backup=${quote(backup)}
mkdir -p ${quote(`${config.certificateVolume}/live`)} ${quote(`${config.certificateVolume}/backups`)}
if [ -d "$live" ]; then mkdir -p "$backup"; cp -a "$live/." "$backup/"; fi
mkdir -p "$live"
printf '%s' ${quote(Buffer.from(certificate, 'utf8').toString('base64'))} | base64 -d > "$live/cert.pem"
cp "$live/cert.pem" "$live/fullchain.pem"
mv "$workspace/privkey.pem" "$live/privkey.pem"
chmod 600 "$live/privkey.pem"
chmod 644 "$live/cert.pem" "$live/fullchain.pem"
openssl x509 -in "$live/cert.pem" -noout >/dev/null
certificate_public=$(openssl x509 -in "$live/cert.pem" -pubkey -noout | openssl pkey -pubin -outform pem | sha256sum | awk '{print $1}')
private_public=$(openssl pkey -in "$live/privkey.pem" -pubout -outform pem | sha256sum | awk '{print $1}')
if [ "$certificate_public" != "$private_public" ]; then
  rm -rf "$live"
  if [ -d "$backup" ]; then mkdir -p "$live"; cp -a "$backup/." "$live/"; fi
  echo 'Cloudflare certificate does not match the generated private key' >&2
  exit 1
fi
rm -rf "$workspace"
`,
      onEvent,
    );
    if (!installed.ok) return installed;
    return this.inspect(target, config.certificateVolume, config.domain);
  }

  async discardOriginCertificate(
    target: DeploymentTarget,
    workspace: string,
  ): Promise<Result<void, DeploymentError>> {
    if (!validWorkspace(workspace))
      return err(new DeploymentError('The Origin CA certificate workspace is invalid'));
    const result = await runPrivilegedRemote(target, `rm -rf ${quote(workspace)}`);
    return result.ok ? ok(undefined) : result;
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

function field(text: string, prefix: string): string | null {
  const line = text
    .split('\n')
    .find((candidate) => candidate.toLowerCase().startsWith(prefix.toLowerCase()));
  return line ? line.slice(prefix.length).trim() : null;
}
function validWorkspace(value: string): boolean {
  return /^\/tmp\/cloudforge-origin-[a-f0-9-]+$/i.test(value);
}
