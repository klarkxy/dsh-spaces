# Standalone doctor (`@dsh-spaces/doctor` 0.2.0)

## Current contract (2026-09-15)

Fault policy: [docs/let-it-crash.md](../docs/let-it-crash.md). Activity ledger: [todo.md](todo.md).

Doctor target is **diagnostics only**: observational JSON, isolation verify, lock inspect, error reporting. Isolation, auth, and single-writer lock remain. **Restore-core, independent rescue, restore CLI, Doctor `recover` / `unlock` / `rollback`, and fail-rollback are not current requirements** (**已撤销**, R5). Do not treat Exit 10 or Desktop recovery guidance as a product to finish.

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。

Scope: `packages/doctor/**`, `tests/spaces-doctor.test.ts`, this file. No lock-worker edits, no `index.ts` Desktop wiring, no Git.

## Package

- Name `@dsh-spaces/doctor`, version `0.2.0`, bin `dsh-spaces` → `lib/index.js`
- `files`: `lib`, `README.md`, `LICENSE`
- Root `npm run build:spaces` already bundles `packages/doctor/src/index.ts` with esbuild (`platform: node`, shebang banner)
- No install/postinstall side effects; importing `src/index.ts` does not run commands

## Commands (current contract)

| Command | Current contract |
|---|---|
| `doctor --home <dir> [--cli abs]` | Observational JSON only: registry parse, journals as **input**, lock inspect, optional CLI version allowlist. Must not call `unlockDead()`, rewrite jobs, write runtime pointers, start services, or restore. Treat `verify` as a check only if it can be proved not to mutate. |
| `verify --home --cli --profile` | Bind absolute CLI (`0.1.5-rc.1` / `0.1.5-rc.2`), inspect profile containment + dump-config isolation. Fail closed and explain. Not a repair. |
| `unlock --home` | **已撤销** (2026-09-15). R5: return unsupported + nonzero. Must not unlock, reclaim, or print a restore tutorial. |
| `recover` / `rollback` | **已撤销** (2026-09-15). R5: return unsupported + nonzero. Must not forward to a renamed old implementation or Desktop recovery guidance. |

`--home` is required. Production `~/.dsh` → exit 2 `REAL_HOME` with no path in JSON.

**Known implementation gap:** 2026-09-12 binaries still execute `unlock` / `recover` / `rollback` (recover/rollback then returned Exit 10 `RECOVERY_UNAVAILABLE` plus Desktop guidance). That is not current CLI behavior to keep or finish. Do not copy those examples as how to use doctor.

## Exit codes (target)

- 0 ok (diagnose / verify with no mutation)
- 2 usage / `REAL_HOME` / `HOME_INVALID`
- 3 lock blocked (live or ambiguous owner; refuse, do not reclaim)
- 4 `VERIFY_FAILED` / `DUMP_FAILED`
- 5 invalid / web / symlink profile
- 6 runtime refused / unbound
- nonzero unsupported for revoked `unlock` / `recover` / `rollback` (R5). Exit 10 “recovery needed” is **not** a current product status.

## Evidence (this machine)

```
node --import tsx --test tests/spaces-doctor.test.ts
# 15 pass, 0 fail
# including: live lock refusal, hub/profiles junction refusal, verify fail-closed on unreadable/interrupted,
# reclaim blocked, real-home stable code, dump timeout waits for child exit + bounded stdout
```

Final integration typecheck passes. The coordinator added the actual Loader type augmentation in the Host service; Doctor `print(body, exit: number = EXIT.ok)` also has its intended numeric exit type.

Lock inspect `reclaim: true` is displayed as `{ held: true, reclaim: true }`. dump-config uses `terminateProcessTree` and does not resolve until the child has exited.
