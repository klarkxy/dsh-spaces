## 当前有效合同（2026-09-15）

故障政策：[docs/let-it-crash.md](../docs/let-it-crash.md)。活动账本：[todo.md](todo.md)。

隔离、鉴权、单写者、原子写、错误报告，以及用户主动的启动、停止、重启、安装、卸载和配置，仍有效。救援入口、检查并恢复、恢复中断任务、配置恢复、整 Home 恢复、Doctor `unlock`/`recover`/`rollback`、失败回滚、失败重试和中断续接 **已撤销**，不是延期，不勾成已完成。剩余运行时工作见账本 R1–R6（pending）。下文是当时实施与验收记录，不是现行恢复门槛。

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# Spaces plugin — distribution / CLI install acceptance

Owner: `scripts/verify-spaces-distribution.mjs` (this file). Write scope is this script, `packages/plugin/README.md`, this note, and `.sandbox/spaces-distribution-acceptance/` evidence. No product/Git/Bridge/lockfile/DTO edits. Bundle manifest + `packages/plugin/cordis.patch.yml` are owned elsewhere (read-only here).

Command: `node scripts/verify-spaces-distribution.mjs`

Artifacts (gitignored): `.sandbox/spaces-distribution-acceptance/`.

## Pins (actual, not invented)

| Piece | Location |
| --- | --- |
| CLI 0.1.5-rc.1 | `DSH_TEST_BIN` or `C:/Users/admin/AppData/Local/Temp/spaces-runtime-install-fIEaas/versions/0.1.5-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js` |
| Plugin tarball | `DSH_TEST_PLUGIN_TGZ` if set, else `npm pack ./packages/plugin` into the artifact pack dir (absolute path). Not `.sandbox/pluginization-delivery` unless that env is set. |
| pnpm 10.29.2 | `DSH_TEST_PNPM_CJS` or toolchain `…/pnpm/bin/pnpm.cjs` |
| Node | `process.execPath` if `import.meta.main` is true; else Node 22.23.2 fallback |
| Adjacent CLI (optional) | `DSH_TEST_UNKNOWN_BIN`, or `DSH_TEST_DOWNLOAD_UNKNOWN=1` for registry `next` `0.1.5-rc.2`. No default `0.1.1-rc.2`. |

`dsh plugin --profile <name> <pnpm args>` is the real management command (`@deepseek-ai/dsh` `lib/bin.js` + `lib/plugin-Ddi42qoW.js`). After `dsh.bundle.patch` exists, add appends `@dsh-spaces/plugin` to `dsh.profile.bundles`; remove drops it when the dependency is gone.

## Fixture (disposable only)

- Temporary `DSH_HOME` under `.sandbox/spaces-distribution-acceptance/home`. Refuses `~/.dsh`.
- Isolated `PNPM_HOME`, pnpm store, npm cache, and a PATH shim under `os.tmpdir()`. No global install, no user `.npmrc` write.
- Seed: `dsh --profile web --dump-config`, then clone `coding` / `notes` from web and isolate with `applyIsolationPatch`.
- Install: `dsh plugin --profile coding add <absolute tarball> --config.auto-install-peers=true`. **No** user-layer `insert` of `dsh-spaces`.
- After add, before any overlay: `inBundles === true` and dump-config has `id: dsh-spaces`. Missing either is **FAIL**.
- snapshotRoot: id-only overlay (`id: dsh-spaces` + whole `config` replace). Not a second insert, not `name`.
- Replace/reinstall: same 0.2.0 tarball via `dsh plugin … add --force`.
- Uninstall: `dsh plugin --profile coding remove @dsh-spaces/plugin`, retain the optional id-only overlay while checking **the same coding profile**: package+bundle gone, dump has no plugin row, `session/list` RPC ok, `spaces/*` unavailable. Clean up the inactive overlay only after this proof.
- No Playwright, no Electron. Host RPC only. New downloads time out at 180s and retry once.

## What a PASS actually proves

1. Packed current `@dsh-spaces/plugin` (default `npm pack`) is a `dsh.bundle`.
2. Real `dsh plugin add` of that absolute tarball writes the dependency **and** `dsh.profile.bundles`, and dump-config already contains `id: dsh-spaces` with no manual insert.
3. Id-only `snapshotRoot` overlay; owned Host `spaces/overview` and `spaces/detail`; notes lists the fixture snapshot.
4. Re-add `--force` of the same 0.2.0 tarball still serves RPC (replace/reinstall).
5. `dsh plugin remove` on coding drops package and bundle; dump has no plugin row; the same coding Host still serves official `session/list` and does not serve `spaces/overview`.

Missing bundle registration or leftover activation after remove is **FAIL**. The script does not PASS with those recorded as defects.

## What it does not prove

- Browser sidebar / desktop. Main agent runs those serially elsewhere.
- A package-version upgrade. This artifact is `0.2.0`; the second add is replace/reinstall.
- Unknown-version read-only unless opted in (below).
- Registry publication.

## Optional unknown CLI

Opt in with `DSH_TEST_UNKNOWN_BIN` or `DSH_TEST_DOWNLOAD_UNKNOWN=1` (`@deepseek-ai/dsh@0.1.5-rc.2`, 180s, one retry). Compatible pin is exactly `0.1.5-rc.1`. When enabled the path must prove `capabilities.mode === "unknown-readonly"`, `spaces/create` and `spaces/verify` rejected, no new profile directory, and a DSH_HOME config fingerprint unchanged (excludes `*.log`, `sessions/`, `storages/`, `node_modules`). Load failure or a mode other than unknown-readonly is **FAIL**, not a skipped PASS. Manifests are never rewritten. `0.1.1-rc.2` is not the default (it 401s `spaces/overview` and cannot prove readonly).

## Notes for the integrator

- `SpacesHost` still has no `static Config` Standard Schema; Loader passes `snapshotRoot` as-is.
- Shipped `pnpm-workspace.yaml` sets `autoInstallPeers: false`; the add command includes `--config.auto-install-peers=true`.
- After a tarball `file:` install, `spaces/detail` plugin version is `null` because Host `publicPluginVersion` strips path-like specs.

`package.json` scripts / lockfile / shared DTO / final acceptance report remain main-agent owned. Suggested wiring: `"validate:distribution": "node scripts/verify-spaces-distribution.mjs"`.

## Independent final run — PASS, 2026-09-12

Codex ran the current artifact through the real CLI. Add auto-activated the bundle; the snapshot overlay worked; same-version replacement retained RPC; remove left coding's `session/list` working and `spaces/overview` returned HTTP 404 even before cleaning the inactive overlay. Real downloaded CLI `0.1.5-rc.2` reported `unknown-readonly`; both create and verify of an existing non-host profile returned the explicit `spaces/read-only` code, with no configuration fingerprint change.

The run exposed upstream Windows shell argument splitting for tarball paths containing spaces. The harness now stages byte-identical current tarball contents at an isolated shell-safe temporary path and records its SHA-256 and original path. It still uses official `dsh plugin add`; there is no manual package extraction or dependency junction in the installation path. README documents the operator workaround. The real adjacent runtime download hit the orchestration deadline, but its npm log completed successfully; `npm ls` and `dsh --version` confirmed installation before the actual runtime check.

Evidence: `.sandbox/pluginization-distribution-runtime.log`, `.sandbox/spaces-distribution-acceptance/{results.json,tarball.json,unknown-version.json}`. Final result timestamp: `2026-09-12T06:39:30.368Z`. Package-version upgrade remains distinct from the tested same-version replacement.
