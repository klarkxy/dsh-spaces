# @dsh-spaces/doctor

生产 Home 必须显式传入 `--home` 与 `--allow-real-home`；默认仍拒绝生产目录。该授权只作用于本次 CLI 进程和指定 Home，不修改全局环境或权限。开发与验收始终使用隔离 Home，无需此标志。

Fault policy: [docs/let-it-crash.md](../../docs/let-it-crash.md).

**Target policy:** standalone Node CLI for DSH Spaces **diagnostics**. It inspects a Home and prints what it can prove. It does not install DSH, start Electron, start services, recover, roll back, unlock, rewrite jobs, write runtime pointers, rebuild config, or default to `~/.dsh`.

`unlock` / `recover` / `rollback` are not product commands. They return `UNSUPPORTED` and exit `7` without forwarding to the old recover implementation or rewriting Home.

```
dsh-spaces doctor   --home <dir> [--cli <absolute-bin>]
dsh-spaces verify   --home <dir> --cli <absolute-bin> --profile <name>
```

`--home` is required. `--cli` must be an absolute path to a bound DSH CLI. `verify` accepts DSH CLI `0.1.5-rc.1` and `0.1.5-rc.2`. Unknown versions are refused.

`doctor` is intended to be read-only: it should never call `unlockDead()`, `reclaimDead()`, or `WorkbenchJobStore` writes. It reports registry, journals, plugin-mutation evidence, transaction lock, run-control, manager identity, persistent jobs, and leftover instances. Unreadable or future schemas keep their original bytes. Permission failures are not treated as absence. Public JSON does not include CLI paths, tokens, cookies, or config secrets.

Treat any `verify` as a check only if you can prove it does not start services, write files, or trigger upstream mutation. A command is not “read-only” because of its name.

Revoked product commands (exit `7`, code `UNSUPPORTED`, Home bytes unchanged):

```
dsh-spaces unlock   --home <dir>
dsh-spaces recover  --home <dir> ...
dsh-spaces rollback --home <dir> ...
```

Do not use `--dry-run` as a recovery rehearsal. Calling a revoked command is not a supported operator flow.

Resource paths prefer `--cli` and explicit roots. Otherwise doctor may read `.dsh-spaces-control/toolchain.json` as **input**. Target policy: inspect must not update that record. Missing trusted fields are reported as flags to pass. Production AppData and empty first-init directories are not guessed as old data. The running doctor binary must not live inside the Home being inspected.

Build from the repository root with `npm run build:spaces`.

The default development guard refuses the production `~/.dsh`. An operator intentionally diagnosing that home can opt in with `DSH_SPACES_ALLOW_REAL_HOME=1` for the command and must still pass `--home` explicitly. Development and acceptance do not set this opt-in or access production data.
