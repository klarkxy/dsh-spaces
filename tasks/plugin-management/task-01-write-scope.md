# Task 01 — measured plugin install write scope and restore boundary

Date: 2026-09-15. Status: measured on this machine; later tasks 02–11 are not done.

This is the task 01 experiment, not the 2026-09-13/14 rc.1/rc.2 standard-install acceptance and not a whole-Home snapshot restore.

Probe: `scripts/verify-plugin-install-write-scope.mjs`  
Record format: `src/main/plugin-restore-point.ts`  
Unit test: `tests/plugin-restore-point.test.ts`  
CLI: official `@deepseek-ai/dsh` 0.1.5-rc.1 via the same resolver as `scripts/verify-spaces-distribution.mjs`.  
Package: two packed versions of `@dsh-spaces/write-scope-probe` (1.0.0 and 1.0.1) installed with `dsh plugin --profile <name> add` / `remove` into ordinary spaces `alpha` and `beta` on a disposable Home. Real `~/.dsh` was refused and its listing/mtime did not change.

Two consecutive live runs both passed with the same primary observables (alpha 1.0.0, beta 1.0.1, non-empty lock/deps/link write scope, offline restore of alpha still dump-config started at 1.0.0, beta config and hub sessions/storages unchanged).

## Measured write scope

Official `dsh plugin add` is a pnpm forwarder in the profile directory (`nodeLinker: hoisted`). Walk-before/walk-after of the disposable Home **and** the isolated pnpm store (not a guessed path list):

### Install into one ordinary space (`alpha` add 1.0.0)

Home (13 paths), all under `profiles/alpha/`:

- `package.json` (manifest; dependency + `dsh.profile.bundles`)
- `pnpm-lock.yaml` and `node_modules/.modules.yaml` (locks)
- `node_modules/@dsh-spaces/write-scope-probe/` (real hoisted package files: `package.json`, `index.js`, `cordis.patch.yml`)
- `node_modules/.pnpm/` metadata

Store (523 paths on first add in a fresh store): content-addressed tarball files under `v10/files/…`, plus **one link** `v10/projects/<hash>` → the profile directory.

`profiles/node_modules` (CLI runtime fallback tree) was **not** written by this add/remove on a dump-config-seeded Home. Product Homes that have already booted still grow that tree; `snapshot-store.copyLinkedTree` already omits those CLI fallback links when the copy root is `profiles`.

### Install a different version into the peer (`beta` add 1.0.1)

Home: the same 13-path shape under `profiles/beta/` only.  
Store: 9 additional paths (second tarball + `v10/projects/<hash>` → `profiles/beta`).  
`profiles/alpha/` was not in this diff.

### Uninstall (`alpha` remove)

Home only (11 paths), all under `profiles/alpha/` (lock, manifest, probe package files). Store was not rewritten.

Sessions, storages, `.credentials.yaml`, `.anonymous-user-id`, other spaces, and the CLI runtime were not in the add/remove diffs.

## Restore boundary (frozen)

**Ordinary plugin restore is independent per space** when the profile tree holds the installed package files (this CLI’s hoisted layout).

- Enough to save/restore: `profiles/<space>/` (manifest, lock, workspace file, `cordis.patch.yml`, `node_modules` including the hoisted package). `copyLinkedTree` of that directory succeeded; dest links stay inside the copied tree.
- Not enough / not safe to restore as part of a single-space operation: the **shared pnpm store**. First use creates the store layout; each profile gets a store project link *out* to that profile. `copyLinkedTree` of the store throws `External link is not in snapshot scope` (project entry → another space’s profile). Restoring the store after a peer install would require pausing every store referencer and still would not be a link-preserving isolated copy.
- `profiles/node_modules` CLI fallback links, when present, stay a boot-heal concern (existing snapshot copy already skips them with `fallbackRuntimeRoot`). They are not the ordinary plugin restore set.

Offline proof: after `dsh plugin remove` on alpha, only `profiles/alpha` was copied back with `copyLinkedTree`; `npm_config_offline=true` `dsh --profile alpha --dump-config` succeeded and the installed package was again 1.0.0. Beta’s profile hashes and `hub/beta/sessions|storages` markers matched the pre-restore values. Alpha’s session/storage markers were not rolled back.

If a later CLI/layout leaves profile `node_modules` as links *into* the shared store, `copyLinkedTree(profiles/<space>)` will fail with an external link. That case is `shared-deps-require-pause` and must not overwrite the store while other spaces still reference newer content. Task 01 did not observe that layout on 0.1.5-rc.1 hoisted installs.

`linkPreservingCopySufficient`: **true** for the independent profile tree; **false** for the shared store.

## Minimal restore-point record

Schema version 1 in `src/main/plugin-restore-point.ts`. Parse/serialize reject session/storage/credential/identity paths and require the exclusion flags below.

| Field | Purpose |
|---|---|
| `schemaVersion` | `1` |
| `id` | UUID |
| `createdAt` | ISO time |
| `spaceId` | Target ordinary space |
| `packageName` / `requestedSpec` / `resolvedVersion` | What was asked vs what was on disk |
| `action` | `install` \| `uninstall` |
| `boundary` | `independent-per-space` \| `shared-deps-require-pause` |
| `linkPreservingCopySufficient` | Whether `copyLinkedTree` of independent trees is enough |
| `paths[]` | Measured `{ root: home\|store, rel, kind, role, shared }` |
| `sharedReferencers` | Other spaces that share store/fallback trees in this point |
| `contentDigest` | SHA-256 of the copied independent tree |
| `excluded` | Always `{ sessions, storages, otherSpaces, credentials, runtime, unmanagedPluginWrites }` all `true` |

Ordinary restore copies the independent `home` paths under `profiles/<space>/`. It does not restore chat/plugin business data, other spaces, Home credentials/runtime, unmanaged plugin-written paths, or the shared store unless `boundary` is `shared-deps-require-pause` and every referencer is paused.

## Not done / later product decision

Tasks 02–11 were not part of this experiment. After this measurement, the product dropped ordinary plugin auto-restore: spaces may stay crashed; Spaces only surfaces errors. Do not treat this file as a restore feature shipping in M1. The write-scope facts remain if restore is ever reopened.
