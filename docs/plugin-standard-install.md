# Standard plugin install

支持 **Node.js 24.21 及以上的 24.x，以及 26.x**：DSH 宿主、Supervisor、托管运行时和开发工具均接受这两个范围。用于隔离桌面验收的官方 Desktop 0.2.1-rc.2 使用 Electron 44.7.0 内置的 Node 24.21.0，无需替换桌面版运行时。新安装的托管工具链仍默认 Node 26.10.0，已有受支持工具链保留；不自动升级或替换已有工具链。当前隔离桌面验收见 [Node 24 兼容记录](../tasks/archive/node24-desktop-20261020.md)。

展示合同见 [宿主嵌入](host/embedding.md)，当前架构基线见 [现行架构](architecture.md)：初始化后留在原应用，空间栏在宿主内展开，右侧嵌入实际管理工作台及空间 WebUI。用于隔离验收的官方 Windows Desktop 0.2.1-rc.2 已通过本机隔离 Home，该历史记录也覆盖当时的原生 Browser Space；当前 Browser 入口封存，远程宿主未验收。下面的发行状态和旧验收记录不自动构成本批通过证据。

用户入口：把 Git 仓库根地址 `github:klarkxy/dsh-spaces` 交给 DSH 插件管理器安装。安装器通过根包的 `prepare` 构建脚本生成完整插件，不需要用户手动克隆、构建或打包。npm 发布继续暂缓。普通 Web 再启动 DSH Web，打开左侧“工作台”并点击“初始化 Spaces”。官方 Desktop 在打开应用时后台初始化并启动管理服务，主界面保留，无需先点击初始化。两种入口都无需手动传入管理器、worker 或数据目录路径。故障政策见 [let it crash](let-it-crash.md)。

普通 Web 的初始化是一次明确的用户操作。失败就结束该次请求并说明原因（缺哪一步、已知错误或明确未知）。下次打开页面时不会自动补装、重建或续接。用户再次点击初始化，是一份新请求。官方 Desktop 由宿主进程按当前 Home 保存该次终态；刷新界面只是重新加入。失败或正常停止不会自动重启。再次打开应用，或使用已有的确认式手动服务操作，才是一份新启动。子空间仍要等用户点击。缺少启动观察接口是明确的兼容失败，不改走自动恢复，也不能据此断定服务没有启动。健康的旧服务可以直接连接。

新安装默认固定官方 **`0.2.2-rc.1`**。每个空间固定一个精确 DSH 版本：已有空间首次启动时固定为其实际运行的版本，新空间默认宿主版本；切换在空间详情中发起（禁止降级，不自动建快照，不兼容的第三方插件会阻止切换；官方插件内置于所选运行时并随之变化，Spaces 不会把它们安装进 profile）。管理空间（spaces-hub）跟随宿主 CLI，低于 `0.2.0-rc.2` 的空间拒绝启动；不再使用的运行时可在设置中删除。若没有全局 dsh，可使用 `pnpm dlx @deepseek-ai/dsh@0.2.2-rc.1 plugin --profile web add <完整包路径>` 安装，再用 `pnpm dlx @deepseek-ai/dsh@0.2.2-rc.1 web` 启动。

现行验收命令是 `npm run validate:plugin-install`；设置 `DSH_TEST_PLUGIN_SPEC=github:klarkxy/dsh-spaces#<完整提交号>` 时验证 Git 根安装，否则验证预构建 tarball。0.2 迁移的历史验收见 [迁移记录](../tasks/archive/blueprint-migration-0.2.md)。此前安装、初始化、空间视图、重开及卸载结果见 [合并验收记录](../tasks/archive/merge-execution.md)，历史 rc.1 / rc.2 浏览器记录见 [tasks/archive/plugin-standard-install.md](../tasks/archive/plugin-standard-install.md)，均不替代当前版本验证。`dsh-spaces` **尚未发布到 npm**。

Git 根包和预构建插件 tarball 携带同一结构的完整组件组。Supervisor 等内部组件随主包分发，用户不需要第二个包；`@dsh-spaces/supervisor` 保持私有。

新安装默认官方 CLI 版本：官方 **`0.2.2-rc.1`**。未经测试的版本号本身不构成只读结论。

## Git source install

需要 Git、受支持的 Node.js/npm 和兼容的 DSH CLI。也可以在宿主插件管理页直接填写 `github:klarkxy/dsh-spaces`；来源是仓库根目录，不加 `&path:` 子目录。插件使用该宿主自己的数据目录，无需另填路径。

从本仓库开发时，使用下方[本地链接调试](#local-linked-development)，无需打包。

```powershell
dsh plugin --profile web add github:klarkxy/dsh-spaces --allow-build=dsh-spaces
dsh web
```

命令行示例使用 pnpm **10.29.2**，`--allow-build=dsh-spaces` 只授权本插件的构建。宿主插件页安装时，按提示确认本插件的构建请求即可。其他 pnpm 版本可能报告包名或带提交号的 Git 来源作为准确授权键，应使用宿主报告的键，不使用通配规则。未获得构建权限时不能得到可运行的插件，应先完成宿主的授权步骤。

需要固定版本时使用 `github:klarkxy/dsh-spaces#<完整提交号>`。安装器拉取该提交、安装构建依赖并执行 `prepare`，最终安装包只携带运行所需内容。源码不提交编译文件，也不要求用户另行下载 tarball。不需要全局安装 `dsh` 时，可将上述 `dsh` 替换为 `pnpm dlx @deepseek-ai/dsh@0.2.2-rc.1`（需已有 pnpm）。

In ordinary **web**, open the **工作台 / Workbench** sidebar entry and click **初始化 Spaces / Initialize Spaces**. That is an explicit initialization request with no path arguments. The independent supervisor creates the manager profile and returns an authenticated entry. This is **not** a misinstall. If initialization fails, that request ends and the page reports the failure; the next visit does not silently finish it.

若只想试用，可先在同一终端设置 `$env:DSH_HOME = Join-Path $env:TEMP "dsh-spaces-try"`，再执行安装和启动。

Only one existing Web profile needs the full Spaces entry. Spaces created by the workbench receive the lightweight view bridge; repeating the full package installation in every space is unnecessary.

A space exists only when created in Spaces (directly, or from an ordinary template or `.dshspace` share import): profile directory `profiles/space-<name>`, data `hub/space-<name>`, membership recorded in `hub/spaces.json`. Blueprint workflows in Spaces are currently sealed; the independent Blueprint package is unaffected. Spaces never scans, adopts, lists, or modifies other profile directories; profiles created by older versions or other tools are not migrated and stay ordinary profiles.

## Local archive alternative

需要预先准备离线交付制品或审阅安装包时，可以从检出生成 tarball。这是可选的维护者流程：

```powershell
git clone https://github.com/klarkxy/dsh-spaces.git
cd dsh-spaces
npm ci
npm run pack:plugin
dsh plugin --profile web add <打印的完整包路径>
```

`DSH_PACK_DEST` 可指定不含空格的绝对输出目录。Git 安装和打包都不执行 npm 发布。

## Local linked development

仓库根目录同时支持 Git 安装和本地开发链接，使用同一 `dsh-spaces` 身份与配置层。`npm install` / `npm ci` 会执行根包的 `prepare` 构建；调试命令仍执行开发构建。

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

当宿主插件解析到本源码检出（私有根包 `dsh-spaces` 下的 `packages/plugin/lib`）时，开发检出模式自动生效，无需环境变量：Supervisor 不再暂存组件副本、不写选中指针、不打包 tarball，直接以检出内验证过的组件组启动，并向 Supervisor 传入 `--dev-checkout <root>`。此后管理器 profile 在下次 Supervisor 启动时、各子空间在下次空间启动时，分别获得 `packages/plugin`、`packages/view-bridge` 的 `link:` 安装（浏览器组件被封存，不参与）。链接生效后：客户端改动经 `npm run build`（或持续运行的 `npm run dev:watch`）由官方 dsh-client-hmr 实时呈现；空间侧服务端桥接代码需重启该空间。Supervisor 代码变更后，普通 Web 遵循显式初始化或进入工作台；官方 Desktop 需重新打开应用，或使用既有的确认式手动启动。首次从既有 tarball 安装切换到链接模式时同样如此，并需每个子空间各一次重启。已知限制：`link:` 包从检出的 `node_modules` 解析 `@deepseek-ai/*` 对等依赖，因此固定到与检出开发依赖不同 DSH 版本的子空间在开发模式下可能无法正确加载。软链接不等于热替换，运行中的服务不会自动重启。普通 Web 首次进入仍需点击 **初始化 Spaces**。官方 Desktop 开发宿主在打开应用时后台启动管理服务；同一进程里服务已停止则保持停止，重新进入面板不会再请求启动。再次打开应用，或使用已有的确认式手动服务操作，才是新的启动。

Git 安装后的路径位于 `node_modules` 中，不会被误判为开发检出；Supervisor 使用随包携带的组件组。根目录保持 `private`，不发布到 npm；`npm run pack:plugin` 继续提供独立 tarball。

## Listing vs accepted support

| Status | Meaning |
| --- | --- |
| **Git root acceptance** | A pinned repository root is installed through the official CLI, prepared by the installer and exercised through the same real Web lifecycle as a tarball. Build authorization is limited to the project under test. |
| **Local tarball acceptance** | `pnpm run pack:plugin` → `dsh plugin --profile web add` → `dsh web` → Initialize. The recorded result of `pnpm run validate:plugin-install` determines acceptance. The [merge acceptance record](../tasks/archive/merge-execution.md) is historical and does not prove the current package; the command itself is not proof. |
| **Core npm publication, deferred** | Spaces itself is not installable by npm package name. Its public third-party plugin catalog remains available; authors publish under their own package names. |
| **Not a release** | GitHub root is the monorepo. A CI pack artifact is for review, not `npm publish`; there is no standalone Desktop package. |

## Upgrade

### First change from the old package name

主包已从 `@dsh-spaces/plugin` 改名为 `dsh-spaces`，内部 Supervisor、view-bridge 等组件包名保持不变。新安装直接使用新包。已有旧名安装属于一次显式换名，不能把两个包一起装在同一 profile，也不自动移除旧包或迁移用户数据。

1. 在旧版工作台正常停止 Spaces 服务，确认已停止后关闭宿主。停机失败时停止后续操作。
2. 在同一 DSH Home 下，用官方插件命令从实际宿主 profile 移除旧包。下面以 `web` 为例；Desktop 使用其实际 profile。
3. 若该 Home 已创建管理空间，在其实际 profile（默认 `spaces-hub`）中移除旧包并安装新包。未创建过管理空间时跳过此步。
4. 给宿主 profile 安装新包，再正常打开宿主。空间数据目录、空间注册信息和用户会话留在原处。

```powershell
# 已停止服务和关闭宿主；可用带完整提交号的 Git 根地址固定来源。
dsh plugin --profile web remove @dsh-spaces/plugin
# 仅当已有 spaces-hub 管理空间时执行这两行。
dsh plugin --profile spaces-hub remove @dsh-spaces/plugin
dsh plugin --profile spaces-hub add github:klarkxy/dsh-spaces --allow-build=dsh-spaces
dsh plugin --profile web add github:klarkxy/dsh-spaces --allow-build=dsh-spaces
```

管理空间仍声明旧包时，新版本会明确拒绝组件对齐与启动，保留现场。普通空间误装的旧包仍可通过既有“清理管理插件”确认操作移除。每项操作失败即停止，不重试、不自动回滚。

若自己在配置中写过模块名，还需将 `@dsh-spaces/plugin` 和 `@dsh-spaces/plugin/space-control` 分别改为 `dsh-spaces` 和 `dsh-spaces/space-control`，保留原有行 ID 与配置值。官方 bundle 自带的模块名由新包提供。

已有本地开发 Home 也遵循同样步骤，宿主 profile 换成 `spaces-dev`，新宿主包使用仓库根目录链接。`dev:web` / `dev:link` 遇到旧包会先拒绝，不自动添加第二个主包，也不清空开发数据。

### Updates under the current name

For a Git installation, add the intended newer repository commit through the official plugin manager, for example `dsh plugin --profile web add github:klarkxy/dsh-spaces#<full-commit> --allow-build=dsh-spaces`. A prebuilt tarball is also accepted. Then shut the Spaces service down from the manager UI and reopen Spaces. The new Supervisor selects the host plugin's bundled component group and aligns the manager plugin before the manager starts.

Ordinary spaces receive the group's bridge when they do not have one yet. An already-installed space bridge is not automatically re-aligned to the new group, so the actual bridge state must be shown rather than assumed. There is no in-app self-update and no automatic component handoff: the host plugin update, the service shutdown and the reopen are three separate user actions.

Uninstall the ordinary entry: `dsh plugin --profile web remove dsh-spaces`. That must drop the web bundle row. It does not by itself delete a manager already created for the Home.

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
