import { err, ok, type DeploymentError, type Result, ValidationError } from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type { DeploymentTarget } from '../ports/deployer.js';
import type { HostAccessManager, HostAccessState } from '../ports/host-access.js';
import type { RemoteTargetResolver } from '../ports/remote-target-resolver.js';

export type HostAccessServiceError = ValidationError | DeploymentError;

/**
 * SSH access for other people to a saved VPS target, from the SSH Keys page.
 *
 * A person sends their **public** key; CloudForge creates their own account on
 * the server, installs the key, optionally lets the account use `sudo`, and
 * shows the instructions to connect. Nothing here ever reads, shows or sends a
 * private key. Removing access deletes the account: their key stops working and
 * CloudForge's own access is not touched.
 */
export class HostAccessService {
  constructor(
    private readonly targets: RemoteTargetResolver,
    private readonly access: HostAccessManager,
    private readonly activities: ActivityService,
  ) {}

  inspect(targetId: string): Promise<Result<HostAccessState, HostAccessServiceError>> {
    return this.withTarget(targetId, (target) => this.access.inspect(target));
  }

  async grant(
    targetId: string,
    request: { username: string; publicKey: string; sudo: boolean },
  ): Promise<Result<HostAccessState, HostAccessServiceError>> {
    const username = validateAccessUsername(request.username);
    if (!username.ok) return username;
    const key = parseSshPublicKey(request.publicKey);
    if (!key.ok) return key;
    const result = await this.withTarget(targetId, (target) => {
      const refused = refuseOwnAccount(target, username.value);
      if (refused) return Promise.resolve(err(refused));
      return this.access.grant(target, {
        username: username.value,
        publicKey: key.value.line,
        sudo: request.sudo === true,
      });
    });
    if (result.ok) {
      this.activities.recordSafe({
        type: 'host.access.granted',
        message: `Gave ${username.value} SSH access${request.sudo ? ' with sudo' : ''} (${key.value.type} key${key.value.comment ? ` "${key.value.comment}"` : ''})`,
        metadata: {
          targetId,
          username: username.value,
          sudo: request.sudo === true,
          keyType: key.value.type,
        },
      });
    }
    return result;
  }

  async revoke(
    targetId: string,
    rawUsername: string,
  ): Promise<Result<HostAccessState, HostAccessServiceError>> {
    const username = validateAccessUsername(rawUsername);
    if (!username.ok) return username;
    const result = await this.withTarget(targetId, (target) => {
      const refused = refuseOwnAccount(target, username.value);
      if (refused) return Promise.resolve(err(refused));
      return this.access.revoke(target, username.value);
    });
    if (result.ok) {
      this.activities.recordSafe({
        type: 'host.access.revoked',
        message: `Removed the SSH access of ${username.value} (account and home folder deleted)`,
        metadata: { targetId, username: username.value },
      });
    }
    return result;
  }

  private async withTarget<T>(
    targetId: string,
    action: (target: DeploymentTarget) => Promise<Result<T, HostAccessServiceError>>,
  ): Promise<Result<T, HostAccessServiceError>> {
    if (!targetId.trim()) return err(new ValidationError('Select a saved VPS target'));
    const resolved = await this.targets.resolve(targetId);
    return resolved.ok ? action(resolved.value) : resolved;
  }
}

/** The account CloudForge itself logs in with is never handed out or deleted. */
function refuseOwnAccount(target: DeploymentTarget, username: string): ValidationError | null {
  if (username === target.username) {
    return new ValidationError(
      `${username} is the account CloudForge connects with: give this person their own account name instead.`,
    );
  }
  return null;
}

/**
 * Names that always belong to the system. The server refuses any other existing
 * account CloudForge did not create, but these are refused before connecting.
 */
const RESERVED_USERNAMES = new Set([
  'root',
  'daemon',
  'bin',
  'sys',
  'sync',
  'games',
  'man',
  'lp',
  'mail',
  'news',
  'uucp',
  'proxy',
  'www-data',
  'backup',
  'list',
  'irc',
  'gnats',
  'nobody',
  'sshd',
  'syslog',
  'messagebus',
  'docker',
  'admin',
  'sudo',
  'wheel',
  'jenkins',
  'cloudforge',
  'cloudops',
]);

/**
 * A Linux account name: lower-case letter first, then lower-case letters,
 * digits, `-` or `_`, 2 to 32 characters. It ends up in a shell script on the
 * server, so it is checked here even though the script quotes it too.
 */
export function validateAccessUsername(value: string): Result<string, ValidationError> {
  const name = value.trim();
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(name)) {
    return err(
      new ValidationError(
        'The account name must start with a lower-case letter and use only lower-case letters, digits, - and _ (2 to 32 characters), for example alex',
      ),
    );
  }
  if (RESERVED_USERNAMES.has(name) || name.startsWith('systemd-')) {
    return err(new ValidationError(`${name} is a system account name: choose another one`));
  }
  return ok(name);
}

/** Public-key types OpenSSH accepts for user authentication today. */
const KEY_TYPES = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]);

export interface ParsedSshPublicKey {
  readonly type: string;
  readonly comment: string;
  /** The normalized line written to `authorized_keys`: `type base64 [comment]`. */
  readonly line: string;
}

/**
 * Check one OpenSSH public key line, the content of an `id_*.pub` file.
 *
 * The base64 part is decoded and must name the same key type as the line, so a
 * truncated or mistyped key is caught here and not by a refused login later.
 * Options (`command=`, `from=`) and several keys at once are refused: one
 * person, one plain key per request. A pasted private key gets its own message,
 * because the person who sent it must be told to keep it secret.
 */
export function parseSshPublicKey(value: string): Result<ParsedSshPublicKey, ValidationError> {
  const text = value.trim();
  if (/PRIVATE KEY|PuTTY-User-Key-File/i.test(text)) {
    return err(
      new ValidationError(
        'This is a PRIVATE key: never paste or send it. Ask for the public key, the .pub file (one line starting with ssh-ed25519 or ssh-rsa); and the person should make a new key, since this one has been shared.',
      ),
    );
  }
  if (!text) return err(new ValidationError('Paste the public key (the content of the .pub file)'));
  if (/[\r\n]/.test(text)) {
    return err(new ValidationError('Paste one public key: a single line, starting with ssh-'));
  }
  const [type = '', blob = '', ...rest] = text.split(/\s+/);
  if (!KEY_TYPES.has(type)) {
    return err(
      new ValidationError(
        'This does not look like an SSH public key: it must start with ssh-ed25519, ssh-rsa or ecdsa-sha2-… (paste the key alone, without options)',
      ),
    );
  }
  const fields = readKeyFields(decodeBase64(blob), KEY_FIELDS[type] ?? 0);
  const damaged = new ValidationError(
    'The key is incomplete or damaged: paste the whole .pub line',
  );
  if (!fields || fields[0]?.text !== type) return err(damaged);
  if (type.includes('ed25519') && fields[1]?.bytes.length !== 32) return err(damaged);
  if (type === 'ssh-rsa') {
    const bits = rsaBits(fields[2]?.bytes ?? new Uint8Array());
    if (bits < 2048) {
      return err(
        new ValidationError(
          `This RSA key is too weak (${String(bits)} bits): ask for an ed25519 key (ssh-keygen -t ed25519)`,
        ),
      );
    }
  }
  // Printable characters only: the comment lands in a file and in the activity log.
  const comment = rest
    .join(' ')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, 100);
  return ok({ type, comment, line: comment ? `${type} ${blob} ${comment}` : `${type} ${blob}` });
}

/**
 * How many SSH strings each key type's data holds: the type name, then the key
 * (ed25519: the key; RSA: exponent and modulus; ECDSA: curve and point; security
 * keys add the application).
 */
const KEY_FIELDS: Record<string, number> = {
  'ssh-ed25519': 2,
  'ssh-rsa': 3,
  'ecdsa-sha2-nistp256': 3,
  'ecdsa-sha2-nistp384': 3,
  'ecdsa-sha2-nistp521': 3,
  'sk-ssh-ed25519@openssh.com': 3,
  'sk-ecdsa-sha2-nistp256@openssh.com': 4,
};

/** Exactly `count` SSH strings filling the whole data, or null when it is cut or padded. */
function readKeyFields(
  bytes: Uint8Array | null,
  count: number,
): { bytes: Uint8Array; text: string }[] | null {
  if (!bytes || count === 0) return null;
  const fields: { bytes: Uint8Array; text: string }[] = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const field = readSshString(bytes, offset);
    if (!field) return null;
    fields.push(field);
    offset = field.next;
  }
  return offset === bytes.length ? fields : null;
}

function decodeBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** An SSH wire-format string: a 4-byte big-endian length, then that many bytes. */
function readSshString(
  bytes: Uint8Array,
  offset: number,
): { bytes: Uint8Array; text: string; next: number } | null {
  if (offset + 4 > bytes.length) return null;
  const length =
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0);
  if (length < 0 || offset + 4 + length > bytes.length) return null;
  const slice = bytes.subarray(offset + 4, offset + 4 + length);
  return { bytes: slice, text: String.fromCharCode(...slice), next: offset + 4 + length };
}

/** Bit length of an RSA modulus (an SSH mpint, maybe with a leading zero byte). */
function rsaBits(modulus: Uint8Array): number {
  let i = 0;
  while (i < modulus.length && modulus[i] === 0) i++;
  if (i === modulus.length) return 0;
  const first = modulus[i] ?? 0;
  return (modulus.length - i - 1) * 8 + (32 - Math.clz32(first));
}

export interface HostAccessInstructions {
  /** What the person types to connect. */
  readonly command: string;
  /** The server's host-key fingerprint, to compare at the first connection. */
  readonly fingerprint: string;
  /** A message ready to send to the person. */
  readonly message: string;
}

/**
 * How a person connects with the access CloudForge gave them, from the saved
 * target (address, port, pinned host key) and their account name.
 */
export function hostAccessInstructions(
  server: { readonly host: string; readonly port: number; readonly hostKeySha256: string },
  username: string,
  options: { readonly sudo: boolean; readonly language: 'en' | 'fr' },
): HostAccessInstructions {
  const port = server.port === 22 ? '' : `-p ${String(server.port)} `;
  const command = `ssh ${port}${username}@${server.host}`;
  const raw = server.hostKeySha256.trim();
  const fingerprint = raw.startsWith('SHA256:') ? raw : `SHA256:${raw}`;
  const message =
    options.language === 'fr'
      ? [
          'Bonjour,',
          '',
          'Votre accès SSH au serveur est prêt.',
          '',
          `Adresse : ${server.host}`,
          `Port : ${String(server.port)}`,
          `Utilisateur : ${username}`,
          '',
          'Pour vous connecter, ouvrez un terminal (PowerShell sous Windows, Terminal sous Mac ou Linux) et tapez :',
          '',
          command,
          '',
          "La première fois, le terminal affiche l'empreinte du serveur et demande si vous voulez continuer.",
          "Vérifiez qu'elle est exactement :",
          '',
          fingerprint,
          '',
          'puis tapez « yes ». Si elle est différente, ne vous connectez pas et prévenez-moi.',
          ...(options.sudo
            ? [
                '',
                "Vous avez les droits d'administrateur : mettez sudo devant une commande pour l'exécuter en administrateur.",
              ]
            : []),
          '',
          "Votre clé privée (le fichier id_ed25519, sans .pub) reste sur votre ordinateur : ne l'envoyez jamais à personne.",
        ].join('\n')
      : [
          'Hello,',
          '',
          'Your SSH access to the server is ready.',
          '',
          `Address: ${server.host}`,
          `Port: ${String(server.port)}`,
          `Username: ${username}`,
          '',
          'To connect, open a terminal (PowerShell on Windows, Terminal on Mac or Linux) and type:',
          '',
          command,
          '',
          "The first time, the terminal shows the server's fingerprint and asks whether to continue.",
          'Check that it is exactly:',
          '',
          fingerprint,
          '',
          'then type "yes". If it is different, do not connect, and tell me.',
          ...(options.sudo
            ? [
                '',
                'You have administrator rights: put sudo in front of a command to run it as administrator.',
              ]
            : []),
          '',
          'Your private key (the file id_ed25519, without .pub) stays on your computer: never send it to anyone.',
        ].join('\n');
  return { command, fingerprint, message };
}
