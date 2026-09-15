# Contributing to DSH Spaces

Read [docs/let-it-crash.md](docs/let-it-crash.md) first. That file is the only current fault policy.

## Safety

- Never read or write the real `~/.dsh` except read-only `dsh --help` / `dsh --dump-config`.
- All development and tests must use `.sandbox/dsh-home` (or another non-real `DSH_SPACES_HOME`).
- `web` is sacred: do not write `profiles/web/` or the default `sessions/` / `storages/` trees.

## Let it crash

Plugin combinations may fail. Report the actual failure. Do not recover it.

- Do not mask faults with `catch` that returns empty config, a default result, or fake success.
- Do not retry failed operations, auto-restart or reconnect failed components, roll back, restore snapshots, reinstall dependencies, auto-edit config, disable plugins, switch versions or implementations, enter safe/rescue mode, or resume interrupted jobs.
- Do not add manual recovery wizards, Doctor recover/unlock/rollback product commands, or “check and repair” / “resume interrupted work” entries.
- User-initiated start, stop, restart, install, uninstall, and config remain independent operations. Error handlers must not start them, and they must not be packaged as recovery.
- Validation failure refuses and explains. It does not auto-correct.
- A plugin error does not require killing the whole host.
- Keep authentication, isolation, Origin/path checks, single-writer constraints, atomic writes, and bounded resource release.

Historical recovery plans, tests, and screenshots are evidence of what was built then. They are not current construction or release gates. Documentation done is not runtime migration done. See [tasks/todo.md](tasks/todo.md) for D vs R.

## Workflow

1. `npm install`
2. `node scripts/setup-sandbox.mjs` (once, after a global `dsh` install)
3. `npm test` and `npm run typecheck`
4. Isolation gate: `npm run validate:isolation` (do not run while the Electron app holds the same sandbox profiles)
5. `npm run dev`

## Phase gates

The activity ledger is [tasks/todo.md](tasks/todo.md). Isolation (phase 0) must stay green. Do not ship a GUI that starts a workbench without `dump-config` verification. Do not treat restore-success tests as a current pass condition.
