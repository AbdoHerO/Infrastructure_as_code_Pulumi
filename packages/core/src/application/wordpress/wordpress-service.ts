import {
  ConflictError,
  type DeploymentError,
  err,
  newUuid,
  NotFoundError,
  ok,
  ValidationError,
  type PersistenceError,
  type Result,
} from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type {
  CredentialService,
  CredentialServiceError,
} from '../credentials/credential-service.js';
import type { DomainPublisher } from '../domains/domain-publisher.js';
import type { RemoteTargetResolver } from '../ports/remote-target-resolver.js';
import type {
  WordPressEventSink,
  WordPressManager,
  WordPressRuntimeStatus,
  WordPressSiteRecord,
  WordPressSiteStore,
} from '../ports/wordpress-manager.js';
import {
  generateWordPressSecret,
  nextWordPressPort,
  renderWordPressCompose,
  renderWordPressPhpIni,
  validateWordPressSite,
  wordpressProject,
  wordpressSiteUrl,
  type WordPressSiteInput,
} from './wordpress-site.js';

export type WordPressServiceError =
  | ValidationError
  | NotFoundError
  | ConflictError
  | DeploymentError
  | PersistenceError
  | CredentialServiceError;

interface SiteSecrets {
  readonly databasePassword: string;
  readonly databaseRootPassword: string;
  readonly adminPassword: string;
}

export interface CreatedWordPressSite {
  readonly site: WordPressSiteRecord;
  /** Shown once after creation; it stays revealable in Secrets afterwards. */
  readonly adminPassword: string;
}

export class WordPressService {
  constructor(
    private readonly store: WordPressSiteStore,
    private readonly targets: RemoteTargetResolver,
    private readonly manager: WordPressManager,
    private readonly credentials: Pick<
      CredentialService,
      'create' | 'list' | 'getDecrypted' | 'remove'
    >,
    private readonly activities: Pick<ActivityService, 'recordSafe'>,
    private readonly domains: Pick<DomainPublisher, 'check' | 'publish' | 'unpublish'>,
  ) {}

  list(): Promise<Result<WordPressSiteRecord[], PersistenceError>> {
    return this.store.list();
  }

  /**
   * Create a site and run every step: containers, DNS, Nginx, HTTPS. A failure
   * after the record exists keeps it (status `failed`) so Redeploy or Remove
   * can finish the job; nothing is left that CloudForge cannot see.
   */
  async create(
    input: WordPressSiteInput,
    onEvent?: WordPressEventSink,
  ): Promise<Result<CreatedWordPressSite, WordPressServiceError>> {
    const valid = validateWordPressSite(input);
    if (!valid.ok) return valid;
    const sites = await this.store.list();
    if (!sites.ok) return sites;
    const project = wordpressProject(valid.value.domain);
    if (sites.value.some((site) => site.domain === valid.value.domain || site.project === project))
      return err(new ConflictError(`A WordPress site for ${valid.value.domain} already exists`));
    const taken = sites.value
      .filter((site) => site.targetId === valid.value.targetId)
      .map((site) => site.hostPort);
    const hostPort = valid.value.hostPort ?? nextWordPressPort(taken);
    if (taken.includes(hostPort))
      return err(new ConflictError(`Port ${hostPort} is already used by another WordPress site`));
    const target = await this.targets.resolve(valid.value.targetId);
    if (!target.ok) return target;
    const domainCheck = await this.domains.check(valid.value);
    if (!domainCheck.ok) return domainCheck;
    if (!domainCheck.value.available)
      return err(new ConflictError(domainCheck.value.conflicts.join(' ')));

    // Remove keeps the server data and this secret. Deploying the same domain again
    // must reuse them: the database volume and WordPress hold those passwords.
    const kept = await this.keptSecrets(valid.value.domain);
    if (!kept.ok) return kept;
    let credentialId: string;
    let secrets: SiteSecrets;
    let adminUser = valid.value.adminUser;
    if (kept.value) {
      credentialId = kept.value.credentialId;
      secrets = kept.value.secrets;
      adminUser = kept.value.adminUser ?? adminUser;
      onEvent?.({
        stream: 'step',
        message: `Reusing the passwords kept for ${valid.value.domain} in Secrets`,
      });
    } else {
      secrets = {
        databasePassword: generateWordPressSecret(32),
        databaseRootPassword: generateWordPressSecret(32),
        adminPassword: valid.value.adminPassword ?? generateWordPressSecret(20),
      };
      const credential = await this.credentials.create({
        kind: 'environment-file',
        name: secretName(valid.value.domain),
        data: {
          filename: `${project}.env`,
          content: [
            `WORDPRESS_URL=${wordpressSiteUrl(valid.value.domain, valid.value.https)}/wp-admin/`,
            `WORDPRESS_ADMIN_USER=${adminUser}`,
            `WORDPRESS_ADMIN_PASSWORD=${secrets.adminPassword}`,
            `DB_PASSWORD=${secrets.databasePassword}`,
            `DB_ROOT_PASSWORD=${secrets.databaseRootPassword}`,
            '',
          ].join('\n'),
        },
      });
      if (!credential.ok) return credential;
      credentialId = credential.value.id;
    }

    const now = new Date().toISOString();
    const record: WordPressSiteRecord = {
      id: newUuid(),
      targetId: valid.value.targetId,
      domain: valid.value.domain,
      project,
      siteTitle: valid.value.siteTitle,
      adminUser,
      adminEmail: valid.value.adminEmail,
      hostPort,
      credentialId,
      cloudflareCredentialId: valid.value.cloudflareCredentialId,
      cloudflareZoneId: valid.value.cloudflareZoneId,
      https: valid.value.https,
      certificateEmail: valid.value.certificateEmail,
      status: 'deploying',
      wordpressVersion: null,
      warnings: [],
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    const saved = await this.store.save(record);
    if (!saved.ok) {
      if (!kept.value) await this.credentials.remove(credentialId);
      return saved;
    }
    const applied = await this.apply(record, secrets, onEvent);
    if (!applied.ok) return applied;
    this.activities.recordSafe({
      type: 'wordpress.site.created',
      message: `Deployed WordPress for ${record.domain}`,
      metadata: { siteId: record.id, targetId: record.targetId, domain: record.domain },
    });
    return ok({ site: applied.value, adminPassword: secrets.adminPassword });
  }

  /** Run every step again with the site's own passwords; safe on a working site. */
  async redeploy(
    id: string,
    onEvent?: WordPressEventSink,
  ): Promise<Result<WordPressSiteRecord, WordPressServiceError>> {
    const site = await this.load(id);
    if (!site.ok) return site;
    const secrets = await this.secrets(site.value);
    if (!secrets.ok) return secrets;
    return this.apply(site.value, secrets.value, onEvent);
  }

  async status(id: string): Promise<Result<WordPressRuntimeStatus, WordPressServiceError>> {
    const site = await this.load(id);
    if (!site.ok) return site;
    const target = await this.targets.resolve(site.value.targetId);
    if (!target.ok) return target;
    const status = await this.manager.status(target.value, site.value.project);
    if (!status.ok) return status;
    if (status.value.wordpressVersion !== site.value.wordpressVersion) {
      await this.store.save({
        ...site.value,
        wordpressVersion: status.value.wordpressVersion,
        updatedAt: new Date().toISOString(),
      });
    }
    return status;
  }

  /** Latest images and WordPress core; content, plugins and the database are kept. */
  async update(
    id: string,
    onEvent?: WordPressEventSink,
  ): Promise<Result<WordPressSiteRecord, WordPressServiceError>> {
    const site = await this.load(id);
    if (!site.ok) return site;
    const target = await this.targets.resolve(site.value.targetId);
    if (!target.ok) return target;
    const updated = await this.manager.update(target.value, site.value.project, onEvent);
    if (!updated.ok) return this.fail(site.value, updated.error);
    const record = {
      ...site.value,
      status: 'running' as const,
      wordpressVersion: updated.value.wordpressVersion,
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    const saved = await this.store.save(record);
    if (!saved.ok) return saved;
    this.activities.recordSafe({
      type: 'wordpress.site.updated',
      message: `Updated WordPress for ${record.domain} to ${record.wordpressVersion ?? 'the latest version'}`,
      metadata: { siteId: record.id, targetId: record.targetId, domain: record.domain },
    });
    return ok(record);
  }

  /**
   * Remove the containers and the Nginx site. Without `deleteData` the volumes,
   * the server directory and the passwords stay, so creating the site again
   * reattaches the same content.
   */
  async remove(
    id: string,
    deleteData: boolean,
    onEvent?: WordPressEventSink,
  ): Promise<Result<void, WordPressServiceError>> {
    const site = await this.load(id);
    if (!site.ok) return site;
    const target = await this.targets.resolve(site.value.targetId);
    if (!target.ok) return target;
    const removed = await this.manager.remove(
      target.value,
      site.value.project,
      deleteData,
      onEvent,
    );
    if (!removed.ok) return removed;
    const unpublished = await this.domains.unpublish(
      site.value,
      { deleteDns: deleteData },
      onEvent,
    );
    if (!unpublished.ok) return unpublished;
    if (deleteData) await this.credentials.remove(site.value.credentialId);
    const deleted = await this.store.remove(id);
    if (!deleted.ok) return deleted;
    this.activities.recordSafe({
      type: 'wordpress.site.removed',
      message: `Removed WordPress for ${site.value.domain}${deleteData ? ' and its data' : ''}`,
      metadata: {
        siteId: id,
        targetId: site.value.targetId,
        domain: site.value.domain,
        deleteData,
      },
    });
    return ok(undefined);
  }

  private async apply(
    site: WordPressSiteRecord,
    secrets: SiteSecrets,
    onEvent?: WordPressEventSink,
  ): Promise<Result<WordPressSiteRecord, WordPressServiceError>> {
    const step = (message: string): void => onEvent?.({ stream: 'step', message });
    const target = await this.targets.resolve(site.targetId);
    if (!target.ok) return this.fail(site, target.error);
    const siteUrl = wordpressSiteUrl(site.domain, site.https);

    step(`Deploying WordPress containers for ${site.domain}`);
    const deployed = await this.manager.deploy(
      target.value,
      {
        project: site.project,
        composeYaml: renderWordPressCompose({
          project: site.project,
          domain: site.domain,
          hostPort: site.hostPort,
          siteUrl,
        }),
        phpIni: renderWordPressPhpIni(),
        hostPort: site.hostPort,
        siteUrl,
        siteTitle: site.siteTitle,
        adminUser: site.adminUser,
        adminEmail: site.adminEmail,
        secrets,
      },
      onEvent,
    );
    if (!deployed.ok) return this.fail(site, deployed.error);

    const published = await this.domains.publish(
      {
        targetId: site.targetId,
        domain: site.domain,
        hostPort: site.hostPort,
        cloudflareCredentialId: site.cloudflareCredentialId,
        cloudflareZoneId: site.cloudflareZoneId,
        https: site.https,
        certificateEmail: site.certificateEmail,
        clientMaxBodySize: '64m',
        proxyTimeoutSeconds: 300,
        websocket: false,
      },
      onEvent,
    );
    if (!published.ok) return this.fail(site, published.error);
    const warnings = published.value.warnings;

    const record: WordPressSiteRecord = {
      ...site,
      status: 'running',
      wordpressVersion: deployed.value.wordpressVersion,
      warnings,
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    const saved = await this.store.save(record);
    if (!saved.ok) return saved;
    step(
      warnings.length === 0
        ? `WordPress ${record.wordpressVersion ?? ''} is live at ${siteUrl}`.replace('  ', ' ')
        : `WordPress is running with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
    );
    return ok(record);
  }

  private async secrets(
    site: WordPressSiteRecord,
  ): Promise<Result<SiteSecrets, WordPressServiceError>> {
    const read = await this.readSecret(site.credentialId, site.domain);
    return read.ok ? ok(read.value.secrets) : read;
  }

  /** The secret a previous Remove kept for this domain, if any. */
  private async keptSecrets(
    domain: string,
  ): Promise<
    Result<
      { credentialId: string; secrets: SiteSecrets; adminUser: string | null } | null,
      WordPressServiceError
    >
  > {
    const listed = await this.credentials.list();
    if (!listed.ok) return listed;
    const existing = listed.value.find(
      (credential) =>
        credential.kind === 'environment-file' && credential.name === secretName(domain),
    );
    if (!existing) return ok(null);
    const read = await this.readSecret(existing.id, domain);
    return read.ok ? ok({ credentialId: existing.id, ...read.value }) : read;
  }

  private async readSecret(
    credentialId: string,
    domain: string,
  ): Promise<Result<{ secrets: SiteSecrets; adminUser: string | null }, WordPressServiceError>> {
    const credential = await this.credentials.getDecrypted(credentialId);
    if (!credential.ok)
      return err(
        new NotFoundError(`The passwords for ${domain} are missing from Secrets`, {
          cause: credential.error,
        }),
      );
    const values = parseEnvironment(credential.value.data.content ?? '');
    const databasePassword = values.get('DB_PASSWORD');
    const databaseRootPassword = values.get('DB_ROOT_PASSWORD');
    const adminPassword = values.get('WORDPRESS_ADMIN_PASSWORD');
    if (!databasePassword || !databaseRootPassword || !adminPassword)
      return err(
        new ValidationError(
          `The secret "${secretName(domain)}" lost DB_PASSWORD, DB_ROOT_PASSWORD or WORDPRESS_ADMIN_PASSWORD`,
        ),
      );
    const adminUser = values.get('WORDPRESS_ADMIN_USER')?.trim() ?? '';
    return ok({
      secrets: { databasePassword, databaseRootPassword, adminPassword },
      adminUser: adminUser === '' ? null : adminUser,
    });
  }

  private async load(id: string): Promise<Result<WordPressSiteRecord, WordPressServiceError>> {
    const sites = await this.store.list();
    if (!sites.ok) return sites;
    const site = sites.value.find((item) => item.id === id);
    return site ? ok(site) : err(new NotFoundError('This WordPress site no longer exists'));
  }

  private async fail(
    site: WordPressSiteRecord,
    cause: WordPressServiceError | DeploymentError,
  ): Promise<Result<never, WordPressServiceError>> {
    await this.store.save({
      ...site,
      status: 'failed',
      lastError: cause.message,
      updatedAt: new Date().toISOString(),
    });
    this.activities.recordSafe({
      type: 'wordpress.site.failed',
      message: `WordPress for ${site.domain} failed: ${cause.message}`,
      metadata: { siteId: site.id, targetId: site.targetId, domain: site.domain },
    });
    return err(cause);
  }
}

function secretName(domain: string): string {
  return `WordPress · ${domain}`;
}

/** KEY=VALUE lines; the value is everything after the first `=`. */
function parseEnvironment(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1));
  }
  return values;
}
