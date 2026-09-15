# Desktop Electron smoke (pluginization)

## Current contract (2026-09-15)

Fault policy: [docs/let-it-crash.md](../docs/let-it-crash.md). Activity ledger: [todo.md](todo.md).

Isolation, auth, single-writer lock, lifecycle start/stop/restart, and error reporting remain. **Restore-core, independent rescue, restore CLI, Doctor recover/unlock/rollback, snapshot restore UI, and fail-rollback are not current requirements.** Remaining: Snapshot restore UI not run — **已撤销** (2026-09-15), not a deferred leaf. Remaining runtime work is R1–R6, pending.

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。

Script: `scripts/verify-spaces-desktop.mjs`\
Command: `node --import tsx scripts/verify-spaces-desktop.mjs`\
Result: **pass** (exit 0, ~68s)

Unpackaged `node_modules/electron` launched against the repo (`out/main/index.js`). Disposable temp home / userData / toolchain. Fixture CLI `0.1.5-rc.1`. No product source edits.

## What actually passed

1. Seeded offline `web` (`--dump-config`) and `coding` (`--from-default-profile web --dump-config`), applied isolation patch, `markOnboarded`, `current.json` → fixture `0.1.5-rc.1`.
2. Linked Node **22.23.2** (extracted from temp zip) and junctioned existing pnpm **10.29.2** into the test toolchain only. User toolchain not modified.
3. Playwright `_electron.launch` of unpackaged Electron with `DSH_SPACES_HOME`, `DSH_SPACES_USER_DATA`, `DSH_SPACES_TOOLCHAIN`, `DSH_SPACES_DISABLE_UPDATES`.
4. `getMaintenance()` after startup: **no recovery error**, no in-flight operation.
5. IPC `startProfile("coding")` → running on **:3810**; embedded WebContentsView rendered authenticated DSH UI (`session/list` 200/ok). Screenshot: `.sandbox/spaces-desktop-acceptance/coding.png` via `webContents.capturePage`.
6. IPC `restartProfile("coding")` → still running on **:3810**; view + `session/list` ok.
7. IPC `updateMeta` displayName `Coding Desk` round-tripped through `listProfiles`; `.dsh-spaces-lock` absent after the mutation (DesktopHomeControl lock released).
8. `stopProfile` + `quitApp`; the coordinator's independent rerun collected all running profile ports and confirmed both **3810** and **3811** refused TCP connections after quit.

Final independent result: `.sandbox/spaces-desktop-acceptance/results.json` (`2026-09-11T09:24:07.272Z`), log `.sandbox/pluginization-desktop-runtime-audit.log`. The screenshot shows the authenticated embedded DSH first-run introduction; it does not prove completing desktop chat onboarding or invoking a model. Any earlier `failure.json` is historical and is superseded by the dated passing result.

## Remaining limits

- Renderer still auto-starts **web** (default space). Smoke did not treat that as failure; it asserted the **coding** instance.
- Snapshot restore UI not run (out of this leaf).
- Packaged installer / Host plugin path not run.
- pnpm is a junction to the existing AppData copy (read-only). Node 22.23.2 lives only in the disposable toolchain.
- Window was skip-taskbar only, not headless; capturePage is the screenshot path.
