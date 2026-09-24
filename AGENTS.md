# Project rules

Read [docs/let-it-crash.md](docs/let-it-crash.md) and [tasks/todo.md](tasks/todo.md) before planning or editing.

DSH Spaces follows let it crash: report the actual failure, do not recover it.
Do not add automatic retries, restarts, rollback, restore, repair, fallback,
or interrupted-job replay. Do not add manual recovery workflows either.
Keep authentication, isolation, single-writer constraints and atomic writes.
Opening the application is a new user-requested launch. That launch may retire
the exact, provably dead Supervisor lease and its matching endpoint under the
ownership guard, preserving failure evidence. Read-only discovery never clears
records; an in-session failure never triggers another launch. Live, ambiguous,
foreign and handoff ownership, and interrupted maintenance, remain protected.
An intact dead legacy desktop lease is also eligible only when both its bound
endpoint and the endpoint file are absent.
Historical recovery plans and tests are not current requirements.
Documentation completion is not runtime migration completion.

Never read or write the real `~/.dsh` except read-only `dsh --help` / `dsh --dump-config`.
Development and tests use `.sandbox/dsh-home` or another non-real `DSH_SPACES_HOME`.
`web` is sacred: do not write `profiles/web/` or the default `sessions/` / `storages/` trees.
