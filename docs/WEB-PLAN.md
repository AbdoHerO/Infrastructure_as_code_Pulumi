# CloudForge on the Web — Full Plan

Status: **proposal, nothing is built yet.** It waits for your approval and the decisions
in section 14.
Analysed: commit `696823a` on `main`, 2026-11-06 (version 0.4.4 plus MCP and Keep trying).

This plan shows how CloudForge moves from a desktop app to a private web app that you
open in a browser, with your current projects, credentials, Pulumi state and servers. It
is for **one user now**, and it avoids choices that would block adding people later.

---

## 0. Summary

**It is possible, and most of the application does not change.** Every action in the
window already goes through one bridge (`window.cloudforge`) and one function
(`dispatch`). The web version replaces what sits around them, not the features.

| What was checked                   | Count | What happens on the web                                       |
| ---------------------------------- | ----: | ------------------------------------------------------------- |
| Actions the window can call        |   222 | 200 keep the same handler; 22 change (Appendix A)             |
| Events pushed to the window        |    19 | All kept, sent over a WebSocket (Appendix B)                  |
| Pages                              |    25 | 12 do not change; 13 change a little (section 7)              |
| Files that import Electron         |    21 | 6 stay desktop-only; 15 move to a platform layer (Appendix C) |
| File and folder dialogs            |     6 | Become browser uploads and downloads (section 3.6)            |
| MCP tools                          |   234 | 217 stay the same; 17 change (Appendix D)                     |
| Actions that ask you to re-confirm |    50 | Password and code again before they run (section 4.5)         |
| Existing problems found            |    13 | Listed in Appendix E; 1 blocks moving your data today         |

**The most important finding:** the portable backup leaves out the Pulumi passphrase, so
a restored project cannot use its infrastructure on another machine. This was tested with
the real Pulumi CLI. Phase 0 fixes it before anything else.

**What you will have at the end:**

- CloudForge at a private HTTPS address, on your own devices, from anywhere.
- A sign-in with a password and an authenticator code, in front of the project passkeys.
- A small dedicated server that keeps working when you close the tab.
- Client credentials that stay encrypted even if someone copies the server's disk.
- Nightly encrypted backups stored away from the server.
- The desktop app still working, from the same code.

**How this inventory was made.** The channel, event and tool lists were generated from
`contract.ts` and the MCP catalogue, so they are complete. I read in full: the registry,
preload, events, window, app entry, container, engine, logger, key and path helpers, and
the backup, SSH key, app and log handlers. The other handlers and pages were searched for
Electron APIs, dialogs, paths, clipboard use, downloads and desktop wording, not re-read
line by line. Two things catch what a search could miss: the compile-time table in Phase 1
and the full browser test run in Phase 2.

---

## 1. Principles

1. **One application, two front doors.** Desktop and web call the same handlers through
   the same `dispatch`. No feature is written twice.
2. **Nothing on the public internet.** The address is reachable only through a private
   network, and the app's own sign-in still applies.
3. **A copied disk is not enough.** Secrets on disk cannot be opened without your
   password or recovery key.
4. **No action without a web decision.** As with MCP, a new channel does not compile until
   someone decides how it behaves on the web.
5. **Closing a tab never stops work.** A Pulumi apply carries on, and you can come back to
   its logs and result.
6. **One writer for each project.** A project is moved, never run in two places at once.
7. **Your server rule stands.** Before any change to a server, you see exactly what will
   happen and approve it.

---

## 2. How you will use it

1. You open `https://<your-private-name>` on your laptop.
2. You sign in with your password and a 6-digit code from your authenticator app.
3. The usual project picker appears, and you enter the project's passkey.
4. All the pages work as they do today.
5. You start an Apply and close the laptop. It keeps running on the server.
6. Later, on any of your devices, you sign in and open **Running work** to see the logs
   and the result.
7. After 30 idle minutes, the session ends and the project locks. Running work finishes
   first.

What you do differently:

- **Files:** choosing a file means picking it from your own computer in the browser.
  Saving means a normal browser download.
- **Sensitive actions:** deleting, destroying, revealing a secret or opening a terminal
  asks for your password and code again if your last confirmation is over 15 minutes old.
- **Project switching:** this stays as it is today, one project open at a time.

---

## 3. Architecture

```
 Your laptop or phone
 ┌───────────────────────────────┐
 │ Browser: the same React pages │
 └───────────────┬───────────────┘
                 │ HTTPS + WebSocket, only inside your private network
 ┌───────────────▼───────────────────────────────────────┐
 │ Your CloudForge server (small dedicated VPS)          │
 │                                                       │
 │  Tailscale (HTTPS) ──► 127.0.0.1                      │
 │                                                       │
 │  CloudForge server process, user "cloudforge"         │
 │   ├─ Sign-in, sessions, re-confirmation               │
 │   ├─ Web bridge ──► the same dispatch() as desktop    │
 │   ├─ Handlers, services, Pulumi, SSH                  │
 │   ├─ MCP server at /mcp                               │
 │   └─ /var/lib/cloudforge: database, state, logs       │
 └─────┬──────────────────┬───────────────────┬──────────┘
       │ SSH, pinned keys │ Cloud APIs        │ Encrypted backups
 Your and client     AWS, Oracle,        Storage bucket
 servers             Cloudflare          (another provider)
```

### 3.1 Code layout

Today everything is inside `apps/desktop`. It becomes:

| Folder                                                                        | Holds                                                    | Comes from                  |
| ----------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------- |
| `packages/contract` (new)                                                     | The IPC contract and shared types                        | `apps/desktop/src/shared`   |
| `packages/host` (new)                                                         | Handlers, container, MCP, Keep trying, logging, security | `apps/desktop/src/main`     |
| `packages/frontend` (new)                                                     | The React pages                                          | `apps/desktop/src/renderer` |
| `apps/desktop`                                                                | Electron only: window, preload, native platform, updater | Stays                       |
| `apps/server` (new)                                                           | HTTP, WebSocket, sign-in, uploads, updater               | New                         |
| `packages/core`, `providers`, `deployment`, `pulumi`, `database` and the rest | Unchanged                                                | Stay                        |

The move is one mechanical commit with no behaviour change. It is tested with everything
that exists today before any new code is added.

### 3.2 Platform layer

The 15 shared files that touch Electron today will use an interface. Desktop and server
each provide their own version:

```ts
interface AppPlatform {
  readonly kind: 'desktop' | 'server';
  readonly dataDir: string; // app.getPath('userData') or /var/lib/cloudforge
  readonly resourcesDir: string; // process.resourcesPath or the install folder
  readonly version: string;
  readonly packaged: boolean;
  readonly locale: string;
  createSecretCipher(): Result<SecretCipher, EncryptionError>;
  pickFile(options: PickFileOptions): Promise<string | null>; // desktop only
  pickFolder(options: PickFolderOptions): Promise<string | null>; // desktop only
  saveFile(options: SaveFileOptions): Promise<string | null>; // desktop only
  broadcast(channel: IpcEventChannel, payload: unknown): void; // windows or WebSockets
  notify(title: string, body: string): void; // native alert or browser alert
  bringToFront(): void; // window flash or nothing
  keepAwake(reason: string): () => void; // powerSaveBlocker or nothing
  restart(): void; // app.relaunch or exit for systemd to restart
  onShutdown(listener: () => Promise<void>): void;
}
```

An ESLint rule then allows `electron` imports only inside `apps/desktop`, so the server
can never break by accident.

### 3.3 Browser bridge

The pages only know `window.cloudforge.invoke` and `window.cloudforge.subscribe`. The web
build installs its own version of the same object before React starts, plus a small
`platform` value that says `desktop` or `web`. This is why most pages need no change.
Routing already uses hash URLs, which work unchanged in a browser.

### 3.4 How the browser talks to the server

One WebSocket per tab, not one HTTP request per action. Applies can last many minutes,
which HTTP requests and proxies handle badly.

| Message                         | Direction  | Purpose                                        |
| ------------------------------- | ---------- | ---------------------------------------------- |
| `call {id, channel, payload}`   | To server  | Runs `dispatch(channel, payload, 'web')`       |
| `result {id, result}`           | To browser | The same result envelope the window gets today |
| `event {seq, channel, payload}` | To browser | Numbered copy of every pushed event            |
| `resume {lastSeq, pendingIds}`  | To server  | After a dropped connection: send what I missed |
| `ping` / `pong`                 | Both       | Every 25 seconds, to notice a dead connection  |

Rules:

- **Dropped connection:** the server keeps results for 10 minutes and the last events in a
  buffer. The browser reconnects, resumes and misses nothing. A banner shows
  **Reconnecting…** meanwhile.
- **No automatic resend.** A call is never sent twice, because that could apply twice.
- **Limits:** 2 MB per message, a rate limit per session, and only known channel names.
  Larger files use the upload route.
- **Slow browser:** if a tab falls too far behind, log events are dropped and the gap is
  marked. Logs can be fetched again from Running work.
- **Terminal input** uses the same connection, so typing stays fast.

### 3.5 Running work

Today a page holds its logs in React state (`useEngineLogs`), so a reload would lose them.
On the desktop this rarely matters. In a browser, reloads are normal.

`mcp/operations.ts` already tracks long work for MCP: state, result, a 2,000-line log
buffer and cancel. It becomes a shared service that also tracks long calls from the window.

- New **Running work** button in the titlebar, with a count.
- The panel lists running and recent work, with live logs, result and Cancel where
  supported.
- A page that opens while its work is running re-attaches to it.
- New channels `operations:list` and `operations:logs`. The compile-time tables will ask
  for their MCP and web decisions.
- Reloading while something runs in the current tab shows the browser's "leave page?"
  warning, even though the work would continue.

### 3.6 Files

| Today (desktop)                                         | On the web                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `credentials:importEnvironmentFile`: file dialog        | Browser file picker. The file is read in the browser, 1 MB limit kept                |
| `stacks:chooseFolder`: folder dialog                    | Browser folder picker. Only `compose.yaml`, `docker-compose.yml` and `.env` are read |
| `sshKeys:exportPrivate`: save dialog                    | Reveals the key, then a browser download. The same way `ssl:export` works today      |
| `sshKeys:materializePrivate`: temporary key on disk     | Refused on the server. See "Prepare SSH command" in section 7.2                      |
| `backup:create`: folder dialog                          | Server builds one encrypted `.cfbackup` file, then a one-time download               |
| `backup:restore`, `backup:importProject`: folder dialog | Upload a `.cfbackup` or an exported folder, then call with its `uploadId`            |
| `logs:openFolder`: opens Explorer                       | **Download log**                                                                     |

Upload and download safety:

- **Uploads** stream to a private folder with a size limit, and are deleted after use or
  after 1 hour.
- **Reading a backup:** only five fixed names are accepted: `manifest.json`, `project.db`,
  `credentials.enc`, `pulumi/stack.json`, `logs/cloudforge.log`. Anything else is ignored,
  so a crafted file cannot write outside its folder.
- **Downloads** work once, for the session that asked, within 15 minutes, and are never
  cached.
- **`.cfbackup` is fully encrypted** with your backup passphrase. Today's folder encrypts
  only the credentials, and `project.db` stays readable. That is too weak for a file
  travelling across a network and into a Downloads folder.
- **Path options refused.** The `path`, `sourceDir` and `destinationDir` options added for
  MCP would let a caller read or write any file on the server, because `requireLocalPath`
  only checks a path's shape. On the server they are refused for everyone.

### 3.7 Project session on a server

On the desktop, closing the window quits the app, which locks the project. A server never
quits, so a project would otherwise stay open indefinitely. New rules:

- **Idle lock:** 30 minutes without activity locks the project. You can change the time.
- **Sign-out** locks the project.
- **Running work wins:** the lock waits for it, because locking is refused during an Apply
  today. It then locks when the work ends.
- **Keep trying** can run for days. Starting it tells you the project stays open until it
  ends, and it can be stopped from any device.
- **Terminals** close at sign-out, or 5 minutes after the last connection is lost. An
  unattended root shell should not linger.
- **Tabs:** several tabs share the one open project. Locking or switching in one updates
  the others through `projects:sessionChanged`, which already exists for MCP.

### 3.8 Background jobs

| Job                   | Today                     | Web, at go-live                     |
| --------------------- | ------------------------- | ----------------------------------- |
| SSL renewal           | Only for the open project | Same                                |
| Cloudflare sync       | Only for the open project | Same                                |
| Log pruning           | At startup                | Also daily, as the server stays up  |
| Deployment recovery   | At unlock                 | Same                                |
| Temporary key cleanup | Startup and quit          | Same, as temporary keys are refused |
| Keep trying           | Open project only         | Same, alerts go to the browser      |

Renewing certificates for **all** projects while none is open is a real advantage of a
server. It needs the same refactor as multi-user support, so it is in Phase 8. Until then,
an unopened project behaves as it does today.

### 3.9 Data on the server

| Path                                 | Holds                                           | Protection                  |
| ------------------------------------ | ----------------------------------------------- | --------------------------- |
| `/var/lib/cloudforge/cloudforge.db`  | SQLite database; secrets are ciphertext         | Service user only           |
| `/var/lib/cloudforge/pulumi/state`   | Pulumi state, with secrets encrypted            | Service user only           |
| `/var/lib/cloudforge/pulumi/home`    | Pulumi plugins                                  | Service user only           |
| `/var/lib/cloudforge/keyslots.json`  | Master key wrapped by password and recovery key | Useless without one of them |
| `/var/lib/cloudforge/logs`           | Application logs, never payloads                | Service user only           |
| `/var/lib/cloudforge/tmp`            | Uploads, exports, Pulumi working folders        | Deleted after use           |
| `/opt/cloudforge/releases/<version>` | The installed application                       | Read-only for the service   |

SQLite stays. One process and one user are what it does well, and it keeps the existing
snapshot, migration and backup code. PostgreSQL is only worth considering in Phase 8.

---

## 4. Security design

A server like this holds the keys to every cloud account and server you manage, including
your clients'. Security is the largest part of this plan for that reason.

### 4.1 What it defends against

| Threat                                  | Defence                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------ |
| Internet scanners and password guessing | Nothing is publicly reachable (4.2); attempt limits (4.3)                |
| Someone gets your password              | Authenticator code (4.3)                                                 |
| Someone uses your unlocked browser      | Idle end, project lock, re-confirmation for sensitive actions (4.4, 4.5) |
| A malicious web page you visit          | Cookie rules, Origin checks, strict browser headers (4.7)                |
| Injected script in a page               | Strict Content-Security-Policy, no third-party scripts (4.7)             |
| Stolen disk, snapshot or backup         | Master key is not on the disk (4.6)                                      |
| A flaw in CloudForge's server process   | Non-root user and system sandbox (4.8)                                   |
| A bad or tampered update                | Signed releases and automatic rollback (section 10)                      |
| Not knowing something happened          | Sign-in history and activity feed (4.9)                                  |

**What it cannot fully stop:** someone with root on the running server, such as a
compromised hosting account, could read memory while it is unlocked. This is why the
server belongs to a separate hosting account with its own strong login.

### 4.2 Private access

The server listens on `127.0.0.1` only. Tailscale provides the private network and the
HTTPS certificate, and the cloud firewall allows no inbound connections from the internet.

- **Works from** your laptop and phone, once the free Tailscale app is signed in. No
  terminal is needed.
- **Fails from** any other device, even with your password. That is the point.
- **Traffic** is encrypted end to end between your device and the server.
- **Server SSH** is available only inside Tailscale. Your provider's web console is the
  emergency way in.
- **Names:** the HTTPS certificate makes the machine and network names public, in
  certificate logs. Use neutral names, with no client or company names.

See decision D1 for the alternative, Cloudflare Tunnel with Access.

### 4.3 Sign-in

- **First-time setup:** the installer prints a one-time setup code. Without it, nobody can
  claim the empty server by reaching the setup page first.
- **Password:** at least 14 characters, checked locally against a list of common
  passwords. It is never stored; it is proved by opening your wrapped master key (4.6).
- **Authenticator code:** standard 6-digit TOTP from any authenticator app. A code cannot
  be used twice.
- **Recovery:** 10 one-use codes for a lost phone, and one recovery key for a lost
  password (4.6).
- **Attempts:** delays grow after each failure per address and per account, and the account
  pauses for 15 minutes after 10 failures. Every attempt is recorded. The error never says
  which part was wrong.
- **Project passkeys** stay as they are, and now have the same attempt limit. Today they
  have none (Appendix E).
- **Naming:** in the app, "passkey" already means your project code, so a future hardware
  or fingerprint sign-in will be called a **security key**.

### 4.4 Sessions

| Setting          | Value                                                   |
| ---------------- | ------------------------------------------------------- |
| Cookie           | `__Host-` name, `Secure`, `HttpOnly`, `SameSite=Strict` |
| Token            | 256 random bits; the database keeps only its SHA-256    |
| Idle end         | 30 minutes (adjustable)                                 |
| Maximum length   | 12 hours, then sign in again                            |
| Management       | **Account → Sessions**: see them, end one, end all      |
| Changed password | Ends all other sessions                                 |

### 4.5 Re-confirmation for sensitive actions

These 50 actions ask for your password and code if your last confirmation is more than 15
minutes old. The server enforces this, not the page. They are marked † in Appendix A.

- **Destructive or costly (35):** the actions that MCP treats as critical and that change
  something, such as `infra:apply`, `infra:destroy`, `providers:terminateInstance`,
  `firewall:update`, `nginx:saveConfig` and `cloudflare:deleteZone`.
- **Reveals a secret (6):** `credentials:reveal`, `sshKeys:revealPrivate`,
  `sshKeys:exportPrivate`, `stacks:reveal`, `ansible:access`, `ssl:export`.
- **Shell access (2):** `terminal:open`, `terminal:exec`.
- **Everything at once, or control of the AI (7):** `backup:create`, `backup:importProject`,
  `mcp:updateSettings`, `mcp:regenerateToken`, `mcp:revealToken`, `mcp:clientConfig`,
  `mcp:resolveApproval`.

The existing typed-name checks and confirmation dialogs stay. MCP calls authenticate with
their token, and critical ones already wait for your approval in the window.

### 4.6 Encryption at rest

The desktop relies on Windows to protect its key. A server has no such protection: today's
fallback cipher would keep `secret.key` beside the database, so one disk copy would expose
everything. The web version uses key slots:

```
master key (random, 256 bits) ── encrypts ──► credentials, SSH keys, secrets,
    │                                         Pulumi passphrases, MCP token,
    │                                         authenticator secret
    ├── slot 1: wrapped by a key derived from your password (scrypt)
    └── slot 2: wrapped by your recovery key (shown once, you store it offline)
```

- The master key exists only in memory, from your first sign-in until the process stops.
- After a restart, the server is **sealed**. Nothing can be decrypted until you sign in.
- Changing your password rewraps one slot and does not touch your data.
- The database rows keep the same AES-256-GCM format. Only where the key comes from
  changes.
- The Pulumi passphrase moves from a plain file into the same protection.
- Later users would each get their own slot, so this design does not block them.

**The cost:** if you lose both the password and the recovery key, the stored secrets are
gone for good. Your cloud accounts and servers remain, but you would have to enter
credentials again.

### 4.7 Browser protection

- **Content-Security-Policy:** only the server's own scripts, `connect-src` limited to its
  own address, `frame-ancestors 'none'`, `base-uri 'none'`. Both the header and the build's
  `<meta>` tag change, because today's policy allows any `ws:` address.
- **Other headers:** HSTS, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, and a
  `Permissions-Policy` that allows only clipboard writing and notifications.
- **WebSocket:** checks the session cookie and an exact `Origin` when connecting, and ends
  when the session ends.
- **Other requests:** sign-in and uploads need the exact `Origin` and a custom header.
- **Input:** known channel names only, size limits, and JSON only. Full schema checks on
  every channel are a Phase 8 requirement, because today's types exist only at compile
  time (Appendix E).

### 4.8 Server hardening

- **Service:** runs as user `cloudforge`, never root, with `NoNewPrivileges`,
  `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices` and write access
  only to `/var/lib/cloudforge`.
- **Network from the app:** cloud metadata (`169.254.169.254`) is blocked, because Jenkins
  addresses are user-supplied and a server must not be tricked into reading its own
  metadata.
- **Machine:** automatic security updates, no other applications, and no Docker. CloudForge
  manages Docker on other servers over SSH and needs none locally.
- **Resources:** limits on memory, so a Pulumi run cannot starve the machine.
- **Stopping:** systemd waits up to 15 minutes for running work to finish.

### 4.9 Records

- A new device-level **sign-in history**: time, address, device, result. It is not inside
  a project, so it survives project changes and never enters a project backup.
- The existing activity feed and logs continue, and record `web` as the origin alongside
  `renderer` and `mcp`.
- Logs still never contain payloads. A test scans the logs for planted secrets.

### 4.10 Your clients

- Each client stays in its own project with its own passkey, keys and logs. The project
  boundary in `dispatch` is unchanged.
- Check your client agreements. Some may say where credentials can be kept, or require you
  to tell them about a new server that can access their systems.
- Client names, addresses and fingerprints stay out of this public repository. Hosting
  details live only on the server.

---

## 5. The server

| Item    | Recommendation                                                               |
| ------- | ---------------------------------------------------------------------------- |
| Machine | New small VPS: 2 vCPU, 4 GB RAM, 40 GB disk, x64                             |
| System  | Current Ubuntu LTS                                                           |
| Account | A separate hosting account, not one CloudForge manages, with 2FA turned on   |
| Created | By hand in the provider's page, **not** by a CloudForge stack                |
| Cost    | Estimate: $5–15 a month, plus cents for backup storage. Check current prices |

**Why not an existing server?**

- If CloudForge manages its own host, one wrong firewall rule or destroy could lock you
  out of the tool needed to fix it.
- On a production server, another application's flaw could reach every credential you hold.
- On a client's server, one client's machine would hold your other clients' keys.

**Memory is an estimate.** The Pulumi AWS and OCI plugins can use a lot of memory, so 4 GB
plus swap is my starting figure. Phase 5 measures a real preview before you buy anything.

---

## 6. Moving your data

The server's IP address is fixed, so it can be added to firewalls that limit SSH by address.

**For each project, in this order: a test project, then yours, then clients last.**

1. **On the desktop (updated with the Phase 0 fix):** Settings → Security → **Export
   project**, with the passkey and a backup passphrase. Older backups do not contain the
   Pulumi passphrase, so export again.
2. **Allow the server:** if a server or cloud firewall limits SSH by address, add the new
   server's IP. This changes real servers, so each one is approved first.
3. **In the browser:** project picker → **Import project**, choose the export, enter the
   passphrase and a new passkey.
4. **Automatic checks, read-only:**
   - Pulumi can open the state.
   - Each cloud credential passes its test.
   - Each saved server is reachable, and its fingerprint still matches.
   - Cloudflare and other service credentials work.
5. **The key check: Preview must show no changes.** A preview that wants to create,
   replace or delete anything stops the move for that project, and Apply stays blocked
   until you have looked at it.
6. **Mark the desktop copy as moved.** Actions that change anything are refused there,
   with a clear banner. This is a new setting.
7. **Keep the encrypted export** for at least 30 days, somewhere safe and away from the
   server.

**Why step 6 matters.** If the desktop and web copies both ran Apply, each would believe its
own state. That can create duplicate servers or delete the wrong one. The existing guide
already warns about this; the new setting enforces it.

**Going back:** export the project from the web and import it on the desktop. Only one copy
stays active.

**What moves with a project:** resources, targets, plans, credentials, SSH keys, secrets,
settings, activity, deployments, Pulumi state and logs. **What does not:** device settings
such as the MCP token, the theme, and your sign-in. Those are set up once on the server.

---

## 7. Page by page

### 7.1 Every page

| Page           | Change on the web                                                     |
| -------------- | --------------------------------------------------------------------- |
| Dashboard      | None                                                                  |
| Deployments    | None (Running work covers reloads)                                    |
| Containers     | None                                                                  |
| VPS Runtime    | None (Running work covers reloads)                                    |
| Nginx          | None; its download already works in a browser                         |
| Firewall       | None                                                                  |
| SSL            | None; its download already works in a browser                         |
| Cloudflare     | None                                                                  |
| Jenkins        | None                                                                  |
| Providers      | None                                                                  |
| Templates      | None                                                                  |
| Plugins        | None                                                                  |
| Projects       | Import by upload; "this computer" wording changes                     |
| Infrastructure | "Prepare SSH command" changes; Keep trying wording; Running work      |
| Terminal       | Reconnect message; warning before Ctrl+W closes the tab               |
| Ansible        | Copy button uses the browser                                          |
| WordPress      | Copy button uses the browser                                          |
| Docker Stacks  | Browser folder picker                                                 |
| Secrets        | Browser file picker; security banner shows the new mode               |
| SSH Keys       | Export becomes a download                                             |
| Logs           | **Open folder** becomes **Download log**; path shown is on the server |
| Updates        | Server updates (section 10)                                           |
| Settings       | Backup by upload and download; updates; MCP panel; security mode      |
| About          | Wording; links open in a new tab; diagnostics copy in the browser     |
| Documentation  | New web guide                                                         |

### 7.2 What behaves differently

- **Prepare SSH command.** It writes a key to a temporary folder and gives a command for
  your own terminal. On the web, that key would be on the wrong machine, and a decrypted key
  should not sit on the server. It becomes **Open in Terminal** (the built-in SSH terminal)
  and **Download key**, with the matching command.
- **Copy buttons.** Five places call `app:copyText` directly. All will use one helper that
  uses the browser clipboard on the web and the current route on the desktop. The clipboard
  works only on HTTPS, which you will have.
- **External links.** `app:openExternal` becomes a new tab.
- **Window alerts.** `flashFrame` and the native alert for MCP approvals and Keep trying
  become a browser notification, if you allow them, and a banner in every open tab.
- **MCP approvals with no tab open.** Nobody can answer, so the request times out and is
  refused. This is the safe outcome and the same rule as today.
- **Ctrl+K.** The palette already handles this shortcut; the test confirms that browsers do
  not take it first.
- **Ctrl+W in the terminal** deletes a word in a shell but closes a browser tab. A warning
  appears while a terminal is open.
- **Phones.** The layout was built for at least 1024 pixels wide, so version 1 targets
  desktop browsers. Signing in from a phone will work, but pages may be cramped.

### 7.3 New screens

| Screen              | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| First-time setup    | Setup code, password, authenticator QR, recovery key and codes |
| Sign in             | Password and code                                              |
| Confirm it's you    | The re-confirmation dialog                                     |
| Sealed              | After a restart: sign in to unseal                             |
| Reconnecting banner | Shows while the connection is down                             |
| Running work        | Section 3.5                                                    |
| Account & security  | Change password, new recovery codes, sessions, sign-in history |
| Server status       | Version, disk, memory, last backup, Pulumi version, restart    |
| Backups             | Bucket, schedule, last result, run now, restore steps          |

---

## 8. MCP on the web

MCP works on the web, and Claude Code connects the same way, with an address that is no
longer local:

```
claude mcp add --transport http cloudforge https://<your-private-name>/mcp --header "Authorization: Bearer <token>"
```

| Part           | Change                                                                               |
| -------------- | ------------------------------------------------------------------------------------ |
| Listening      | Still `127.0.0.1`, reached through the private HTTPS address                         |
| Host check     | Today allows only local names; adds your one configured private name                 |
| Origin check   | Still refuses web pages other than the app itself                                    |
| Token          | Same single token, kept under the master key. A sealed server refuses every client   |
| Permissions    | Same switches. **Use this computer** is removed, because it would mean the server    |
| Approvals      | Same dialog, in any open tab                                                         |
| Claude Desktop | Its bridge file is downloaded from Settings → MCP and needs Node.js on your computer |

Your computer must be on Tailscale for the address to work. Appendix D lists the 17 tools
that change.

---

## 9. Backups and recovery

Project exports are not enough on their own: they need you, one project at a time. The
server also makes a **complete encrypted backup every night**.

- **Contains:** a consistent database snapshot (`VACUUM INTO`, as today), all Pulumi state,
  the key slots and the settings.
- **Encryption:** the server holds only a public key derived from your recovery key, so it
  can create backups but can never read them, even if compromised.
- **Stored:** in an S3-compatible bucket at a different provider, with its own access key
  and its own bucket. 30 daily copies, 12 monthly.
- **Also made:** before every update and every restore.
- **Watched:** a failed backup shows on Server status and raises an alert.
- **Restore:** a new server's setup page offers **Restore from backup**, with the file and
  the recovery key.
- **Proved:** Phase 5 restores onto a second machine. An untested backup does not count.

**If the server dies:** create a new one, install, restore from last night's backup (about
an hour of your time, once rehearsed), and update any firewall that allows the old IP. If
you need something urgently meanwhile, the desktop app can import a project's latest export.

---

## 10. Updates

- **Release:** the existing `v*` tag also builds `cloudforge-server-<version>-linux-x64.tar.gz`
  on GitHub Actions, after the same checks. No Docker Desktop is involved on your PC.
- **Signature:** each file is signed with an Ed25519 key kept in GitHub secrets. The server
  has the public key and refuses anything else.
- **From the app:** the Updates page shows the new version and **Install**, with no terminal.
- **What Install does:**
  1. Refuses while work is running.
  2. Makes a backup.
  3. A small separate updater service checks the signature again and switches the release.
  4. Restarts, then checks health for 60 seconds.
  5. **If health fails, it switches back** to the previous release and data snapshot.
- **After an update** the server is sealed, so you sign in again.
- **The app can't update itself directly.** The main process has no permission to change
  its own program files. Only the updater can, and it does one fixed job.

---

## 11. Phases

Sizes are relative: **S** small, **M** medium, **L** large. Each phase ends with a test and
your review. Nothing touches a real server before Phase 6.

### Phase 0 — Fix the backup (S). Useful even without the web version

| #   | Task                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------- |
| 0.1 | Add the Pulumi passphrase to the encrypted part of the backup (manifest format 5)                    |
| 0.2 | `PulumiEngine` looks up the passphrase per stack, so an imported project keeps its own               |
| 0.3 | After an import, test that Pulumi can open the state; if not, say so and hold infrastructure actions |
| 0.4 | Explain clearly when an older backup is imported on another machine                                  |
| 0.5 | Correct `docs/MOVING-AND-RELEASING.md`, which says the passphrase is included                        |
| 0.6 | Release a desktop update                                                                             |

**Exit test:** export from profile A, import into a fresh profile B, and a real Pulumi
preview on a throwaway local stack succeeds. It fails without the fix.

### Phase 1 — Separate from Electron, with no behaviour change (M)

| #   | Task                                                                                            |
| --- | ----------------------------------------------------------------------------------------------- |
| 1.1 | Add `AppPlatform` with the Electron version                                                     |
| 1.2 | Change the 15 shared files in Appendix C to use it                                              |
| 1.3 | `registerHandler` stops touching `ipcMain`; `emitEvent` stops touching `webContents`            |
| 1.4 | Move the code as in section 3.1, in one mechanical commit                                       |
| 1.5 | ESLint: `electron` only in `apps/desktop`                                                       |
| 1.6 | Add `WEB_COVERAGE: Record<IpcChannel, WebDecision>` and its test, with the Appendix A decisions |
| 1.7 | Move CI from Node 20, which is past end of life, to the current Node LTS                        |

**Exit test:** all unit tests, both E2E runs and the packaged app pass as they do
now. You run `run_infrastructure_as_code` and notice no difference.

### Phase 2 — The web server, on this PC only (M)

| #   | Task                                                                                    |
| --- | --------------------------------------------------------------------------------------- |
| 2.1 | `apps/server`: Node `http` and `ws`, no web framework, to keep the attack surface small |
| 2.2 | Server version of `AppPlatform`                                                         |
| 2.3 | WebSocket bridge with resume (section 3.4); `dispatch` origin `web`                     |
| 2.4 | Web build of the pages, with the browser bridge; strict headers                         |
| 2.5 | `pnpm dev:web`; binds to `localhost` only, with a random start code                     |
| 2.6 | Move the E2E checks to Playwright so they run in a real browser                         |

**Exit test:** all 25 pages open in Chrome, Edge and Firefox on a throwaway profile, and
the ported checks pass. Desktop-only actions are expected to fail until Phase 4.

### Phase 3 — Security (L)

| #    | Task                                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------- |
| 3.1  | Tables: `AppUser`, `AuthSession`, `AuthEvent`, added through `migrateSchema`, kept out of project backups |
| 3.2  | Master key, key slots and sealed state (section 4.6)                                                      |
| 3.3  | Pulumi passphrase and MCP token under the master key                                                      |
| 3.4  | First-time setup, sign-in, authenticator code, recovery                                                   |
| 3.5  | Sessions, idle end, list and end sessions                                                                 |
| 3.6  | Re-confirmation for the 50 actions; table enforced on the server, with a test                             |
| 3.7  | Attempt limits for sign-in and every passkey check                                                        |
| 3.8  | Refuse every path option on the server; a test covers each one                                            |
| 3.9  | Project idle lock, lock at sign-out, terminals closed (section 3.7)                                       |
| 3.10 | Browser protections (section 4.7); sign-in history                                                        |

**Exit test:** the security checks in section 12 pass, followed by an independent code
review of this phase. Findings are fixed before Phase 4.

### Phase 4 — Everything that was desktop-only (L)

| #   | Task                                                                           |
| --- | ------------------------------------------------------------------------------ |
| 4.1 | Upload and download service; `.cfbackup` format                                |
| 4.2 | The six dialogs become browser flows (section 3.6)                             |
| 4.3 | Running work: shared operations service, panel, re-attach                      |
| 4.4 | Page changes in section 7.1, and shell-aware wording                           |
| 4.5 | Browser notifications and banners                                              |
| 4.6 | Crash recovery: clear stale Pulumi locks on startup and flag projects to check |
| 4.7 | MCP web mode (section 8, Appendix D)                                           |
| 4.8 | Project "moved" mark on the desktop (section 6)                                |
| 4.9 | The new screens in section 7.3, except backups and server updates              |

**Exit test:** every Appendix A action works in the browser. Closing the tab, reloading,
and cutting the network during a long fake operation all recover correctly.

### Phase 5 — Packaging, backups and updates (L)

| #   | Task                                                                             |
| --- | -------------------------------------------------------------------------------- |
| 5.1 | Linux bundle: app, Node, Prisma engine, pinned Pulumi CLI and plugins            |
| 5.2 | Install script with a dry-run mode; systemd service and sandbox                  |
| 5.3 | Nightly backups and restore (section 9)                                          |
| 5.4 | Signed releases and the updater with rollback (section 10)                       |
| 5.5 | CI: build and test on Ubuntu; add to the release workflow                        |
| 5.6 | Measure Pulumi memory, and confirm or change the server size                     |
| 5.7 | Guides: `docs/WEB.md`, updates to Security, Packaging, Moving, IPC, MCP, Privacy |

**Exit test, on disposable Ubuntu machines:** a fresh install works; an update from one
version to the next works; a deliberately broken update rolls back; a backup restores on a
second machine with everything intact.

### Phase 6 — Go live with a test project (S, with waiting)

Every step on the server is shown to you first, as your rule requires.

| #   | Who  | Task                                                                      |
| --- | ---- | ------------------------------------------------------------------------- |
| 6.1 | You  | Create the hosting account and VPS; install Tailscale on your devices     |
| 6.2 | Me   | Show the final install script and its dry run, and wait for your approval |
| 6.3 | Me   | Harden, install, and close public access                                  |
| 6.4 | You  | First-time setup; store the recovery key offline                          |
| 6.5 | You  | Add the backup bucket; approve the first backup                           |
| 6.6 | Both | Test project, with no real client data, through every page                |
| 6.7 | Me   | Check from outside that nothing is publicly reachable                     |
| 6.8 | Both | One week of normal use, with a real restore drill                         |

**Exit test:** a full week without a blocker. The outside scan finds nothing open, and the
restore drill passes.

### Phase 7 — Move real projects (S per project)

| #   | Task                                                                       |
| --- | -------------------------------------------------------------------------- |
| 7.1 | Your own least important project, using section 6                          |
| 7.2 | Your other projects, one at a time, with time between them                 |
| 7.3 | After 2 calm weeks: client projects, once you have checked your agreements |
| 7.4 | After 30 days: remove moved projects from the desktop, if you wish         |

**Exit test:** for each project, Preview shows no changes and all saved servers respond.

### Phase 8 — Later, only if you decide to

Not part of this plan's build. Listed so you can see what opening it to others would take.

| Need                              | Why                                                                        |
| --------------------------------- | -------------------------------------------------------------------------- |
| Project context per request       | `InMemoryProjectContext` allows one open project per process, for everyone |
| Users and project permissions     | Decide who sees which project                                              |
| Events sent per user and project  | `emitEvent` sends everything to everyone                                   |
| Project log per request           | `setActiveLogProject` is one global value                                  |
| Runtime checks on every channel   | Today's types exist only at compile time                                   |
| One MCP token per person          | Today there is one per device                                              |
| Public access with a login gate   | Most likely Cloudflare Access                                              |
| Background jobs for all projects  | The same refactor; also useful for you alone (section 3.8)                 |
| PostgreSQL, if it outgrows SQLite | Only if needed                                                             |

The first item is the big one. It also allows **several projects open at once**, and
certificate renewal for all of them, which could justify doing it even for one user.

---

## 12. Testing

**Reused:** all unit tests, and the 96 + 37 E2E checks, ported to a real browser.

**New automated tests:**

| Area       | What is proved                                                                        |
| ---------- | ------------------------------------------------------------------------------------- |
| Coverage   | Every channel has a web decision; every re-confirmation channel is enforced           |
| Access     | No session: every channel, upload, download and WebSocket is refused                  |
| Origin     | A wrong `Origin` is refused on WebSocket, sign-in and upload                          |
| Cookies    | Exact flags; the token is never in a URL or log; the database holds only a hash       |
| Sign-in    | Wrong password, wrong code, reused code, limits, recovery codes, setup code once only |
| Sealed     | After restart, nothing can decrypt and each client is refused                         |
| Disk copy  | Given the database, state and key slots but no password: no secret can be opened      |
| Re-confirm | Each of the 50 is refused without a recent confirmation, and allowed with one         |
| Paths      | Every path option is refused; static files and downloads cannot escape their folder   |
| Backups    | Crafted archives with `../` and unknown names write nothing outside the folder        |
| Resume     | Network cut mid-work: no event lost, nothing runs twice                               |
| Secrets    | Planted secrets never appear in logs, activity or error messages                      |
| Updates    | Bad signature refused; failed health check rolls back                                 |
| Desktop    | Everything still passes, as the release gate does today                               |

**Manual checks before go-live:**

- An independent security review of the finished server code.
- A port scan from outside your network.
- A restore drill.
- A test of each page on a throwaway project, in three browsers.

---

## 13. Risks

| Risk                                          | Effect                               | What reduces it                                                         |
| --------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| Moved state differs from the real cloud       | Wrong Preview, or a harmful Apply    | "No changes" check before Apply is allowed (section 6)                  |
| Desktop and web both change one project       | Duplicate or deleted resources       | "Moved" mark refuses changes on the desktop                             |
| Server is down when you need it               | No CloudForge for a while            | Status alerts; restore drill; the desktop can import an export          |
| You lose the password and the recovery key    | Stored secrets cannot be opened      | Recovery key stored offline, in two places; check at setup              |
| Your laptop is compromised while signed in    | The attacker acts as you             | Idle end, re-confirmation; end all sessions from your phone             |
| The hosting account is compromised            | Memory or disk of the running server | Separate account with 2FA; sealed disk; no client hosting there         |
| A crash during an Apply                       | Stale lock or uncertain state        | Lock cleanup and "check this project" flag; same risk on desktop today  |
| A client firewall allows only known addresses | Actions fail after the move          | Read-only reachability check before anything else                       |
| Pulumi needs more memory than planned         | Failed runs                          | Measured in Phase 5; swap; larger server is easy                        |
| A bad update                                  | Downtime                             | Backup first, health check, automatic rollback                          |
| Dependency flaws                              | Server exposure                      | Pinned lockfile; release blocked on high audit findings, as today       |
| Tailscale is unavailable                      | You can't reach the app for a while  | Provider console for emergencies; existing connections usually continue |

---

## 14. Decisions for you (my recommendation first)

| #   | Decision                        | Recommended                                                      | Alternative                                                                                                                                  |
| --- | ------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | How do you reach it?            | **Tailscale.** Nothing public; encrypted end to end              | **Cloudflare Tunnel with Access.** Any browser with no app, but Cloudflare decrypts the traffic at its edge, including secrets and terminals |
| D2  | Where does it run?              | **New small VPS** in a separate account                          | An existing server: cheaper, with the risks in section 5                                                                                     |
| D3  | Where does the secret key live? | **Unlocked by your sign-in.** A restart needs you to sign in     | **Key file on the server.** Starts by itself, but a full disk copy exposes everything                                                        |
| D4  | Keep the desktop app?           | **Yes.** It's a fallback and costs little after Phase 1          | Web only: slightly less to maintain, and no local fallback                                                                                   |
| D5  | How is it installed?            | **Bundle with systemd.** Stronger sandbox, no Docker on the host | Docker image: familiar, but adds a privileged service                                                                                        |
| D6  | Second sign-in factor?          | **Authenticator app** now; security keys later                   | Security keys now: stronger, but more to build first                                                                                         |
| D7  | Move client projects when?      | **Last,** after 2 calm weeks, once agreements are checked        | Earlier, with more risk                                                                                                                      |
| D8  | Where do backups go?            | **An S3-compatible bucket** at another provider                  | Your choice of provider. It must not be the server's own disk                                                                                |
| D9  | Phone support in version 1?     | **Sign-in works, full layout later**                             | Rebuild the layout for phones first: adds a large phase                                                                                      |
| D10 | Alerts when no tab is open?     | **Browser alerts first;** add phone alerts if you miss them      | Add Telegram or email now. The message would go through that service, so it would stay generic                                               |

---

## 15. What is not in this plan

- Public sign-up, teams or billing.
- Hosting CloudForge for other people.
- Replacing Pulumi, SSH or SQLite.
- Several servers for high availability. One server with tested backups suits one user.
- Rebuilding the pages. They stay the same React code.

---

## Appendix A — Every action (222)

**Same** means the same handler and result, inside sign-in, limits and project boundary.
**†** means re-confirmation (section 4.5). **Bold** means the behaviour changes, as
explained below each table.

| Group (count)    | Actions                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| activity (1)     | list                                                                                                                                                                                                                                                                                                                                                                                |
| ansible (21)     | profiles, targets, getTarget, createTarget, updateTarget, deleteTarget†, inspectHostKey, status, profileStates, preflight, repair, bootstrap, run, jenkinsAction, access†, cancel, nginxSites, nginxUpsert, networks, createNetwork, nginxRemove†                                                                                                                                   |
| app (7)          | **getInfo**, ping, **openExternal**, **copyDiagnostics**, **copyText**, synchronize, backgroundJobs                                                                                                                                                                                                                                                                                 |
| backup (3)       | **create**†, **restore**†, **importProject**†                                                                                                                                                                                                                                                                                                                                       |
| cloudflare (27)  | test, dashboard, zones, createZone, deleteZone†, dnsRecords, createDnsRecord, updateDnsRecord, deleteDnsRecord†, batchDnsRecords†, ensureDns, verifyDns, zoneSettings, updateZoneSettings, purgeCache†, security, analytics, pageRules, savePageRule, deletePageRule†, redirectRules, saveRedirectRule, deleteRedirectRule†, platform, dnsTemplates, applyDnsTemplate, withdrawDns† |
| containers (5)   | list, action†, logs, stats, deployCompose                                                                                                                                                                                                                                                                                                                                           |
| credentials (7)  | list, kinds, create, update, **importEnvironmentFile**, reveal†, delete†                                                                                                                                                                                                                                                                                                            |
| deploy (6)       | templates, list, count, inspectHostKey, cancel, run                                                                                                                                                                                                                                                                                                                                 |
| domains (1)      | check                                                                                                                                                                                                                                                                                                                                                                               |
| firewall (4)     | get, update†, analyze, history                                                                                                                                                                                                                                                                                                                                                      |
| hostAccess (4)   | inspect, instructions, grant†, revoke†                                                                                                                                                                                                                                                                                                                                              |
| hostFirewall (3) | inspect, open, close†                                                                                                                                                                                                                                                                                                                                                               |
| infra (23)       | engineStatus, getPlan, savePlan, validate, preview, apply†, **keepTrying**†, stopTrying, tryingStatus, destroy†, refresh, outputs, managedStacks, destroyStack†, templates, applyTemplate, customTemplates, getCustomTemplate, resourcePresets, sshConnections, saveTemplate, deleteTemplate†, applyCustomTemplate                                                                  |
| jenkins (6)      | list, test, save, delete†, trigger, status                                                                                                                                                                                                                                                                                                                                          |
| logs (5)         | **info**, tail, **openFolder**, report, prune                                                                                                                                                                                                                                                                                                                                       |
| mcp (7)          | **status**, updateSettings†, regenerateToken†, revealToken†, **clientConfig**†, pendingApprovals, resolveApproval†                                                                                                                                                                                                                                                                  |
| nginx (13)       | inspect, listSites, saveSite, removeSite†, readConfig, saveConfig†, reload, liveStatus, logs, backups, readBackupConfig, restore†, compareBackup                                                                                                                                                                                                                                    |
| plugins (5)      | list, active, install, setEnabled, uninstall                                                                                                                                                                                                                                                                                                                                        |
| projects (13)    | picker, list, get, create, duplicate, update, delete†, count, session, **unlock**, lock, changePasskey†, removePasskey†                                                                                                                                                                                                                                                             |
| providers (9)    | test, listRegions, listShapes, listImages, listAvailabilityDomains, listInstances, listResources, instanceAction†, terminateInstance†                                                                                                                                                                                                                                               |
| runtime (12)     | inspect, getPlan, savePlan, validatePlan, setMode, drift, adopt, release, connectivity, openFirewall, preview, apply†                                                                                                                                                                                                                                                               |
| security (1)     | **status**                                                                                                                                                                                                                                                                                                                                                                          |
| settings (3)     | get, update, newProjectDefaults                                                                                                                                                                                                                                                                                                                                                     |
| sshKeys (7)      | list, generate, import, revealPrivate†, **exportPrivate**†, **materializePrivate**, delete†                                                                                                                                                                                                                                                                                         |
| ssl (5)          | verifyDns, list, issue, export†, renewDue                                                                                                                                                                                                                                                                                                                                           |
| stacks (9)       | list, analyze, **chooseFolder**, create, reveal†, update, redeploy, status, remove†                                                                                                                                                                                                                                                                                                 |
| terminal (5)     | open†, write, resize, close, exec†                                                                                                                                                                                                                                                                                                                                                  |
| updates (4)      | **check**, **state**, **download**, **install**†                                                                                                                                                                                                                                                                                                                                    |
| wordpress (6)    | list, create, redeploy, update, status, remove†                                                                                                                                                                                                                                                                                                                                     |

**The 22 that change:**

| Action                                                    | On the web                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| `app:getInfo`                                             | Adds the shell type and server versions; Electron fields empty          |
| `app:openExternal`                                        | Handled in the browser: new tab with the same fixed links               |
| `app:copyDiagnostics`                                     | Formatted and copied in the browser                                     |
| `app:copyText`                                            | Browser clipboard                                                       |
| `backup:create`, `backup:restore`, `backup:importProject` | Files by download and upload; path options refused; restart via systemd |
| `credentials:importEnvironmentFile`                       | Browser file picker; path option refused                                |
| `infra:keepTrying`                                        | Browser alert in place of the native alert; no power blocker            |
| `logs:info`, `logs:openFolder`                            | Server path shown for information; download in place of open            |
| `mcp:status`, `mcp:clientConfig`                          | Private address; Claude Code command; bridge as a download              |
| `projects:unlock`                                         | Attempt limit added; so are the other passkey checks                    |
| `security:status`                                         | Reports a mode (OS keychain, local key, or server vault)                |
| `sshKeys:exportPrivate`                                   | Browser download; path option refused                                   |
| `sshKeys:materializePrivate`                              | Refused on the server (section 7.2)                                     |
| `stacks:chooseFolder`                                     | Browser folder picker; path option refused                              |
| `updates:check`, `state`, `download`, `install`           | Server updater (section 10)                                             |

---

## Appendix B — Every event (19)

All are sent over the WebSocket with a sequence number.

| Event                                                                                                                       | Note                                                        |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `engine:log`, `deploy:log`, `ansible:log`, `nginx:log`, `runtime:log`, `ssl:log`, `wordpress:log`, `stacks:log`             | Also kept for Running work, so reloads lose nothing         |
| `terminal:data`, `terminal:closed`                                                                                          | Replayed on a quick reconnect; session ends after 5 minutes |
| `infra:tryingChanged`                                                                                                       | Same, plus a browser alert for the result                   |
| `updates:state`                                                                                                             | Same event, from the server updater                         |
| `vpsTargets:changed`, `cloudflare:changed`, `app:dataChanged`, `projects:sessionChanged`, `ui:command`, `mcp:statusChanged` | Same                                                        |
| `mcp:approvalsChanged`                                                                                                      | Same, plus a browser alert in place of the window flash     |

New events: `operations:changed`, `auth:sessionEnded`, `server:restarting`.

---

## Appendix C — Every file that imports Electron (21)

| File                                        | Uses                                                | Becomes                                      |
| ------------------------------------------- | --------------------------------------------------- | -------------------------------------------- |
| `preload/index.ts`                          | `contextBridge`, `ipcRenderer`                      | **Desktop only**; web has its own bridge     |
| `main/index.ts`                             | App lifecycle, session, CSP                         | **Desktop only**; server has its own entry   |
| `main/window.ts`                            | `BrowserWindow`                                     | **Desktop only**                             |
| `main/updates/update-manager.ts`            | `electron-updater`                                  | **Desktop only**; server has its own         |
| `main/security/external-links.ts`           | `shell.openExternal`                                | **Desktop only**; browser opens links        |
| `main/security/secret-cipher.ts`            | `safeStorage`, `app`                                | **Desktop only**; server has its own vault   |
| `main/container.ts`                         | `app.getPath`                                       | `platform.dataDir`                           |
| `main/ipc/registry.ts`                      | `ipcMain.handle`                                    | Handler table; desktop binds `ipcMain`       |
| `main/ipc/emit.ts`                          | `webContents.send`                                  | `platform.broadcast`                         |
| `main/ipc/handlers/app.handlers.ts`         | `clipboard`, `app`                                  | `platform`; clipboard desktop only           |
| `main/ipc/handlers/backup.handlers.ts`      | `dialog`, `app.getPath`, `relaunch`, `exit`         | `platform`; uploads on the server            |
| `main/ipc/handlers/credentials.handlers.ts` | `dialog`                                            | `platform.pickFile`; refused on the server   |
| `main/ipc/handlers/logs.handlers.ts`        | `shell.openPath`                                    | Desktop only; download on the server         |
| `main/ipc/handlers/projects.handlers.ts`    | `app.getPath`                                       | `platform.dataDir`                           |
| `main/ipc/handlers/ssh-keys.handlers.ts`    | `dialog`                                            | `platform.saveFile`; refused on the server   |
| `main/ipc/handlers/stacks.handlers.ts`      | `dialog`                                            | `platform.pickFolder`; refused on the server |
| `main/infra/engine.ts`                      | `app.getPath`                                       | `platform.dataDir`; passphrase per stack     |
| `main/infra/keep-trying.ts`                 | `Notification`, `BrowserWindow`, `powerSaveBlocker` | `platform.notify`, `keepAwake`               |
| `main/logging/logger.ts`                    | `app.getPath`, `will-quit`                          | `platform.dataDir`, `onShutdown`             |
| `main/mcp/index.ts`                         | `BrowserWindow`, `app.getAppPath`, `isPackaged`     | `platform.bringToFront`, `resourcesDir`      |
| `main/security/project-key-files.ts`        | `app.getPath`                                       | `platform.dataDir`; unused on the server     |

Other points: `owner-only-file.ts` already handles Linux with `chmod`, `tool-path.ts` needs
no change, and `ssh2` falls back to pure JavaScript if its optional native part is missing.

---

## Appendix D — The 17 MCP tools that change

| Tool                                                                                                    | On the web                                                                                         |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `app_open_link`, `app_copy_to_clipboard`, `logs_open_folder`                                            | Hidden: they would act on the server, not your computer                                            |
| `ssh_keys_materialize_private`                                                                          | Hidden: it would leave a decrypted key on the server                                               |
| `ui_navigate`, `ui_set_theme`                                                                           | Kept: they act on open browser tabs, and do nothing if none is open                                |
| `credentials_import_environment_file`, `stacks_read_folder`                                             | Hidden: there is no local file; `credentials_create` and `stacks_create` take the content directly |
| `ssh_keys_export_private`                                                                               | Hidden: `ssh_keys_reveal_private` returns the key, if you allow secrets                            |
| `backup_create_project`, `backup_restore_project`, `backup_import_project`                              | Hidden from clients at first: backups use the browser                                              |
| `ssh_keys_import`, `stacks_create`, `stacks_update`, `ssl_export_certificate`, `ssl_export_private_key` | Kept, but path arguments are refused; content is passed or returned instead                        |

The **Use this computer** switch disappears on the server. `mcp/catalog/local-files.ts`
stays the single list of what touches local files, and its test still applies.

---

## Appendix E — Problems found while reading

Listed with where they are. Only E1 blocks moving your data today.

| #   | Problem                                                                                                                                                                                                                                                       | Where                                                                              | Fixed in                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------- |
| E1  | **Backups leave out the Pulumi passphrase.** On another machine, every Pulumi action fails. Tested with Pulumi 3.252.0: `failed to decrypt: incorrect passphrase`. With the original passphrase, the same state works. The guide wrongly says it is included. | `backup.handlers.ts`, `container.ts`, `infra/engine.ts`, `MOVING-AND-RELEASING.md` | Phase 0                                   |
| E2  | No limit on passkey attempts                                                                                                                                                                                                                                  | `project-session-service.ts`                                                       | Phase 3                                   |
| E3  | Passkey hashes use Node's default scrypt cost: acceptable locally, low for a server. `passkeyVersion` allows raising it                                                                                                                                       | `project-passkey-hasher.ts`                                                        | Phase 3                                   |
| E4  | Pulumi passphrase is a plain file                                                                                                                                                                                                                             | `infra/engine.ts`                                                                  | Phase 3                                   |
| E5  | The fallback key sits next to the database, which is what a Linux server would use                                                                                                                                                                            | `secret-cipher.ts`                                                                 | Phase 3                                   |
| E6  | Path options check only a path's shape, so on a server they could read or write any file the service can reach                                                                                                                                                | `local-paths.ts` and its callers                                                   | Phase 3                                   |
| E7  | A channel's request is checked only by TypeScript types, not when it runs                                                                                                                                                                                     | `ipc/registry.ts`                                                                  | Limits in Phase 2; full checks in Phase 8 |
| E8  | A running operation's logs live in the page, so a reload would lose them                                                                                                                                                                                      | `useEngineLogs` and similar hooks                                                  | Phase 4                                   |
| E9  | Nothing clears a stale Pulumi lock after a crash. Found by reading; not yet tested                                                                                                                                                                            | `packages/pulumi`                                                                  | Phase 4                                   |
| E10 | Background jobs run only for the open project, so a certificate in an unopened project is not renewed                                                                                                                                                         | `container.ts`                                                                     | Phase 8                                   |
| E11 | Events go to every window, and the project log is one global value: fine for one user, not for several                                                                                                                                                        | `ipc/emit.ts`, `logging/logger.ts`                                                 | Phase 8                                   |
| E12 | CI and release pin Node 20.19.6, which is past end of life                                                                                                                                                                                                    | `.github/workflows`                                                                | Phase 1                                   |
| E13 | Today's Content-Security-Policy allows any `ws:` address: harmless in a desktop window, too open on the web                                                                                                                                                   | `main/index.ts`, `electron.vite.config.ts`                                         | Phase 2                                   |
