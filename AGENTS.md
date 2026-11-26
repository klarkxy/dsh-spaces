# Project rules

Read [docs/let-it-crash.md](docs/let-it-crash.md), [docs/architecture.md](docs/architecture.md) and [tasks/todo.md](tasks/todo.md) before planning or editing.

## Maintenance state

This repository is in maintenance state. Keep current documentation current, and keep history historical.

- Current product and maintainer documentation lives in `docs/`; historical plans, designs and acceptance records live in `docs/archive/` and `tasks/archive/`. Archived files are evidence, not current requirements or release gates.
- A current document must not describe a retired feature as current. Check [docs/architecture.md](docs/architecture.md) for the product boundary before writing.
- New work is recorded briefly in [tasks/todo.md](tasks/todo.md). Long dated logs go to `tasks/archive/`; do not grow `tasks/todo.md` into a journal.
- Release notes live in `docs/releases/`; user-visible changes also update [CHANGELOG.md](CHANGELOG.md). Do not mark an unreleased candidate as released or invent dates.
- Documentation completion is not runtime migration completion.

DSH Spaces follows let it crash: report the actual failure, do not recover it.
Do not add automatic retries, restarts, rollback, restore, repair, fallback,
or interrupted-job replay. The only manual exceptions are the explicitly authorized
Desktop error-page actions: (1) service start/restart (preview affected spaces,
require confirmation, perform one normal owned shutdown, then one guarded launch),
and (2) view-only reload (`重新加载空间界面`, read-only verification that the existing
Desktop launch record, Supervisor snapshot, and manager space are ready/running,
replacing only the failed frontend controller without starting or stopping Supervisor
or any space). Do not replay tasks or restart child spaces. Failed shutdown, ambiguous ownership
and interrupted maintenance remain protected; never force-kill or clear evidence.
Keep authentication, isolation, single-writer constraints and atomic writes.
Opening the application is a new user-requested launch. That launch may retire
the exact, provably dead Supervisor lease and its matching endpoint under the
ownership guard, preserving failure evidence. Read-only discovery never clears
records; an in-session failure never automatically triggers another launch. Live, ambiguous,
foreign and handoff ownership, and interrupted maintenance, remain protected.
Historical recovery plans and tests are not current requirements.

Read-only diagnosis of the real `~/.dsh` is allowed. Direct writes require explicit user authorization.
Normal user-authorized application startup, including the application's ordinary runtime writes,
is permitted and does not violate this rule or the protected-tree rule below.
Development and tests use `.sandbox/dsh-home` or another non-real `DSH_SPACES_HOME`.
`web` is sacred: do not write `profiles/web/` or the default `sessions/` / `storages/` trees.

## Verification

Run `pnpm run check:test-lists`, `pnpm run typecheck`, `pnpm run typecheck:spaces`,
`pnpm run typecheck:tests` and
`pnpm run build`, then the test groups: `pnpm test`, `pnpm run test:spaces`,
`pnpm run test:workbench`, `pnpm run test:workbench:recovery`, `pnpm run test:llm`,
`pnpm run test:blueprints` and `pnpm run test:browser`.
`test:workbench:browser` needs Playwright Chromium. `pnpm run check:all` runs the
checks above plus browser tests and package preflight, with logs and an isolated
Home. Windows rename checks require a writable temporary directory outside the
checkout: workspace readers can hold staging children open and cause `EPERM`.
Do not redirect Windows checks to `.sandbox/tmp`; use `--temp-root` with an
existing external directory and an authorized ordinary process when the sandbox
cannot write there. The runner rejects repository-local temp roots before
starting checks and never retries a failed command. Node 24.21+ (24.x) and Node 26 are supported.
`pnpm run dev:watch` builds once, then rebuilds on source changes for linked
dev-checkout profiles (no retry after a failed build).
