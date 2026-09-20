# Desktop Electron verifier (shared workbench)

## Current contract (2026-09-20)

Script: `scripts/verify-spaces-desktop.mjs`
Command: `node --import tsx scripts/verify-spaces-desktop.mjs`
Prereq: `node --import tsx scripts/verify-spaces-desktop.mjs --prereq`

This leaf rewrote the stale verifier (old `window.dshSpaces` business IPC, hardcoded `C:/Users/admin/...` CLI/Playwright, required node zip). It now drives the **desktop shell + shared workbench**. Product source was not changed to fit the test.

### What it actually checks

1. **Prereq:** `DSH_TEST_BIN`/`DSH_TEST_CLI_BIN` and `DSH_TEST_NODE` (default `process.execPath`) must be real files. Playwright from repo `node_modules/playwright` (optional `DSH_TEST_PLAYWRIGHT_MODULE`). Unpackaged needs `out/main/index.js`. Packaged needs `DSH_TEST_PACKAGED_EXE` with sibling `resources/app.asar`. Packaged payload is `validateComponentPayload(resources/spaces-payload/lib)` via the TS source helper. Node zip / machine AppData pnpm are **not** required when those runtimes are supplied. NSIS `DSH_TEST_INSTALLER` is `7z l` only, never executed.
2. **Launch:** disposable temp Home + userData. Official CLI `web` `--dump-config`. Playwright `_electron` (visible window). Env `DSH_TEST_BIN`/`DSH_TEST_NODE` so the shell can Start without a renderer-supplied path.
3. **UI:** click title-bar **Start workbench service / 启动工作台服务**. Drive the remote view through Playwright `context().pages()` / `frameLocator('iframe#manager-frame')` (bootstrap entry, nested manager). Shared workbench is `.dsh-workbench`. Screenshots: `.sandbox/spaces-desktop-acceptance/window.png`, `workbench.png`.
4. **Second client (required):** Chromium opens the minted `entryUrl` and locates the same `iframe#manager-frame`. Failure here **fails** the run (V02). Node `DesktopServiceClient` is only the authenticated API, not a substitute for the browser.
5. **Create on desktop UI** (`notes` / display `Notes Desk`) → same backend space/job. **Rename CAS to a different name** (`Notes Desk Renamed`). **Stale CAS** with the pre-rename revision must conflict and leave name/revision unchanged.
6. **Settings draft** survives General ↔ Models; Models tab shows `data-llm-center` (llm `describe` only, no live model/credential write). Unsaved catalog is not in `product({method:'settings'})`.
7. **Home tabs** Overview / Spaces / Plugins / Snapshots / Runtime / Templates. Backend: `plugins()`, `snapshots()`, `product(templates)`, `runtimes()`. Diagnostics overlay + `product(diagnostics)` + `detail()`. No snapshot create/restore, no runtime install, no plugin install.
8. **Chromium required:** manager iframe must show the **renamed** space and the **create job** (`data-job-id`). Missing job UI fails.
9. **Close Electron without shutdown.** Same owner pid still alive; endpoint remains; state still has `notes`.
10. **Explicit `service.shutdown`.** Job must **succeed**; owned supervisor pid dead; endpoint invalid; origin port refused; this verifier process still alive.

Official plugin install remains `scripts/verify-plugin-standard-install.mjs`. This script does not run `npm run build`. Primary Agent executes the final Electron run after the current build is in place.

### Packaged vs NSIS

- Packaged layout evidence: exe + `resources/app.asar` + `resources/spaces-payload/lib` (v2 component manifest).
- NSIS Setup exe is **not** an app layout and is **not** installed by this verifier.

### This leaf did not run Electron

`--prereq` was executed here. It **failed closed** with `DSH_TEST_BIN is empty` (no machine-local CLI default). Playwright resolved to repo `node_modules/playwright`. `out/main/index.js` is present. Unpackaged `packages/plugin/lib` currently reports `schemaVersion must be 2` from `validateComponentPayload` (not a prereq gate unless `DSH_TEST_PACKAGED_EXE` is set). NSIS was not executed. Primary Agent runs the full verifier with `DSH_TEST_BIN` (+ optional packaged exe) after the current build/payload is in place. Evidence dir: `.sandbox/spaces-desktop-acceptance/`.

## Historical record (2026-09-15)

The previous unpackaged smoke used ProfileRegistry IPC, fixture CLI `0.1.5-rc.1`, rail `coding`, and `quitApp` that stopped owned ports. That contract is superseded by the shell above. Historical pass files under `.sandbox/spaces-desktop-acceptance/` are not current evidence.
