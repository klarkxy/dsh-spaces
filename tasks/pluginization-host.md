# Phase 1 Host control

## Current contract (2026-09-15)

Fault policy: [docs/let-it-crash.md](../docs/let-it-crash.md). Activity ledger: [todo.md](todo.md).

Host identity derivation, current-host denial, unknown-runtime read-only, isolation verify, auth, single-writer lock, and error reporting remain. **Restore-core, independent rescue, restore CLI, Doctor recover/unlock/rollback, `recovery-only` / `recovery-needed` as a product mode, and fail-rollback are not current requirements** (**已撤销**). Remaining runtime work is R1–R6, pending.

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。

Owned by this worker. Shared DTO remains `src/shared/spaces-control.ts`.

## Behavior

- `NodeSpacesControl` implements the DTO API independently of Cordis.
- CLI is bound to `process.argv[1]` + adjacent `@deepseek-ai/dsh` manifest only. Compatible CLI: `0.1.5-rc.1`.
- Host identity is `DSH_HOME` + invocation `--profile`/`web` + `ctx.baseUrl` (profile root). Loader `config.baseUrl` is not trusted.
- Overview/detail are read-only: they never call `unlockDead`.
- Create/verify take one `HomeOperationLock` instance, then recheck gates excluding only that owned run (not PID). Overview still reports busy.
- Unknown/incompatible CLI is `unknown-readonly` (capabilities restricted, reason shown). Corrupt registry, redirected `profiles`/`hub`, blocked journal, or unreadable schema: **report unreadable and fail closed**. Keep original bytes. There is **no** `recovery-only` product mode.
- Verify known-invalid (CLI exited, dump failed isolation) returns `valid: false` with the actual error. Interrupted CLI is a failed/interrupted verify, not `recovery-needed`. Do not require restore before the next user-initiated command.
- Browser DTOs use allowlisted `spaces/*` RemoteError codes.

2026-09-11 code still used `recovery-only` / `recovery-needed` names (R1/R2 gap). Those names are not current product states.

## Plugin

- Service/namespace `spaces`: `overview`, `detail`, `create`, `verify`.
- Exports `./typert` and `./remote`. Client injects renderer, layout, sidebar, connection. Browser main is `lib/client.js` (coordinator).
- Package version `0.2.0`.

## Not owned

Git, Agent Bridge, frontend panel, plugin bundle, desktop integration, production `~/.dsh`.
