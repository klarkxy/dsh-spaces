# dsh-spaces

DSH-native Spaces workbench, with a dedicated manager and an independent local supervisor.

Fault policy: [let it crash](../../docs/let-it-crash.md). Plugin combinations may fail. This package reports the failure; it does not recover the environment. Current architecture baseline: [现行架构](../../docs/architecture.md).

当前直接通过 Git 仓库根地址安装，安装器负责构建，npm 发布暂缓。新安装默认固定官方 CLI **`0.2.2-rc.1`**；已有运行时通过正常升级操作更新。本仓库使用 `0.2.2-rc.1` SDK 构建；peer 保留原有下限，并显式接纳这个预发布版本，不构成 CLI 白名单。

原主包名为 `@dsh-spaces/plugin`。已有安装需先正常停止服务，再按[换名步骤](../../docs/plugin-standard-install.md#first-change-from-the-old-package-name)显式替换宿主和已有管理空间的包；不要同时保留新旧两个主包。

## Install from Git source

```powershell
dsh plugin --profile web add github:klarkxy/dsh-spaces --allow-build=dsh-spaces
dsh web
```

The root package prepares the build during Git installation. Approve this plugin's build script if the host requests it; users do not need a local checkout or a manually built archive. In the ordinary DSH sidebar choose **工作台 / Workbench**, then **初始化 Spaces / Initialize Spaces**.

No global CLI is required if you use `pnpm dlx @deepseek-ai/dsh@0.2.2-rc.1` in place of `dsh`. A prebuilt local archive from `npm run pack:plugin` remains an alternative. Keep the CLI's default `autoInstallPeers: false`: its shared SDK is supplied by the runtime, and installing another copy can split Cordis service identity.

For development, `npm run dev:web` builds and links the checkout into the custom `spaces-dev` profile at `.sandbox/dsh-link-home`, then starts the official Web app. Existing development data stays; `npm run dev:link` only prepares the link. See [local linked development](../../docs/plugin-standard-install.md#local-linked-development).

初始化使用当前 DSH Home。上面的安装步骤和初始化点击针对普通 Web：普通页面保持原有界面，只有用户点击初始化后才创建管理空间和启动监督程序；失败会显示原因，该次请求结束，下次打开不会自动补装或续接。再次进入时点击“进入工作台”。只需在一个已有 Web profile 安装完整入口，工作台新建的空间自动使用轻量 view-bridge。

官方 Desktop 在打开应用时后台初始化并启动管理服务，主界面保留。宿主进程按当前 Home 保存该次终态；刷新界面只是重新加入，失败或正常停止不会自动重启。再次打开应用是一份新启动，已有确认式手动服务入口也会建立新操作。子空间仍需点击后启动。缺少启动观察接口是明确的兼容失败，不改走 Web 的初始化点击，也不能据此断定服务没有启动。

## Package contract

- Standard `dsh.bundle.patch` and `cordis.patch.yml` let the official CLI maintain the profile's bundle list.
- `dsh.client` and `./client` supply the Web client through DSH's module loader and shared React.
- Git installations and tarballs carry one immutable component group of the same build: supervisor, manager plugin, view bridge, Browser and the installation worker. Users do not need a second package or a separate source checkout at runtime.
- The create dialog offers the main space's models (default) or local configuration. Choosing the main space's models copies its routes, default model and the keys they reference into the new space once; the space detail can repeat that copy on request. Running spaces use their settings interface without stopping; stopped or crashed spaces receive file updates. Each space then calls its providers with its own configuration.
- Spaces blueprint workflows are sealed while the core space system stabilizes. Blueprint creation, generation, preview, apply and share-code import/export return `workbench/unsupported`; ordinary templates and `.dshspace` shares remain available. The independent `@klarkxy/dsh-blueprint` package is not disabled.
- The supervisor allocates the manager under the existing Home locks; ordinary profiles never gain manager write remotes.
- Unknown CLI versions, damaged identity, and another controller's lease are refused before initialization writes. Concurrent callers share startup but receive separate one-time entries.

## Lifecycle

Closing a browser tab does not stop the supervisor or spaces. Use the workbench's explicit shutdown action to stop them. Stopping the ordinary Web process also leaves the independent workbench running; spaces keep calling their models with their own configuration.

`dsh plugin --profile web remove dsh-spaces` removes the entry from that profile. It does not delete spaces, chats, or the separate manager and does not implicitly shut down its supervisor.

Upgrading Spaces means three separate user actions: add a newer version of this plugin to the host profile, shut the service down from the manager UI, and reopen Spaces. The new Supervisor then selects the host plugin's component group and aligns the manager plugin before the manager starts. Ordinary spaces receive the group's bridge when they do not have one yet; an already-installed space bridge is not automatically re-aligned to the new group, so its presence must not be treated as proof of version alignment. There is no in-app self-update and no automatic component handoff.

安装时可能需要联网获取官方依赖。早期 alpha 的管理器与隔离验证见 [历史迁移记录](../../tasks/archive/alpha-migration.md)；它不作为当前版本验收。当前宿主与平台范围以 [宿主嵌入合同](../../docs/host/embedding.md) 及其指向的最新验收记录为准。

## Distribution

The private repository root is installable directly from Git: `prepare` builds this package and `files` selects the runtime payload. Its exports point into `packages/plugin`, while build-only workspaces are excluded from runtime dependencies. The same root supports local linked development after dependencies are installed, using `dsh plugin --profile spaces-dev add .` in a separate development Home. `@dsh-spaces/supervisor` remains private because its runtime is embedded here.

Metadata includes `repository.directory`, `keywords` (`dsh-plugin`, `deepseek-harness`), public publish configuration and MIT license. Core npm publication is deferred; local pack success is not a public release. The public third-party plugin catalog accepts contributions independently.

[Installation guide](https://github.com/klarkxy/dsh-spaces/blob/main/docs/plugin-standard-install.md) · [Host embedding contract](https://github.com/klarkxy/dsh-spaces/blob/main/docs/host/embedding.md) · [Current architecture](https://github.com/klarkxy/dsh-spaces/blob/main/docs/architecture.md)
