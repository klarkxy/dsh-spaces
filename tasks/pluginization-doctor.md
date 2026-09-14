# Standalone doctor (`@dsh-spaces/doctor` 0.2.0)

Scope: `packages/doctor/**`, `tests/spaces-doctor.test.ts`, this file. No lock-worker edits, no `index.ts` Desktop wiring, no Git.

## Package

- Name `@dsh-spaces/doctor`, version `0.2.0`, bin `dsh-spaces` → `lib/index.js`
- `files`: `lib`, `README.md`, `LICENSE`
- Root `npm run build:spaces` already bundles `packages/doctor/src/index.ts` with esbuild (`platform: node`, shebang banner)
- No install/postinstall side effects; importing `src/index.ts` does not run commands

## Commands

| Command | Behavior |
|---|---|
| `doctor --home <dir> [--cli abs]` | Observational JSON: registry parse, mutation journal `.dsh-spaces-mutation.json`, restore journal `.dsh-spaces-restore/journal.json`, lock inspect, optional CLI version allowlist. Never `unlockDead()`. |
| `verify --home --cli --profile` | Bind absolute CLI (`0.1.5-rc.1` / `0.1.5-rc.2`), acquire lock, re-check profile containment + journals **inside** the lock, then `node <cli> --profile <name> --dump-config` and `assertDumpPatched`. |
| `unlock --home` | Only caller of `unlockDead()`. Live / incomplete / ambiguous / `reclaim-in-progress` / `remove-failed` → exit 3. |
| `recover` / `rollback` | Exit 10 `RECOVERY_UNAVAILABLE` + Desktop guidance. No destructive recovery. |

`--home` is required. Production `~/.dsh` → exit 2 `REAL_HOME` with no path in JSON.

## Exit codes

- 0 ok
- 2 usage / `REAL_HOME` / `HOME_INVALID`
- 3 lock blocked (live, incomplete, ambiguous, reclaim, remove-failed)
- 4 `VERIFY_FAILED` / `DUMP_FAILED`
- 5 invalid / web / symlink profile
- 6 runtime refused / unbound
- 10 recovery needed or recover/rollback unavailable

## Evidence (this machine)

```
node --import tsx --test tests/spaces-doctor.test.ts
# 15 pass, 0 fail
# including: live lock refusal, hub/profiles junction refusal, verify recovery-needed,
# reclaim blocked, real-home stable code, dump timeout waits for child exit + bounded stdout
```

Final integration typecheck passes. The coordinator added the actual Loader type augmentation in the Host service; Doctor `print(body, exit: number = EXIT.ok)` also has its intended numeric exit type.

Lock inspect `reclaim: true` is displayed as `{ held: true, reclaim: true }`. dump-config uses `terminateProcessTree` and does not resolve until the child has exited.
