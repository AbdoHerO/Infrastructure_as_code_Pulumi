# Phase 0 — Docs vs Code Discrepancies + Conventions to Follow

The existing `docs/` are good but trail the code. Verified discrepancies below; treat the source
as authoritative.

## Discrepancies found

| #   | Doc claim                                                                                                  | Reality (code)                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | "85 unit tests" (README, docs/README), "85/85 across 19 files" (ROADMAP), "62 across 15 files" (CHANGELOG) | **166 test cases across 41 test files**                                                                                                                                                                                                 |
| 2   | "7 packages + 1 app" (README, docs/README)                                                                 | **8 packages** — `service-providers` omitted; PACKAGES.md internally inconsistent (tree shows 7, sections cover 8)                                                                                                                      |
| 3   | "features/ (14 modules)" (ARCHITECTURE.md)                                                                 | **23 renderer feature folders**                                                                                                                                                                                                         |
| 4   | CHANGELOG "Unreleased" ends at Phase 19                                                                    | Ships undocumented: **AWS provider, Cloudflare, Jenkins Pipelines, SSL & Domains, Firewall Manager, Nginx Manager, SSH Terminal, VPS target sync, Phase 20 Ansible**                                                                    |
| 5   | ROADMAP: "CloudForge intentionally advertises only Oracle Cloud"                                           | **AWS fully implemented** (provider + Pulumi program + template + docs)                                                                                                                                                                 |
| 6   | IPC.md channel catalogue                                                                                   | Missing ~20 channels present in `contract.ts` (providers:listImages, app:copyText/copyDiagnostics/openExternal/synchronize, ansible:jenkinsAction, many cloudflare:*, nginx:readBackupConfig, sshKeys:exportPrivate/materializePrivate) |
| 7   | ROADMAP is titled a roadmap                                                                                | It is a **completion report** — no planned-features section exists anywhere; **no workflow/automation feature is planned in any doc** (Automation Studio is greenfield)                                                                 |
| 8   | PACKAGING.md: asarUnpack of prisma/ssh2/pulumi                                                             | electron-builder.yml actually uses **`asar: false`** + staged `.packaged-runtime` closure                                                                                                                                               |

Accurately documented as unused/stubbed (not discrepancies): Provider table, SshKey table,
non-integrated credential kinds (azure/openai/anthropic/gitlab/dockerhub), read-only Cloudflare
platform surfaces, declarative-only plugins, wildcard-SSL rejection (no DNS-01 adapter).

## Security issues discovered during reverse engineering (pre-existing, worth fixing)

- Sibling repo `ansible-playbook-deploy` contains **committed secrets**: an SSH private key
  (`keys/`), WireGuard private keys (`wireguard/`), and a hardcoded Slack webhook (`check.sh:41`).
  It is not consumed by the app, but the keys should be rotated and purged.
- IPC has **no runtime payload validation and no sender validation** (compile-time types only) —
  acceptable under current sandbox posture, but Automation Studio's new channels (which will
  execute arbitrary-ish workflow definitions) should add runtime validation.

## Architecture conventions Automation Studio MUST follow (doc + code confirmed)

1. **Layering**: `shared` ← `core` (domain + application + ports) ← adapters (`database`,
   `deployment`, `providers`, `pulumi`, `service-providers`) ← `desktop`. Core never imports an
   adapter. New engine logic belongs in `packages/core/src/application/automation/` (service +
   ports), persistence in `packages/database`, wiring only in `container.ts`.
2. **No business logic in React** — the workflow editor renders state + dispatches intents via
   React Query hooks; execution semantics live in core.
3. **Result pattern everywhere**: expected failures as `Result<T, AppError-subclass>`, `toAppError`
   at boundaries; a new `AutomationError`/reuse of existing codes should slot into the taxonomy.
4. **IPC contract-first**: extend `contract.ts` + `IPC_CHANNELS` (+ event allow-list for
   `workflow:log`-style streams), add handler with `registerHandler`/`orThrow`, register in
   `main/ipc/index.ts`. Streams correlated by `streamId`.
5. **Secrets never cross IPC or enter workflow state** — reference credential/target IDs; resolve
   main-side at execution time.
6. **Schema changes**: edit `schema.prisma`, regenerate `bootstrap.sql` (`db:bootstrap-sql`), add
   idempotent steps to `migrateSchema()` (no Prisma migrations dir).
7. **Destructive-action policy**: renderer must use `useConfirmation`/`NameConfirmationDialog`
   (test-enforced, `renderer-confirmation-policy.test.ts` — new destructive pages must be added
   to that test's list).
8. **Audit**: mutating operations call `activityService.recordSafe`.
9. **Strict TS/quality gate**: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
   `verbatimModuleSyntax`; `typecheck` + `lint` + `test` + `build` all green; kebab-case files,
   one barrel per package; internal packages ship as TS source (electron-vite aliases).
10. **Provider independence**: cloud logic behind `CloudProvider`; service-provider logic behind
    `ServiceProvider` — never mixed, never passed to Pulumi.

## Docs to update when Automation Studio ships

- CHANGELOG (backfill Phases 20+ features first), README/docs/README counts, ARCHITECTURE module
  count, IPC.md new channels, MODULES.md new module, DATA-MODEL.md new tables, ROADMAP successor.
