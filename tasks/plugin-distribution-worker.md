# Plugin distribution leaf

Date: 2026-09-13. Branch: `codex/spaces-recovery`. Role: distribution / acceptance scripts. No Git, no publish, no provider edits, no `src/adapters/node`, no `packages/plugin/src` / plugin tests.

## Ownership kept

Touched: `packages/plugin/package.json` (metadata only), `packages/view-bridge/package.json` + README + `.npmignore`, `packages/plugin/.npmignore` + README install copy, `scripts/pack-spaces-plugin.mjs`, `scripts/verify-plugin-standard-install.mjs`, `.github/workflows/ci.yml`, `.github/workflows/plugin-distribution.yml`, `docs/plugin-standard-install.md`, `docs/workbench.md` pointers, this note.

Did not: delete `packages/plugin/dsh-spaces-plugin-0.2.0.tgz` or `packages/view-bridge/dsh-spaces-view-bridge-0.2.0.tgz`; change versions/deps; flip supervisor `private`; edit root `package.json` / lock (main Agent already added `pack:plugin`, `check:plugin-package`, `validate:plugin-install`).

## Review-fix (required three)

1. Browser consumes the one-time launch URL (`page.goto(launchUrl.href)`). Repeat visits use `http://127.0.0.1:<web-port>/` with that session. Restart uses a **new** launch URL. No `sessionCookie` + second goto of the same token.
2. After handoff, rail is asserted on the **manager iframe** (`api.view` + `page.frames()` + `frame.locator('.dsh-wb-rail')`), not the supervisor shell. Ordinary web uses `.dsh-spaces-return` and `getByRole('button', { name: /^(工作台|Workbench)$/ })`.
3. While the auth context is alive: `preview` + `plan.execute` `controller.shutdown`, wait this Home’s ports. If initialize never minted a cookie, shutdown uses **this Home’s** `endpoint.json` bearer after origin/port identity checks. Owner PID is only used when `owner.endpoint` matches that origin. `stopOwned` is limited to the web child this script spawned. Leftover owned ports fail the run.

Also: `assertSingleManager` fails when `manager.json.profileId` ≠ the single hub; init `[role=alert]`, RPC errors, and `pageerror` are recorded (redacted) with `failure.png`; timeouts throw (no silent PASS). Preflight path scan builds banned needles at runtime so it does not match its own source.

## Static evidence (this leaf)

`node --check` on pack + verify scripts: ok.

`node scripts/verify-plugin-standard-install.mjs --preflight` with `DSH_TEST_RC2_BIN` pointing at the isolated rc2 prefix: **PASS**. Dry-run tarball file lists checked (not mere existence); nested-tgz fixture detected; supervisor stays private; default pack dest `os.tmpdir()/dsh-spaces-pack` (no spaces). Global latest CLI was not on PATH (INFO, not a preflight fail). rc2 resolved as `0.1.5-rc.2`.

**Did not** boot DSH web, supervisor, Playwright, or `build:spaces`. Real `validate:plugin-install` is for the main Agent.

`npm whoami` is `ENEEDAUTH`. **Not published.** CI pack workflow uploads review artifacts only (`confirm=unpublished`), no `npm publish`, no desktop tag, no electron-builder.

## User command

```
pnpm run pack:plugin
dsh plugin --profile web add <printed-tarball-path> --config.auto-install-peers=true
dsh web
```

Then **初始化 Spaces**. Docs: `docs/plugin-standard-install.md`.

## Main Agent serial

```
pnpm run validate:plugin-install
```

Suggested env (do not bake into scripts):

- `DSH_TEST_BIN` = official `lib/bin.js` (`0.1.5-rc.1` latest and/or `0.1.5-rc.2` next). A local next bin exists at `C:/Users/admin/AppData/Local/Temp/dsh-spaces-standard-rc2/node_modules/@deepseek-ai/dsh/lib/bin.js` if you want `DSH_TEST_RC2_BIN` / `DSH_TEST_BIN` for rc2.
- Node: `C:/Program Files/nodejs/node.exe` (has a space; tarball dest must not).
- `DSH_TEST_PLAYWRIGHT`, `DSH_TEST_PNPM_CJS`, `DSH_TEST_OUTPUT` as needed.

Zero leftover processes on the disposable Home is a pass condition.

## Gaps / main Agent

- `scripts/verify-plugin-package.mjs` is referenced by root `check:plugin-package` but was not in tree when this leaf wrote pack/verify. Not invented here.
- Initialize UI is owned by the plugin leaf (`guide.initialize` is in `packages/plugin/src`). This script clicks the contracted labels.
- Community marketplace write/API is out of scope.

## CI

`ci.yml`: installs `@deepseek-ai/dsh@0.1.5-rc.1` (latest) and prefix-installs `0.1.5-rc.2` (next); runs `test:workbench` + `test:workbench:recovery`; pack + standard-install **preflight** after `build:spaces`. Full Playwright install is not on the PR gate.
