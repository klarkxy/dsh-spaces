# @dsh-spaces/doctor

Standalone Node CLI for DSH Spaces diagnostics. It does not install DSH, start Electron, or default to `~/.dsh`.

```
dsh-spaces doctor  --home <dir> [--cli <absolute-bin>]
dsh-spaces verify  --home <dir> --cli <absolute-bin> --profile <name>
dsh-spaces unlock  --home <dir>
dsh-spaces recover --home <dir>
dsh-spaces rollback --home <dir>
```

`--home` is required. `--cli` must be an absolute path to a bound DSH CLI (`0.1.5-rc.1` or `0.1.5-rc.2`). `verify` takes the home lock because `dump-config` writes, and it refuses when a mutation or restore journal is present. `doctor` is read-only and never calls `unlockDead()`. `unlock` is the only command that does. `recover` / `rollback` refuse in Phase 1 and print Desktop recovery guidance. Output is JSON with static messages; it never prints credentials, config dumps, logs, or filesystem roots.

Build from the repository root with `npm run build:spaces`.

The default development guard refuses the production `~/.dsh`. An operator intentionally diagnosing that home can opt in with `DSH_SPACES_ALLOW_REAL_HOME=1` for the command and must still pass `--home` explicitly. Development and acceptance do not set this opt-in or access production data.
