# Project rules

Read [docs/let-it-crash.md](docs/let-it-crash.md) and [tasks/todo.md](tasks/todo.md) before planning or editing.

DSH Spaces follows let it crash: report the actual failure, do not recover it.
Do not add automatic retries, restarts, rollback, restore, repair, fallback,
or interrupted-job replay. The only manual exception is the explicitly authorized
Desktop error-page service start/restart: preview affected spaces, require
confirmation, perform one normal owned shutdown, then one guarded launch.
Do not replay tasks or restart child spaces. Failed shutdown, ambiguous ownership
and interrupted maintenance remain protected; never force-kill or clear evidence.
Keep authentication, isolation, single-writer constraints and atomic writes.
Opening the application is a new user-requested launch. That launch may retire
the exact, provably dead Supervisor lease and its matching endpoint under the
ownership guard, preserving failure evidence. Read-only discovery never clears
records; an in-session failure never automatically triggers another launch. Live, ambiguous,
foreign and handoff ownership, and interrupted maintenance, remain protected.
Historical recovery plans and tests are not current requirements.
Documentation completion is not runtime migration completion.

Never read or write the real `~/.dsh` except read-only `dsh --help` / `dsh --dump-config`.
Development and tests use `.sandbox/dsh-home` or another non-real `DSH_SPACES_HOME`.
`web` is sacred: do not write `profiles/web/` or the default `sessions/` / `storages/` trees.

## Verification

Run `npm run check:test-lists`, `npm run typecheck`, `npm run typecheck:spaces`,
`npm run typecheck:tests` and
`npm run build`, then the test groups: `npm test`, `npm run test:spaces`,
`npm run test:workbench`, `npm run test:workbench:recovery`, `npm run test:llm`,
`npm run test:blueprints` and `npm run test:browser`.
`test:workbench:browser` needs Playwright Chromium. `npm run check:all` runs the
checks above plus browser tests and package preflight, with logs and an isolated
Home. Windows rename checks require a writable temporary directory outside the
checkout: workspace readers can hold staging children open and cause `EPERM`.
Do not redirect Windows checks to `.sandbox/tmp`; use `--temp-root` with an
existing external directory and an authorized ordinary process when the sandbox
cannot write there. The runner rejects repository-local temp roots before
starting checks and never retries a failed command. Node 24.21+ (24.x) and Node 26 are supported.
`npm run dev:watch` builds once, then rebuilds on source changes for linked
dev-checkout profiles (no retry after a failed build).
