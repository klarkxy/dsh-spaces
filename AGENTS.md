# Project rules

Read [docs/let-it-crash.md](docs/let-it-crash.md) and [tasks/todo.md](tasks/todo.md) before planning or editing.

DSH Spaces follows let it crash: report the actual failure, do not recover it.
Do not add automatic retries, restarts, rollback, restore, repair, fallback,
or interrupted-job replay. Do not add manual recovery workflows either.
Keep authentication, isolation, single-writer constraints and atomic writes.
Historical recovery plans and tests are not current requirements.
Documentation completion is not runtime migration completion.

Never read or write the real `~/.dsh` except read-only `dsh --help` / `dsh --dump-config`.
Development and tests use `.sandbox/dsh-home` or another non-real `DSH_SPACES_HOME`.
`web` is sacred: do not write `profiles/web/` or the default `sessions/` / `storages/` trees.
