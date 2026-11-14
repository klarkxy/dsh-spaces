# Standard plugin install

支持 **Node.js 24.21 及以上的 24.x，以及 26.x**：DSH 宿主、Supervisor、托管运行时和开发工具均接受这两个范围。用于隔离桌面验收的官方 Desktop 0.2.1-rc.2 使用 Electron 44.7.0 内置的 Node 24.21.0，无需替换桌面版运行时。新安装的托管工具链仍默认 Node 26.10.0，已有受支持工具链保留；不自动升级或替换已有工具链。当前隔离桌面验收见 [Node 24 兼容记录](../tasks/archive/node24-desktop-20261020.md)。

展示合同见 [宿主嵌入](host/embedding.md)，当前架构基线见 [现行架构](architecture.md)：初始化后留在原应用，空间栏在宿主内展开，右侧嵌入实际管理工作台及空间 WebUI。用于隔离验收的官方 Windows Desktop 0.2.1-rc.2 已通过本机隔离 Home，该历史记录也覆盖当时的原生 Browser Space；当前 Browser 入口封存，远程宿主未验收。下面的发行状态和旧验收记录不自动构成本批通过证据。

用户入口：从 Git 克隆本仓库，运行 `npm ci` 和 `npm run pack:plugin`，执行它打印的插件安装命令。npm 发布暂缓，不需要配置 npm 发布账号。普通 Web 再启动 DSH Web，打开左侧“工作台”并点击“初始化 Spaces”。官方 Desktop 在打开应用时后台初始化并启动管理服务，主界面保留，无需先点击初始化。两种入口都无需手动传入管理器、worker 或数据目录路径。故障政策见 [let it crash](let-it-crash.md)。

普通 Web 的初始化是一次明确的用户操作。失败就结束该次请求并说明原因（缺哪一步、已知错误或明确未知）。下次打开页面时不会自动补装、重建或续接。用户再次点击初始化，是一份新请求。官方 Desktop 由宿主进程按当前 Home 保存该次终态；刷新界面只是重新加入。失败或正常停止不会自动重启。再次打开应用，或使用已有的确认式手动服务操作，才是一份新启动。子空间仍要等用户点击。缺少启动观察接口是明确的兼容失败，不改走自动恢复，也不能据此断定服务没有启动。健康的旧服务可以直接连接。

新安装默认固定官方 **`0.2.2-rc.1`**。每个空间固定一个精确 DSH 版本：已有空间首次启动时固定为其实际运行的版本，新空间默认宿主版本；切换在空间详情中发起（禁止降级，不自动建快照，不兼容的第三方插件会阻止切换；官方插件内置于所选运行时并随之变化，Spaces 不会把它们安装进 profile）。管理空间（spaces-hub）跟随宿主 CLI，低于 `0.2.0-rc.2` 的空间拒绝启动；不再使用的运行时可在设置中删除。若没有全局 dsh，可使用 `pnpm dlx @deepseek-ai/dsh@0.2.2-rc.1 plugin --profile web add <完整包路径>` 安装，再用 `pnpm dlx @deepseek-ai/dsh@0.2.2-rc.1 web` 启动。

现行验收命令是 `npm run validate:plugin-install`。0.2 迁移的历史验收见 [迁移记录](../tasks/archive/blueprint-migration-0.2.md)。此前安装、初始化、空间视图、重开及卸载结果见 [合并验收记录](../tasks/archive/merge-execution.md)，历史 rc.1 / rc.2 浏览器记录见 [tasks/archive/plugin-standard-install.md](../tasks/archive/plugin-standard-install.md)，均不替代当前版本验证。`@dsh-spaces/plugin` **尚未发布到 npm**；现在使用从 Git 源码构建的本地包。

发行单元是预构建的**插件 tarball**。Supervisor 等内部组件随该包分发，用户不需要第二个包；`@dsh-spaces/supervisor` 保持私有。

新安装默认官方 CLI 版本：官方 **`0.2.2-rc.1`**。未经测试的版本号本身不构成只读结论。

## Git source install

先安装 Git、受支持的 Node.js 和兼容的 DSH CLI。首次从仓库获取源码后，按锁文件安装依赖并构建。插件会使用该 DSH Web 自己的数据目录，无需另填路径。

从本仓库开发时，使用下方[本地链接调试](#local-linked-development)，无需打包。

```powershell
git clone https://github.com/klarkxy/dsh-spaces.git
cd dsh-spaces
npm ci
npm run pack:plugin
dsh plugin --profile web add "$env:TEMP\dsh-spaces-pack\dsh-spaces-plugin-0.5.0.tgz"
dsh web
```

请以打包输出的实际完整路径为准；`DSH_PACK_DEST` 可指定不含空格的绝对输出目录。不需要全局安装 `dsh` 时，可将上述 `dsh` 替换为 `pnpm dlx @deepseek-ai/dsh@0.2.2-rc.1`（需已有 pnpm）。`npm ci` 和打包使用 npm 工具及依赖源，不执行 npm 发布。

这里的 Git 安装指“源码检出后构建安装”。仓库不提交编译产物，也没有自动安装构建脚本，不能直接执行 `dsh plugin add github:klarkxy/dsh-spaces`。需要复现某次构建时，在 `npm ci` 前用 `git checkout <完整提交号>` 固定源码；可用 `git rev-parse HEAD` 记录当前提交。

In ordinary **web**, open the **工作台 / Workbench** sidebar entry and click **初始化 Spaces / Initialize Spaces**. That is an explicit initialization request with no path arguments. The independent supervisor creates the manager profile and returns an authenticated entry. This is **not** a misinstall. If initialization fails, that request ends and the page reports the failure; the next visit does not silently finish it.

若只想试用，可先在同一终端设置 `$env:DSH_HOME = Join-Path $env:TEMP "dsh-spaces-try"`，再执行安装和启动。若已设置 `DSH_PACK_DEST`，请使用打包输出的实际路径。

Only one existing Web profile needs the full Spaces entry. Spaces created by the workbench receive the lightweight view bridge; repeating the full package installation in every space is unnecessary.

A space exists only when created in Spaces (directly, or from an ordinary template or `.dshspace` share import): profile directory `profiles/space-<name>`, data `hub/space-<name>`, membership recorded in `hub/spaces.json`. Blueprint workflows in Spaces are currently sealed; the independent Blueprint package is unaffected. Spaces never scans, adopts, lists, or modifies other profile directories; profiles created by older versions or other tools are not migrated and stay ordinary profiles.

## Local linked development

仓库根目录现在也是私有的 `@dsh-spaces/plugin` 开发入口，导出插件构建产物，与发行包使用同一插件身份和配置层。

```powershell
npm install
npm run dev:web
```

该命令先构建，再将仓库根目录链接到 `.sandbox/dsh-link-home` 下的独立 `spaces-dev` profile，并启动官方 Web 应用。调试 Home 保留，后续启动复用同一链接，不重新打包、重装或清空数据。只准备链接而不启动时，运行 `npm run dev:link`。可用 `DSH_SPACES_WEB_HOME` 指定另一个独立 Home，用 `DSH_TEST_BIN` 指定目标 DSH CLI 的 `lib/bin.js`。

已有兼容 DSH CLI 时，也可从仓库根目录手动执行：

```powershell
npm run build
$env:DSH_HOME = Join-Path $PWD '.sandbox/dsh-manual-link-home'
# 仅首次创建该自定义 profile；已有 profile 不重复应用模板。
dsh --profile spaces-dev --from-default-profile web --dump-config
dsh plugin --profile spaces-dev add .
dsh --profile spaces-dev
```

依赖应记录为 `link:`，并指向本仓库根目录。不要链接到仓库父目录。开发流程不写真实 `~/.dsh` 或 `profiles/web`。

当宿主插件解析到本源码检出（私有根包 `@dsh-spaces/plugin` 下的 `packages/plugin/lib`）时，开发检出模式自动生效，无需环境变量：Supervisor 不再暂存组件副本、不写选中指针、不打包 tarball，直接以检出内验证过的组件组启动，并向 Supervisor 传入 `--dev-checkout <root>`。此后管理器 profile 在下次 Supervisor 启动时、各子空间在下次空间启动时，分别获得 `packages/plugin`、`packages/view-bridge` 的 `link:` 安装（浏览器组件被封存，不参与）。链接生效后：客户端改动经 `npm run build`（或持续运行的 `npm run dev:watch`）由官方 dsh-client-hmr 实时呈现；空间侧服务端桥接代码需重启该空间。Supervisor 代码变更后，普通 Web 遵循显式初始化或进入工作台；官方 Desktop 需重新打开应用，或使用既有的确认式手动启动。首次从既有 tarball 安装切换到链接模式时同样如此，并需每个子空间各一次重启。已知限制：`link:` 包从检出的 `node_modules` 解析 `@deepseek-ai/*` 对等依赖，因此固定到与检出开发依赖不同 DSH 版本的子空间在开发模式下可能无法正确加载。软链接不等于热替换，运行中的服务不会自动重启。普通 Web 首次进入仍需点击 **初始化 Spaces**。官方 Desktop 开发宿主在打开应用时后台启动管理服务；同一进程里服务已停止则保持停止，重新进入面板不会再请求启动。再次打开应用，或使用已有的确认式手动服务操作，才是新的启动。

发行仍使用 `npm run pack:plugin` 生成的独立包，根目录保持 `private`。

## Listing vs accepted support

| Status | Meaning |
| --- | --- |
| **Local tarball acceptance** | `pnpm run pack:plugin` → `dsh plugin --profile web add` → `dsh web` → Initialize. The recorded result of `pnpm run validate:plugin-install` determines acceptance. The [merge acceptance record](../tasks/archive/merge-execution.md) is historical and does not prove the current package; the command itself is not proof. |
| **Core npm publication, deferred** | Spaces itself is not installable by npm package name. Its public third-party plugin catalog remains available; authors publish under their own package names. |
| **Not a release** | GitHub root is the monorepo. A CI pack artifact is for review, not `npm publish`; there is no standalone Desktop package. |

## Upgrade

For a source installation, select the intended newer Git commit, then run `npm ci` and `npm run pack:plugin`. Record the commit and keep the pack report alongside the archive. `dsh plugin --profile web add <new tarball>` replaces the host plugin entry, then shut the Spaces service down from the manager UI and reopen Spaces. The new Supervisor selects the host plugin's bundled component group and aligns the manager plugin before the manager starts.

Ordinary spaces receive the group's bridge when they do not have one yet. An already-installed space bridge is not automatically re-aligned to the new group, so the actual bridge state must be shown rather than assumed. There is no in-app self-update and no automatic component handoff: the host plugin update, the service shutdown and the reopen are three separate user actions.

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
