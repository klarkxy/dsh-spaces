# B3/B5 maintenance product verifier (v2)

Leaf: `scripts/verify-workbench-maintenance-product.mjs` plus this report. No source, other scripts, build, Git, config, credentials, or real `~/.dsh`.

## What changed

Stale rc1/rc2 allowlist, hardcoded admin Playwright, `controller.shutdown` without CAS, `config.restore` / `snapshot.restore` success paths, and “upgrade to a different CLI then restart manager” claims are gone.

The script now:

- Starts the **compiled same-group** Supervisor: `--component-payload packages/plugin/lib` plus packed plugin / view-bridge / **llm-bridge** and that group's `snapshot-worker.mjs`.
- Requires `DSH_TEST_BIN` (exact version from disk). `DSH_TEST_UPGRADE_VERSION` defaults to **that same version**. Install writes an outside-Home store tree; selection stays until `runtime.upgrade` moves the pointer. Same version is acceptable; the script does not claim a different version.
- Phases remain `plugins` | `snapshot` | `runtime` | `all`. No model calls.
- `preview` / `submit` send captured `{ serviceEpoch, expectedRevision }`. Same `requestId` is reread; a different command with that id must `conflict`.
- Plugins: install/remove on the ordinary `coding` profile only; `profiles/web` sessions/storages/credentials presence must not change.
- Snapshots: create / list / delete. Restore is preview-rejected as unsupported, not executed.
- Runtime: non-exact `latest` is rejected **before** store writes. After a successful upgrade, the manager may be running (product `reinitializeManager` on success only). Supervisor `serviceEpoch` must stay the same process epoch.
- Shutdown: public `service.shutdown`. If HTTP closes after the submit is accepted, the **exact requestId** durable job file must be `succeeded`, plus owner pid dead, endpoint invalid, ports closed. Public request and durable completion are labeled separately. `forceCleanOwned` is failure cleanup, never PASS.
- Job poll uses a fixed 250ms wait. Transport errors are recorded. There is no mutation replay and no post-failure manager restart.
- Playwright default is repo `node_modules/playwright`; `DSH_TEST_PLAYWRIGHT` / `DSH_TEST_PLAYWRIGHT_MODULE` override.

## Commands

```
node --check scripts/verify-workbench-maintenance-product.mjs
node scripts/verify-workbench-maintenance-product.mjs --syntax
```

Primary after `build:spaces` and official CLI:

```
# HTTP only (desktop UI covered separately)
$env:DSH_TEST_BIN = "<official @deepseek-ai/dsh lib/bin.js>"
node scripts/verify-workbench-maintenance-product.mjs --http-only --phase all

# Optional same-version store select (default is DSH_TEST_BIN's exact version)
$env:DSH_TEST_UPGRADE_VERSION = "<exact version>"
node scripts/verify-workbench-maintenance-product.mjs --phase runtime
```

## Prereqs (real run, Primary)

- `DSH_TEST_BIN` file, exact `package.json` version beside it
- Compiled same-group payload: `packages/plugin/lib/supervisor/index.js`, `snapshot-worker.mjs`, `manifest.json`
- Packed artifacts produced by this script from `packages/plugin`, `packages/view-bridge`, `packages/llm-bridge` (no extra build in this leaf)
- Playwright: repo `node_modules/playwright` or env override
- Disposable output Home only; refuses `~/.dsh`
- Optional: `DSH_TEST_PNPM_CJS`, `DSH_TEST_OUTPUT`, `DSH_TEST_UPGRADE_VERSION`

## Checks (this leaf)

| Command | Result |
| --- | --- |
| `node --check scripts/verify-workbench-maintenance-product.mjs` | PASS |
| `node scripts/verify-workbench-maintenance-product.mjs --syntax` | PASS (check + v2 contract + parsers + Home guard) |
| `--http-only` / `--phase all` | **pending Primary** after `build:spaces` and `DSH_TEST_BIN` |
| Packed payload schemaVersion 2 | may still fail until Primary rebuilds `packages/plugin/lib` |

## Not done here

- Other `verify-workbench-*.mjs` still have `controller.shutdown` (out of leaf).
- No `package.json` / build / Git.
- Does not claim B5 handoff or packaging complete.
