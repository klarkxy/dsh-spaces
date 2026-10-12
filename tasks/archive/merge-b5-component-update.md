# B5 component-update acceptance harness

2026-09-20. Tests/scripts only. No app-source edits, Git, credentials, real `~/.dsh`, deps, build, or publish. No live PASS from this leaf.

## Commands

```text
node --import tsx scripts/verify-component-update.mjs --syntax
node --import tsx scripts/verify-component-update.mjs --preflight
node --import tsx --test tests/component-update-shim.test.ts
```

Primary live run after `build:spaces` and `DSH_TEST_BIN`:

```text
node --import tsx scripts/verify-component-update.mjs --with-browser
```

API-only mutations (no Chromium):

```text
node --import tsx scripts/verify-component-update.mjs --api-only
```

`--preflight` **fails** if the on-disk plugin lib is not a full v2 payload with declared `lib/supervisor/launcher.mjs`. `--syntax` may record `PENDING` build gaps and still exit 0. Neither is a live PASS.

Env: `DSH_TEST_BIN`, optional `DSH_TEST_PNPM_CJS`, `DSH_TEST_PLAYWRIGHT`, `DSH_TEST_OUTPUT`.

## Assertions (verified contracts)

1. After confirm, `readSelectedComponentPayload` digest **must** equal `candidatePayload.digest`. `workbenchPackage().digest` combines archives and is **not** a payload comparison.
2. Launch proof is `readHandoffReceipt(home)` / `handoff-receipt.json`: `status=succeeded`, `phase=accepted`, `artifactDigest` exact candidate. `workbench-upgrade-receipts/{planId}.json` is preparation settlement, not the launcher receipt. Prepare job success alone is not handoff success. New owner pid + new endpoint must be ready.
3. New process argv is checked for `--import …fetch-shim.mjs` only (scratch dir `dsh-spaces-component-update` must not match). Argv must contain the selected `…/components/{digest}/lib/supervisor/index.js`.
4. Tampered tarball of the **same** version is cached before validation. After failed prepare, public `plugin.library.remove` of the **existing** library id (`@dsh-spaces/plugin@<exact>`), require succeeded job, then good prepare. No direct Home cache deletion. Product must not auto-heal by swapping fixture bytes under the same pin.
5. `--with-browser` clicks **Prepare update** (latest; fixture `dist-tags.latest` is the exact candidate) then **Preview** / **Confirm**. Not a readback after API prepare. `--api-only` keeps public API prepare/preview/execute.
6. After public submit is accepted, if HTTP closes (handoff/shutdown), read the durable job file `{home}/.dsh-spaces-control/jobs/{requestId}.json` (`id`/`requestId` exact). Require persisted `succeeded`. Label **durable proof**, not HTTP success.
7. Current Supervisor declares only `launcher.mjs`. No launcher.js/source-fallback warning. Inventory fail-closed on missing v2 manifest or launcher.
8. Shim HTTP rewrite test uses async child while the parent serves the fixture. Never `spawnSync` there.

## Files

- `tests/fixtures/component-update/rewrite.mjs`
- `tests/fixtures/component-update/fetch-shim.mjs`
- `tests/component-update-shim.test.ts`
- `scripts/verify-component-update.mjs`

## This leaf did not

Run `build:spaces`, start a live Supervisor, publish, claim PASS, or edit app source / Git / config / credentials.
