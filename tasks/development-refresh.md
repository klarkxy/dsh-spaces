# 开发启动与当前源码一致（2026-09-22）

## 根因与范围

原 `pnpm run dev` 只构建 Electron 外壳。桌面工作台来自持久后台中已安装的管理插件；源码构建、已安装插件、已选组件指针是三个独立位置。原沙箱仍使用 `aba65a979ede…` 组件，构建内虽有新的首页和设置，界面仍旧。

现在开发命令先构建完整组件，设置独立开发窗口数据目录 `.sandbox/electron-user-data`，再启动 Electron。主进程取得单实例锁之后才进行内容检查和更新。已有窗口时以退出码 1 拒绝，原后台不受影响。现有 Home 沿用原数据；主进程与开发准备都遵循工具链记录中的 Supervisor tools root，避免产生两份选取指针。

有内容变化时，先暂存并打包不可变组件，再正常关闭健康空闲服务；取得 Home 所有权和写锁，使用正式插件安装接口更新独立 manager 的 plugin / view-bridge，验证完整组件及 bridge 文件后，在冷启动锁和 Home 写锁中选取新组件。无变化时不安装、不停止后台。全新 Home 仍进入正常首次安装。

这不是 HMR：管理插件源码变化在下一次主动启动开发命令时应用。普通空间仍活动、任务执行中、所有权不明、路径别名或维护中断时拒绝更新。

## 失败证据

开发更新使用 `.dsh-spaces-control/workbench-upgrade.json` 作为已有运行时可识别的阻断文件，内容带独立的 `kind: development.refresh`、本次 id、managerId 与目标 digest。旧后台也按文件存在拒绝维护；此内容不会被误认为可以继续执行的普通升级计划。第一次安装前写入，安装/校验/选取/完成失败时保留。只有这次调用确认安装字节、选取指针并核对自己的 id 后才移除。后续开发启动不会重放或覆盖中断证据。

## 当前验收

- 开发刷新 14 项定向测试通过：完整安装、保留数据、中途失败、bridge 字节不符、指针提交后完成失败、缺少冷启动锁、控制器竞争、Home 写锁、维护残留、旧工具目录、首次安装、真实 Home 拒绝、打包路径 junction、快速关闭竞态及服务空闲条件（相关场景合并于同一测试）。
- 组合回归：开发刷新、组件选取、桌面启动、服务客户端共 65 项；独立审查已修正打包目录别名、单实例锁时序、关闭 owner 取证时序。
- node、web、spaces 三组类型检查通过；组件构建和 Electron 开发构建通过。没有将开发构建等同于打包或发布验收。
- 当前沙箱真实 `pnpm run dev --remoteDebuggingPort 19324` 更新成功，安装、选取与当前构建 digest 均为 `b058d242d4f2…`；后台可写且没有受限原因。
- `.sandbox/dev-refresh-acceptance/result.json`：真实原生 DSH 首页、首页无管理 tabs、设置分类、固定关闭、Esc 关闭和首页实例保留通过。截图 `home.png`、`settings.png`、`settings-advanced.png` 已检查。首页保留 DSH 首次内测声明，未代填密钥或发送模型请求。
- 第二次开发命令在旧窗口存在时退出 1，提示退出原开发命令；对比 PID 与启动时间，Supervisor 没有变化。
- `.sandbox/dev-refresh-acceptance/component-proof.json`：当前构建、管理插件安装、已选组件三者完整 digest 相同，真实运行 Supervisor 的程序路径也属于这份组件。
- 通过浏览器关闭测试窗口后，以不带调试参数的 `pnpm run dev` 正常重开，输出 `current: b058d242d4f2`，没有重复安装。新开发窗口保持打开；没有终止用户原来的开发终端。
- `.sandbox/dev-data-before.json` 与 `.sandbox/dev-data-after.json`：`profiles/web`、默认 `sessions/storages`、hub 下原管理数据及 web 数据、空间定义、设置及凭据文件的内容指纹一致。仅散列比较，不输出凭据内容；未访问真实 `~/.dsh`。

第一次受限运行在暂存前因 AppData 写权限失败，未停止后台；取得本轮工具权限后才完成实际更新。该环境阻断与产品更新失败分别记录。仅本地修改与验收，未提交、推送或发布。
