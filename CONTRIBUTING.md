# Contributing to DSH Spaces

To contribute a third-party plugin, use the [community catalog guide](catalog/README.md). Plugins stay in their authors' repositories and npm packages; catalog contributions need no core package publishing rights. Spaces supports direct Git installation and prebuilt npm packages. Published GitHub Releases trigger the [npm release workflow](docs/npm-publishing.md).

Read [docs/let-it-crash.md](docs/let-it-crash.md) first. That file is the only current fault policy. For the current product boundary read [docs/architecture.md](docs/architecture.md); current open items are in [tasks/todo.md](tasks/todo.md).

## Safety

- Read-only diagnosis of the real `~/.dsh` is allowed. Direct writes require explicit authorization; normal authorized application startup may perform its ordinary runtime writes.
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

Historical recovery plans, tests, and screenshots are evidence of what was built then. They are not current construction or release gates. Documentation done is not runtime migration done.

## Workflow

1. `npm install`
2. `node scripts/setup-sandbox.mjs` (once, after a global `dsh` install)
3. `npm test` and `npm run typecheck`
4. Isolation gate: `npm run validate:isolation`
5. `npm run dev:web` builds and links the repository root into the custom `spaces-dev` profile at `.sandbox/dsh-link-home`, then starts the official Web app. The Home and link persist between launches. Click **初始化 Spaces / Initialize Spaces** in the browser. Use `npm run dev:link` for setup without starting the host. Git installs run the root `prepare` automatically; `npm run pack:plugin` remains available for archive distribution.

To link manually, set `DSH_HOME` to a separate development Home, create a custom profile from the official Web template, then run `dsh plugin --profile spaces-dev add .` from the repository root after `npm run build`. See [local linked development](docs/plugin-standard-install.md#local-linked-development). Rebuild and explicitly restart the host to load changed code. For Supervisor or manager changes, also stop the service from the workbench before reopening it. There is no automatic restart or hot replacement.

## Full local checks

Run `npm run check:all` with Node 24.21+ (24.x) or Node 26. CI checks both supported lines; the managed toolchain defaults to Node 26.10.0. This runs catalog and release validation, the required list/type/build checks and product test groups, package preflight, and workbench browser tests (Playwright Chromium required). Each command runs once. Logs and `result.json` are saved under a new `.sandbox/checks-*` directory; `--output` can name a new evidence directory.

The runner gives child processes a fresh temporary directory and non-real DSH Home. On Windows that directory must be outside the checkout. A workspace reader can briefly open a staging child and make the single atomic directory rename fail with `EPERM`, even when the reader permits delete sharing. `.gitignore` alone does not stop every external reader. The runner rejects an inherited repository-local TMP, including a directory alias into it, before starting checks. If needed, choose an existing external directory explicitly:

```powershell
npm run check:all -- --temp-root "$env:LOCALAPPDATA\Temp"
```

Use an authorized ordinary shell if the restricted shell cannot write there. Do not redirect these Windows checks to `.sandbox/tmp`, disable other applications, or add rename retries to make a run pass. Temporary fixtures and evidence are retained by the runner; individual tests still release their own resources. See [the investigation](tasks/archive/runtime-eperm-20261020.md) for the observed conflict and verification limits.

## Maintenance documentation

- Current product docs are in `docs/`; historical plans and records are in `docs/archive/` and `tasks/archive/`. Do not promote archived text to current requirements.
- Keep [tasks/todo.md](tasks/todo.md) to a short list of open items. Long dated logs go to `tasks/archive/`.
- Update [CHANGELOG.md](CHANGELOG.md) and `docs/releases/` for user-visible changes. Do not mark an unreleased candidate as released.
- Do not put links to untracked `.sandbox/` or `dsh-spaces-checktmp` evidence in current docs.
