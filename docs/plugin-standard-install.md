# Standard plugin install

用户入口：在当前项目运行 `pnpm run pack:plugin`，执行它打印的插件安装命令，再启动 DSH Web，打开左侧“工作台”并点击“初始化 Spaces”。无需手动传入管理器、worker 或数据目录路径。

本轮默认使用最新发布的 **0.1.5-rc.2**，同时兼容 rc.1。若没有全局 dsh，可使用 `pnpm dlx @deepseek-ai/dsh@0.1.5-rc.2 plugin --profile web add <完整包路径> --config.auto-install-peers=true` 安装，再用 `pnpm dlx @deepseek-ai/dsh@0.1.5-rc.2 web` 启动。

标准安装已在独立测试目录完成 rc.1 / rc.2 真实浏览器验收。`@dsh-spaces/plugin` **尚未发布到 npm**；当前发布账号未登录，因此现在使用本地预构建包安装。详细证据见 [验收记录](../tasks/plugin-standard-install.md)。

The distribution unit is the prebuilt **plugin tarball** (supervisor + view-bridge payload inside). `@dsh-spaces/supervisor` stays private.

Official CLI: **latest = `0.1.5-rc.1`**, **next = `0.1.5-rc.2`**. Both are in scope. Changing the allowed-version list is not an install.

## User steps (pnpm)

在项目根目录运行以下命令。插件会使用该 DSH Web 自己的数据目录，无需另填路径。

```powershell
pnpm run pack:plugin
pnpm dlx @deepseek-ai/dsh@0.1.5-rc.2 plugin --profile web add "$env:TEMP\dsh-spaces-pack\dsh-spaces-plugin-0.2.0.tgz" --config.auto-install-peers=true
pnpm dlx @deepseek-ai/dsh@0.1.5-rc.2 web
```

In ordinary **web**, open the **工作台 / Workbench** sidebar entry and click **初始化 Spaces / Initialize Spaces**. That is an explicit `guide.initialize()` with no path arguments. The independent supervisor creates `spaces-hub` and hands off. This is **not** a misinstall.

若只想试用，可先在同一终端设置 `$env:DSH_HOME = Join-Path $env:TEMP "dsh-spaces-try"`，再执行安装和启动。若已设置 `DSH_PACK_DEST`，请使用打包输出的实际路径。

Only one existing Web profile needs the full Spaces entry. Spaces created by the workbench receive the lightweight `@dsh-spaces/view-bridge`; repeating the full package installation in every space is unnecessary.

Windows CLI `0.1.5-rc.1` splits tarball paths that contain spaces. `pnpm run pack:plugin` writes to a no-space directory (`%TEMP%\dsh-spaces-pack` unless `DSH_PACK_DEST` is set).

## Listing vs accepted support

| Status | Meaning |
| --- | --- |
| **Local tarball acceptance** | `pnpm run pack:plugin` → `dsh plugin --profile web add` → `dsh web` → Initialize. The recorded result of `pnpm run validate:plugin-install` determines acceptance; the command itself is not proof. |
| **Community listing, pending** | Marketplace search/install once the scoped package is owned and published. Not done. |
| **Not a release** | GitHub root is the monorepo. A CI pack artifact is for review, not `npm publish`. Desktop tags stay on the Release workflow. |

Uninstall the ordinary entry: `dsh plugin --profile web remove @dsh-spaces/plugin`. That must drop the web bundle row. It does not by itself delete a manager already created for the Home.

## Operators

```
pnpm run pack:plugin
pnpm run check:plugin-package
pnpm run validate:plugin-install -- --preflight
pnpm run validate:plugin-install
```

Full install proof starts real web + Playwright. Do not run it in parallel with other GUI work. Env: `DSH_TEST_BIN`, `DSH_TEST_RC2_BIN`, `DSH_TEST_OUTPUT`, `DSH_TEST_PLAYWRIGHT`, `DSH_TEST_PNPM_CJS`, `DSH_PACK_DEST`.

Playwright is pinned in development dependencies. Install its browser with `pnpm exec playwright install chromium` before running browser acceptance.
