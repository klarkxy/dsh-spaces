# B5 launcher review fixes

2026-09-20. Construction leaf. Node imports stay under `src/adapters/node`. No Git, credentials, real `~/.dsh`, Supervisor CLI wiring, pack, build, or shared contracts.

## Verification

```text
npx tsx --test --test-concurrency=1 tests/component-selection.test.ts tests/component-handoff.test.ts
tests 20 / pass 20 / fail 0
```

Real child processes. Outer harness tracks launcher/target pids and uses bounded `taskkill /T` cleanup. Temp homes only.

## Export interface

`packages/supervisor/src/launcher.ts` still re-exports `acceptHandoffFromIpc`, `beginAcceptHandoffChild`, `runComponentLauncher`, `spawnComponentLauncher`.

| Export | Change |
|---|---|
| `acceptHandoffFromIpc` | **breaking:** required `startup(handle)` callback. IPC `accepted` is sent only after it resolves. Lock accept is not startup success. Missing `startup` throws `invalid-commit`. |
| `beginAcceptHandoffChild` | unchanged; `reportAccepted` remains the explicit ready signal |
| `spawnComponentLauncher` | same typed handle; spawn is `detached` + `unref` so the old process can flush, disconnect, and exit |
| `runComponentLauncher` | same signature; reservation original, manifest entry, and secret-value checks run before select |

Supervisor CLI still owned by the primary: pass `startup` that fires after HTTP/manager ready, or use `beginAcceptHandoffChild` and call `reportAccepted` only then.

## Repro → rejection

1. **Fake dead `oldPid` 2147483647 while original lives.** Reservation is inspected first. `commit.oldPid`/`oldStartedAt` must equal `inspect().handoff.original`. Mismatch → `invalid-commit`, no wait, no pointer. Test: `commit oldPid must match reservation original before wait/select`.
2. **`runtime.entry` not the staged supervisor entry.** Staged manifest entry is resolved and compared (realpath, regular file) **before** select. Mismatch → `invalid-commit`, pointer unchanged. Spawn uses the resolved manifest entry. Test: `runtime entry must match the staged supervisor entry before select`. Fixture is a self-contained JS supervisor inside the v2 manifest, hashed, then staged.
3. **`tools/components` junction into Home.** Every staging ancestor is lstat'd for symlink/junction and realpath-contained outside Home **before** mkdir/copy. Junction → `ComponentSelectionError` (`symlink or junction` / outside Home / path alias). Test: `stage refuses a components junction that redirects into Home`.
4. **`REVIEW_CARRIER=token.secret` and nonce on execArgv.** Effective env is inherited `process.env` plus `runtime.env`. All values plus argv/execArgv/entry/cwd/execPath are scanned for `token.secret` and `token.nonce` before select. Hit → `invalid-commit`, no pointer, no spawn. Tests: `effective env values cannot carry the handoff secret`, `execArgv cannot carry the handoff nonce`.
5. **Accept then crash.** `acceptHandoffFromIpc` no longer reports `accepted` on lock accept. Crash fixture uses `beginAcceptHandoffChild`, accepts the lock, exits without `reportAccepted`. Launcher sees child exit → `accept-failed`, receipt `failed`. Selected pointer and run owner remain. Test: `accept without startup report keeps the selected pointer and run owner`.
6. **Old parent vs launcher wait.** Old owner flushes commit, disconnects, prints `OLD_TRANSFERRED`, exits. It does not `waitForExit` the launcher. Launcher spawn is detached. Outer test tracks descendant pids and bounded-kills them; it does not reclaim a real Home lock.

## Out of scope

Primary still wires `--accept-handoff` on the Supervisor CLI, `parseSupervisorArgs`, pack/build, and the upgrade job tail.
