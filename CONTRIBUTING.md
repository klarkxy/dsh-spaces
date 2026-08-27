# Contributing to DSH Spaces

## Safety

- Never read or write the real `~/.dsh` except read-only `dsh --help` / `dsh --dump-config`.
- All development and tests must use `.sandbox/dsh-home` (or another non-real `DSH_SPACES_HOME`).
- `web` is sacred: do not write `profiles/web/` or the default `sessions/` / `storages/` trees.

## Workflow

1. `npm install`
2. `node scripts/setup-sandbox.mjs` (once, after a global `dsh` install)
3. `npm test` and `npm run typecheck`
4. Isolation gate: `npm run validate:isolation` (do not run while the Electron app holds the same sandbox profiles)
5. `npm run dev`

## Phase gates

See `TODO.md` and `IMPLEMENTATION_PLAN.md`. Isolation (phase 0) must stay green. Do not ship a GUI that starts a workbench without `dump-config` verification.
