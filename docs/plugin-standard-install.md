# Standard plugin install

本批展示合同见 [宿主嵌入](host/embedding.md)：初始化后留在原应用和原 URL，空间栏在宿主内展开，右侧嵌入实际管理工作台及空间 WebUI。官方 Desktop 自定义协议和远程宿主不是已认证安装目标。下面的发行状态和旧验收记录不自动构成本批通过证据。

用户入口：在当前项目运行 `pnpm run pack:plugin`，执行它打印的插件安装命令，再启动 DSH Web，打开左侧“工作台”并点击“初始化 Spaces”。无需手动传入管理器、worker 或数据目录路径。故障政策见 [let it crash](let-it-crash.md)。

初始化是一次明确的用户操作。失败就结束该次请求并说明原因（缺哪一步、已知错误或明确未知）。下次打开页面时不会自动补装、重建或续接。用户再次点击初始化，是一份新请求。

新安装默认固定官方 **`0.1.7-alpha.1`**。已有运行时通过正常升级操作更新。若没有全局 dsh，可使用 `pnpm dlx @deepseek-ai/dsh@0.1.7-alpha.1 plugin --profile web add <完整包路径>` 安装，再用 `pnpm dlx @deepseek-ai/dsh@0.1.7-alpha.1 web` 启动。

现行验收脚本是 `scripts/verify-plugin-standard-install.mjs`（`pnpm run validate:plugin-install`）。本次完整安装、初始化、空间视图、重开及卸载结果见 [合并验收记录](../tasks/merge-execution.md)。历史 rc.1 / rc.2 浏览器记录见 [tasks/plugin-standard-install.md](../tasks/plugin-standard-install.md)，不替代当前版本验证。`@dsh-spaces/plugin` **尚未发布到 npm**；现在使用本地预构建包。

The distribution unit is the prebuilt **plugin tarball** (supervisor + view-bridge payload inside). `@dsh-spaces/supervisor` stays private.

Default official CLI version for new installations: **`0.1.7-alpha.1`**. An untested version number is not by itself read-only.

## User steps (pnpm)

在项目根目录运行以下命令。插件会使用该 DSH Web 自己的数据目录，无需另填路径。

从本仓库开发时，`pnpm run dev:web` 会重建 `.sandbox/dsh-web-home`、打包并预装当前插件、启动官方 `dsh web`。Electron 仍是 `pnpm run dev`。浏览器里再点 **初始化 Spaces**。

```powershell
pnpm run pack:plugin
pnpm dlx @deepseek-ai/dsh@0.1.7-alpha.1 plugin --profile web add "$env:TEMP\dsh-spaces-pack\dsh-spaces-plugin-0.3.0.tgz"
pnpm dlx @deepseek-ai/dsh@0.1.7-alpha.1 web
```

In ordinary **web**, open the **工作台 / Workbench** sidebar entry and click **初始化 Spaces / Initialize Spaces**. That is an explicit `guide.initialize()` with no path arguments. The independent supervisor creates `spaces-hub` and hands off. This is **not** a misinstall. If initialization fails, that request ends and the page reports the failure; the next visit does not silently finish it.

若只想试用，可先在同一终端设置 `$env:DSH_HOME = Join-Path $env:TEMP "dsh-spaces-try"`，再执行安装和启动。若已设置 `DSH_PACK_DEST`，请使用打包输出的实际路径。

Only one existing Web profile needs the full Spaces entry. Spaces created by the workbench receive the lightweight `@dsh-spaces/view-bridge`; repeating the full package installation in every space is unnecessary.

Windows CLI `0.1.5-rc.1` splits tarball paths that contain spaces. `pnpm run pack:plugin` writes to a no-space directory (`%TEMP%\dsh-spaces-pack` unless `DSH_PACK_DEST` is set).

## Listing vs accepted support

| Status | Meaning |
| --- | --- |
| **Local tarball acceptance** | `pnpm run pack:plugin` → `dsh plugin --profile web add` → `dsh web` → Initialize. The recorded result of `pnpm run validate:plugin-install` determines acceptance. See the current [merge acceptance record](../tasks/merge-execution.md); the command itself is not proof. |
| **Community listing, pending** | Marketplace search/install once the scoped package is owned and published. Not done. |
| **Not a release** | GitHub root is the monorepo. A CI pack artifact is for review, not `npm publish`. Desktop tags stay on the Release workflow. |

Uninstall the ordinary entry: `dsh plugin --profile web remove @dsh-spaces/plugin`. That must drop the web bundle row. It does not by itself delete a manager already created for the Home.

## Operators

```
pnpm run pack:plugin
pnpm run check:plugin-package
pnpm run dev:web
pnpm run validate:plugin-install -- --preflight
pnpm run validate:plugin-install
```

Full install proof starts real web + Playwright. Do not run it in parallel with other GUI work. Env: `DSH_TEST_BIN`, `DSH_TEST_RC2_BIN`, `DSH_TEST_OUTPUT`, `DSH_TEST_PLAYWRIGHT`, `DSH_TEST_PNPM_CJS`, `DSH_PACK_DEST`.

Playwright is pinned in development dependencies. Install its browser with `pnpm exec playwright install chromium` before running browser acceptance.
