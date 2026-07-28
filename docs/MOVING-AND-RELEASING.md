# Moving CloudForge state and publishing Windows releases

Code distribution and application-state transfer are deliberately separate:

- Git/GitHub stores source code, workflows and documentation.
- A CloudForge portable backup stores the SQLite database, machine-independent
  encrypted credential payload, Pulumi state and its local passphrase.
- Raw `.db`, key and Pulumi state files must never be committed. They contain
  credentials, infrastructure identifiers and deployment history.

## Move the complete state to another computer

On the source computer:

1. If this is a migrated project with no passkey, open **Projects → Change
   passkey**, enter and confirm a new passkey, then select **Update passkey**.
2. Open **Settings → Security**.
3. Enter the current project passkey and a unique backup passphrase of at least
   12 characters. These are separate: the project passkey authorizes the export;
   the backup passphrase encrypts the portable file.
4. Select **Export project** and choose a removable drive or an encrypted/synced
   folder such as OneDrive. Wait until that folder has finished syncing.
5. Keep the backup passphrase separately. It is not stored in the backup.

The backup uses SQLite `VACUUM INTO` for a transactionally consistent database
snapshot. Credential plaintext exists only briefly in main-process memory and
is written only as an AES-256-GCM envelope derived from the backup passphrase.

On the destination computer:

1. Install the same or a newer CloudForge release and install Pulumi CLI.
2. Allow the backup folder to finish downloading completely.
3. Lock the current project to return to the **Project Picker**. On a fresh
   installation, the picker is already displayed.
4. Select **Import project**, enter the backup passphrase, choose a new project
   passkey (at least 8 characters), and select the exported folder.
5. CloudForge imports only that isolated workspace, preserves its resource and
   Pulumi identities, re-encrypts credentials with the destination OS keychain,
   restores its Pulumi checkpoint and project log, then restarts. Other projects
   on the destination remain untouched.

To roll back an existing project from one of its own backups, open that project
and use **Settings → Security → Restore backup**. Restore requires the same
project identity and never changes its current passkey. Import and Restore are
deliberately separate so a backup cannot overwrite another workspace.

Format-1 and format-2 legacy backups can still restore on the same machine, but their
OS-keychain ciphertext is not guaranteed to work on another machine. Create a
new project export before moving computers.

Do not continuously synchronize the live Electron `userData` directory. SQLite
and Pulumi state are mutable files; two running computers or partial cloud-sync
uploads can corrupt them or cause infrastructure drift. Synchronize completed
CloudForge backup folders instead, and use only one restored copy to perform
infrastructure operations at a time.

## Automatic database migration

Every startup runs `ensureSchema` for a fresh database and idempotent
`migrateSchema` upgrades for existing databases. A migration that rebuilds a
table first creates a timestamped safety copy. Restoring a backup restarts the
application, so the same migration path runs immediately on the restored data.

Downgrading is not supported: restore a backup only into the same or a newer
CloudForge version.

## Publish a Windows release from a Git tag

The workflow `.github/workflows/release.yml` runs only for `v*` tags. It verifies
semantic versioning and requires the tag to equal the desktop package version,
then runs formatting, lint, strict type checks, all tests and a production audit
on Windows. Only after those gates pass does it build the NSIS installer,
`latest.yml` update metadata, publish the GitHub Release, attach the SBOM and
attest build provenance.

Prepare and publish version `0.2.0`:

```powershell
git pull --ff-only origin main
corepack pnpm install --frozen-lockfile
corepack pnpm release:version 0.2.0
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
git add package.json apps/desktop/package.json
git commit -m "release: v0.2.0"
git push origin main
git tag -a v0.2.0 -m "CloudForge v0.2.0"
git push origin v0.2.0
```

The tag push starts **Actions → Windows release**. When it succeeds, users can
open the repository's **Releases** page and download
`CloudForge-0.2.0-setup.exe`. Packaged installations also read the published
`latest.yml` through the Updates page.

For trusted public distribution, configure repository secrets
`WIN_CSC_LINK` and `CSC_KEY_PASSWORD` with a Windows code-signing certificate.
Without a certificate, GitHub can still host an installer, but Windows will show
an unverified-publisher warning.
