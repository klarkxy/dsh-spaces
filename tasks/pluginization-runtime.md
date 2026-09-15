# Spaces plugin — runtime acceptance

## Current contract (2026-09-15)

Fault policy: [docs/let-it-crash.md](../docs/let-it-crash.md). Activity ledger: [todo.md](todo.md).

Isolation, Host RPC, auth, lock, and error reporting remain. **Restore-core, independent rescue, restore CLI, Doctor recover/unlock/rollback, snapshot restore, desktop recovery, and fail-rollback are not current requirements.** They are **已撤销**, not deferred Phase 2 work. Remaining runtime work is R1–R6, pending.

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。

Owner: `scripts/verify-spaces-plugin.mjs` (this file). No product/Git/Bridge edits.

Command: `node scripts/verify-spaces-plugin.mjs` (also wired as `npm run validate:plugin`).

Artifacts (gitignored): `.sandbox/spaces-plugin-acceptance/`.

## Pins (actual, not invented)

| Piece | Location |
| --- | --- |
| CLI 0.1.5-rc.1 | `DSH_TEST_BIN` or `C:/Users/admin/AppData/Local/Temp/spaces-runtime-install-fIEaas/versions/0.1.5-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js` |
| SDK 0.1.5-rc.2 | sibling folders under that install's `node_modules` |
| Node | `process.execPath` if `import.meta.main` is true for a script file; else `C:/Users/admin/AppData/Local/Temp/spaces-node-upgrade-cSfOOr/node/node-v22.23.2-win-x64/node.exe` |
| Playwright | `DSH_TEST_PLAYWRIGHT_MODULE` or `C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright` |
| App boot `ctx.baseUrl` | `@deepseek-ai/dsh-app-boot` `lib/index.js` line 1529: profile directory (`pathToFileURL(dirname(absoluteConfigPath))`) |
| Client bundle | `window.__ModuleLoader__.load({ id, factory })` |

Shared API (`src/shared/spaces-control.ts`): namespace `spaces`, methods `overview` / `detail` / `create` / `verify`, args `id` / `input`.

Exact handler envelope:

```
POST /api/spaces/overview
{ type: 'client-request', rpcId: <uuid>, method: 'spaces/overview', payload: { args: {} } }
```

Same shape for `spaces/detail` (`args: { id }`), `spaces/create` (`args: { input }`), `spaces/verify` (`args: { id }`).

## Fixture (disposable only)

- Temporary `DSH_HOME` under `.sandbox/spaces-plugin-acceptance/home`. Refuses `~/.dsh`.
- Seed: `dsh --profile web --dump-config`.
- Clone `coding` (host) and `notes` (non-host) with `dsh --profile <name> --from-default-profile web --dump-config`.
- Isolate both with the exported core helper `applyIsolationPatch`, then `assertDumpPatched` on a real dump.
- `npm pack` the plugin; extract the tarball into `profiles/coding/node_modules/<name>`.
- Offline-link peer/deps to the installed SDK (junction, copy fallback). Provenance: `sdk-provenance.json`.
- Append a Loader row to the disposable `coding` `cordis.patch.yml`.

No model invocations. Launch is `--no-open` on an ephemeral `127.0.0.1` port. The launch token is captured from the owned child's stdout and used privately (Playwright navigation + cookie exchange). It is never printed; logs are redacted.

Cleanup is `finally` only: stop the owned PID tree (`taskkill /PID /T /F` on Windows), then wait for that port to close. No global process kill.

## Bounds

| Step | Limit |
| --- | --- |
| dump-config / from-default-profile / non-host verify | 180s |
| Phase 1 create (two dump-config steps) | 360s | |
| npm pack | 60s |
| CLI announce | 90s |
| RPC | 15s |
| Playwright | 45s |
| child stop / port close | 15s / 10s |

## What a PASS actually proves

1. Packed `lib/{index,client,typert.host}.js` plus a packable manifest (`files` covering those artifacts, `exports['./client']`, `dsh.client.platform=web`, `__ModuleLoader__.load` in `client.js`).
2. Official CLI seed + isolation helper + composed dump still names the packed plugin.
3. Authenticated page loads; sidebar **Spaces** opens; list and detail render for real profiles; official **New Session** remains; `pageerror` count is zero.
4. Real RPC: overview list, non-host `notes` verify succeeds, current host `coding` verify is rejected, invalid ids/paths (`../`, nested `..`, Windows path, fixture path) are rejected.
5. Phase 1 create: `spaces/create` a non-host space via real RPC (`--from-default-profile web --dump-config`, no network), then detail+verify read-back.
6. Overview/detail/create JSON has no token, cookie, or filesystem paths.

## What it does not prove

- **Unknown-version read-only.** Only recorded if the live host already reports `capabilities.mode === "unknown-readonly"`. This CLI is 0.1.5-rc.1 (compatible). The script will not rewrite versions or stub a second runtime.
- Plugin mutation and runtime install/upgrade were out of this script. **Snapshot restore is 已撤销 (2026-09-15), not deferred Phase 2 work.**
- Desktop recovery is **已撤销**. Electron packaging was out of this script.
- Anything against production `~/.dsh`.

## Pending

If `packages/plugin/lib/{index,client,typert.host}.js` or the packable manifest is absent, the script exits **2** and prints:

```
PENDING packages/plugin is not packable. Run: npm run build:spaces
```

It does not wait, build, or research. Status file: `.sandbox/spaces-plugin-acceptance/pending.json`.

Canonical package name: `@dsh-spaces/plugin`. Packed entries: `./lib/{index,typert.host,typert.remote-client,client}.js`. `files`: `lib`, `README.md`, `LICENSE`. New Loader rows are added with `insert` (id-only overlays of missing rows are ignored).

## Earlier integration failure — resolved

Fixture: `.sandbox/spaces-plugin-acceptance/`

Passed: web seed; coding/notes isolation + dump-config; packed `@dsh-spaces/plugin@0.2.0` extract; plugin `insert` present in composed dump; owned port closed.

Failed at owned CLI boot (`--profile coding --no-open`, Node v24.16.0, CLI 0.1.5-rc.1). Child exit 1 before `dsh web:` URL.

Repro: `node scripts/verify-spaces-plugin.mjs`

Sanitized log: `.sandbox/spaces-plugin-acceptance/dsh-coding.log`

Cause (product bundle, Codex-owned): Loader import of `dsh-spaces` (`@dsh-spaces/plugin`) throws `Dynamic require of "process" is not supported` from packed `lib/index.js` (esbuild CJS `require("process")` inside `type: module`, via bundled `yaml`). No screenshot — process never served a page. No RPC/UI/create ran.

## Final audited run — PASS (2026-09-11)

The Node ESM bundles now initialize `require` with `createRequire(import.meta.url)`. The coordinator reran the actual packed artifact after this correction and the final UI status correction.

All RPC checks above passed. Playwright completed first-run onboarding without an API key, opened Spaces, selected and verified notes, then used the actual Create form to create UI Probe and verified it. The official New Session control remained visible and there were no page errors. The owned port was confirmed closed after shutdown.

Evidence: `.sandbox/spaces-plugin-acceptance/results.json`, `spaces-sidebar.png`, `sdk-provenance.json`; console log `.sandbox/pluginization-runtime-audit.log`. This is offline tarball extraction plus linked real SDK dependencies, not a registry publication or a test of the CLI package-manager installation command. Unknown-version behavior is covered by unit tests only, not a second live runtime.
