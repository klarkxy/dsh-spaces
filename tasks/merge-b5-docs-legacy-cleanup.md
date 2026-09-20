# B5 current docs + legacy verifier cleanup

> 本文件是该施工叶交付时的历史检查点。下文的 FAIL / not yet PASS 不代表当前状态；后续复验以 [合并执行与验收记录](merge-execution.md) 为准。

Narrow leaf. No Git, config, credentials, real Home, package.json/CI, live acceptance scripts, or B-complete checkboxes. Primary still owns `tasks/merge-execution.md`, `tasks/todo.md`, root README, and plan updates.

## Source facts used (not guessed)

- `RestoreSession` is gone from `src/`.
- `SnapshotStore.restore` / `recover` / `completeRestore` and snapshot-worker `restore|recover|completeRestore` throw unsupported.
- `packages/doctor/src/recover.ts` is compile stubs; CLI `index.ts` never imports it; `unlock`/`recover`/`rollback` exit unsupported.
- Runtime install IO is `src/adapters/node/runtime-installation.ts`. Worker `runtimeInstall` only forwards.
- `--snapshot-worker` still required for snapshot create/delete and remaining tree copy/rename/retarget.
- Current Node entry: `--component-payload` + three archives (plugin, view-bridge, llm-bridge) + same-group worker. Example in `docs/workbench.md`.
- Launcher handoff exists in source (`packages/supervisor/src/launcher.ts`, `--accept-handoff`, `handoff-pending`). That is **implemented**, not real-acceptance PASS.

## Current vs acceptance

| Path | Status written |
| --- | --- |
| Source restore chain | Deleted / throw unsupported |
| `verify-plugin-standard-install.mjs` | FAIL under diagnosis (not PASS) |
| `verify-spaces-desktop.mjs` | real not yet PASS |
| `verify-component-update.mjs` | real not yet PASS |
| `verify-workbench-maintenance-product.mjs` | real not yet PASS |
| Four retired scripts below | invocation fail-closed; not B6 evidence |

`package.json` `test:workbench:recovery` is unchanged (doctor / cooperative-children / maintenance-responsiveness / xp-compatibility). CI does not invoke the four retired scripts. Those live acceptance files were not edited.

## Retired invocation (historical body retained)

| Script | Replacement |
| --- | --- |
| `scripts/verify-workbench-crash.mjs` | `scripts/verify-workbench-maintenance-product.mjs` |
| `scripts/verify-workbench-maintenance-faults.mjs` | `scripts/verify-workbench-maintenance-product.mjs` |
| `scripts/verify-workbench-package-upgrade.mjs` | `scripts/verify-component-update.mjs` |
| `scripts/verify-workbench-dual-control.mjs` | `scripts/verify-spaces-desktop.mjs` |

Each prints a readable `RETIRED:` reason + replacement and sets `process.exitCode = 1` **before** `main()`. Old restore/controller/rc allowlist mutations do not run. `node --check` still parses the historical body.

## Docs touched

- `docs/let-it-crash.md` — drop stale “recover.ts / RestoreSession / SnapshotStore.restore still present as live recover”
- `docs/workbench.md` — exact `--component-payload` + 3 archives; implemented vs real-acceptance
- `docs/plugin-standard-install.md` — current FAIL under diagnosis; historical rc.1/rc.2 is not current PASS
- `packages/supervisor/README.md` — same entry argv; worker not “remaining runtime-install IO”; endpoint v2

## Checks

| Command | Result |
| --- | --- |
| `node --check` on the four retired scripts | PASS |
| `node scripts/verify-workbench-crash.mjs --self-check` | exit 1, prints `RETIRED:` + replacement |
| `node scripts/verify-workbench-maintenance-faults.mjs --self-check` | exit 1, `RETIRED:` |
| `node scripts/verify-workbench-package-upgrade.mjs --self-check` | exit 1, `RETIRED:` |
| `node scripts/verify-workbench-dual-control.mjs` | exit 1, `RETIRED:` |
| CI / `package.json` | no refs to the four scripts; `test:workbench:recovery` unchanged |

No Git write. Live acceptance scripts not edited.
