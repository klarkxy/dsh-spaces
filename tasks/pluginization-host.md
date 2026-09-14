# Phase 1 Host control

Owned by this worker. Shared DTO remains `src/shared/spaces-control.ts`.

## Behavior

- `NodeSpacesControl` implements the DTO API independently of Cordis.
- CLI is bound to `process.argv[1]` + adjacent `@deepseek-ai/dsh` manifest only. Compatible CLI: `0.1.5-rc.1`.
- Host identity is `DSH_HOME` + invocation `--profile`/`web` + `ctx.baseUrl` (profile root). Loader `config.baseUrl` is not trusted.
- Overview/detail are read-only: they never call `unlockDead`.
- Create/verify take one `HomeOperationLock` instance, then recheck gates excluding only that owned run (not PID). Overview still reports busy.
- Unknown/incompatible CLI is `unknown-readonly`. Corrupt registry, redirected `profiles`/`hub`, or blocked journal is `recovery-only`.
- Verify known-invalid (CLI exited, dump failed isolation) clears the verify journal and returns `valid: false`. Interrupted CLI keeps recovery-needed.
- Browser DTOs use allowlisted `spaces/*` RemoteError codes.

## Plugin

- Service/namespace `spaces`: `overview`, `detail`, `create`, `verify`.
- Exports `./typert` and `./remote`. Client injects renderer, layout, sidebar, connection. Browser main is `lib/client.js` (coordinator).
- Package version `0.2.0`.

## Not owned

Git, Agent Bridge, frontend panel, plugin bundle, desktop integration, production `~/.dsh`.
