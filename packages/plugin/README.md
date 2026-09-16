# @dsh-spaces/plugin

DSH-native Spaces workbench, with a dedicated manager and an independent local supervisor.

Fault policy: [let it crash](../../docs/let-it-crash.md). Plugin combinations may fail. This package reports the failure; it does not recover the environment.

当前为本地预构建包，尚未发布到 npm。默认跟随官方 CLI **`latest`** 并钉住所选精确版本。本仓库 SDK peer 为 `0.1.5-rc.2`，那不是 CLI 白名单。

## Install from this checkout

```powershell
pnpm run pack:plugin
```

Run the printed `dsh plugin --profile web add <tarball> --config.auto-install-peers=true` command, then `dsh web`. In the ordinary DSH sidebar choose **工作台 / Workbench**, then **初始化 Spaces / Initialize Spaces**.

No global CLI is required if you use `pnpm dlx @deepseek-ai/dsh@latest` in place of `dsh`. Package output defaults to `%TEMP%/dsh-spaces-pack`, outside package trees. Windows local tarball paths must not contain spaces; the pack script checks this and never requires a pre-existing `$artifacts` variable.

初始化使用当前 DSH Home。普通页面保持原有界面，只有用户点击初始化后才创建管理空间和启动监督程序；失败会显示原因，该次请求结束，下次打开不会自动补装或续接。再次进入时点击“进入工作台”。只需在一个已有 Web profile 安装完整入口，工作台新建的空间自动使用轻量 view-bridge。

## Package contract

- Standard `dsh.bundle.patch` and `cordis.patch.yml` let the official CLI maintain the profile's bundle list.
- `dsh.client` and `./client` supply the Web client through DSH's module loader and shared React.
- The tarball includes supervisor, snapshot worker, and view-bridge payloads. Users do not need a second package or this source checkout at runtime.
- The supervisor allocates the manager under the existing Home locks; ordinary profiles never gain manager write remotes.
- Unknown CLI versions, damaged identity, and another controller's lease are refused before initialization writes. Concurrent callers share startup but receive separate one-time handoffs.

## Lifecycle

Closing a browser tab does not stop the supervisor or spaces. Use the workbench's explicit shutdown action to stop them. Stopping the ordinary Web process also leaves the independent workbench running.

`dsh plugin --profile web remove @dsh-spaces/plugin` removes the entry from that profile. It does not delete spaces, chats, or the separate manager and does not implicitly shut down its supervisor. Workbench package maintenance is distinct from upgrading the supervisor itself; reinstalling this entry is not evidence that every component has upgraded.

安装时可能需要联网获取官方依赖。CLI rc.1 与 rc.2 的标准安装路径使用独立 Home 做真实浏览器验收；完整主题、故障注入与桌面安装器的验收范围另见项目记录。管理包升级失败回滚已由 2026-09-15 let it crash 撤销，不再作为通过条件。

## Distribution

The repository root also contains the Electron app; a Git install of the monorepo root is not this plugin. Distribute a built npm package or this tarball. `@dsh-spaces/supervisor` remains private because its runtime is embedded here.

Metadata includes `repository.directory`, `keywords` (`dsh-plugin`, `deepseek-harness`), public publish configuration and MIT license. npm publication and community catalog listing still require completion; local pack success is not a public release.

[Installation guide](https://github.com/klarkxy/dsh-spaces/blob/main/docs/plugin-standard-install.md) · [Workbench architecture](https://github.com/klarkxy/dsh-spaces/blob/main/docs/workbench.md)
