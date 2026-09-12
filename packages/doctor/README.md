# @dsh-spaces/doctor

生产 Home 必须显式传入 `--home` 与 `--allow-real-home`；默认仍拒绝生产目录。该授权只作用于本次 CLI 进程和指定 Home，不修改全局环境或权限。开发与验收始终使用隔离 Home，无需此标志。

Standalone Node CLI for DSH Spaces diagnostics and offline whole-home recovery. It does not install DSH, start Electron, or default to `~/.dsh`.

```
dsh-spaces doctor   --home <dir> [--cli <absolute-bin>]
dsh-spaces verify   --home <dir> --cli <absolute-bin> --profile <name>
dsh-spaces unlock   --home <dir>
dsh-spaces recover  --home <dir> --cli <absolute-bin> --snapshot-root <dir> --runtime-root <dir> [--dry-run]
dsh-spaces rollback --home <dir> --cli <absolute-bin> --snapshot-root <dir> --runtime-root <dir> --snapshot <id> [--dry-run]
```

`--home` is required. `--cli` must be an absolute path to a bound DSH CLI. `verify` accepts `0.1.5-rc.1` and `0.1.5-rc.2`. `recover` / `rollback` currently write only with `0.1.5-rc.1`; rc2 stays read-only verify until root proves compatibility.

`doctor` is read-only: it never calls `unlockDead()`, `reclaimDead()`, or `WorkbenchJobStore`. It reports registry, mutation/restore/upgrade journals, plugin-mutation evidence, transaction lock, run-control, manager identity, persistent jobs, and leftover instances. Unreadable or future schemas keep their original bytes. Permission failures are not treated as absence. Public JSON does not include CLI paths, tokens, cookies, or config secrets.

`unlock` may reclaim a proven-dead transaction lock and proven-dead `HomeController` lease. Live or ambiguous owners are refused. PIDs are not killed.

`recover` and `rollback` take a temporary `HomeController` lease of kind `web` (standalone CLI control; not a new kind). Alive or ambiguous control is refused. Proven-dead owners can be reclaimed because the operator passed recover/unlock explicitly, with a second liveness check. `HomeOperationLock` still covers the actual journal/snapshot transaction and is separate from that lease. Leftover live or identity-ambiguous child instances enter recovery mode: directories are not swapped and PIDs are not killed. Only records proven dead for this Home are removed.

Recovery reuses `CoordinatedUpgrade.recover()` / `restore(snapshotId)` with in-process `SnapshotStore` and `RuntimeStore`. It does not start a DSH service, supervisor, or second controller. After Home journals are reconciled, doctor reads back the current runtime pointer and Home config. If that fails, jobs are not settled and the command is not marked complete. Remaining unreadable or unmatched jobs print `recoveryRequired` and exit 10; they are not reported as finished. `--dry-run` prints whole-Home impact and the target and writes nothing. `rollback` requires explicit `--snapshot <id>` and does not guess ids.

Whole-home restore/rollback may archive a readable plugin-mutation journal so the same open file does not block the next doctor run, while keeping `plugin-mutation-files` as audit. Upgrade `preparing` cleanup does not clear plugin evidence. Only jobs/plans with evidence for this snapshot or mutation `planId` are settled.

Resource paths prefer `--cli`, `--snapshot-root`, and `--runtime-root`. Otherwise doctor reads `.dsh-spaces-control/toolchain.json` (`version`, `bin`, `nodeExe`, `dshVersion`, `boundAt`, `runtimeRoot`, `snapshotRoot`, `toolchainRoot`). After a verified runtime change, doctor updates `bin`/`dshVersion` in that private record and keeps `nodeExe` and the resource roots. Missing trusted fields are reported as flags to pass. Production AppData and empty first-init directories are not guessed as old data. The running doctor binary must not live inside the Home being replaced; distribute doctor independently of snapshot-replaced trees.

Build from the repository root with `npm run build:spaces`.

The default development guard refuses the production `~/.dsh`. An operator intentionally diagnosing that home can opt in with `DSH_SPACES_ALLOW_REAL_HOME=1` for the command and must still pass `--home` explicitly. Development and acceptance do not set this opt-in or access production data.
