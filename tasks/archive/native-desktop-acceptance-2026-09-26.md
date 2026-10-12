# 官方 Desktop 系统空间实验（2026-09-26）

基线为 `main@990cc80`，本轮是用户确认的隔离插件实验。目标是在官方客户端保留原应用，增加可滚动空间栏，并把看板、设置作为底部固定的系统空间。验收时代码尚未提交；现已本地提交为 `4fa5b4d`，未推送或发布。

## 实现边界

- 官方原应用的 DOM 与会话继续存在；72px 左栏通过现有 `shell.overlay` 布局座增加，不替换官方根页面。
- 看板、设置使用独立导航标识 `@dashboard`、`@settings`，共用既有管理服务。它们是系统页面，不创建两个可删除的 DSH profile。原应用默认仍是当前应用。
- 仅在实际 `dsh-app://app` 顶层页面及官方 `dshDesktop.protocolVersion === 1` 的 browser lease 桥存在时启用 native adapter。其他原生或远程宿主不因此获得兼容承诺。
- 一个官方受控 webview 保留整个 manager → workspace 来源链。Guide 只读提供目录；显式初始化仍由用户发起；点击停止空间不启动它。
- 一次性 bootstrap 兑换既有会话认证后进入 `/native/<channel>`。入口要求已认证会话、来源检查和 `frame-ancestors 'none'`；hash 通道只承载有界目标及关联请求号，没有任意 URL、脚本执行或管理命令转发。
- 设置复用完整设置内容，作为整页展示，嵌套创建/取消不卸载系统页。看板复用现有 Home 聚合实现。
- 官方 `desktop` profile 被保留名、目录分类、预览、启动与直接删除边界保护，不能当成普通受管空间修改或删除。

## 真实运行环境

使用本机官方 **0.1.7-rc.2** 的未修改 `app.asar`（build `c1275515b6b97551ec358c926c479ab750c687c0`），及同一安装包的 **Electron 44.0.0 / Node 24.18.1**。测试 wrapper 只设置隔离 Home、Electron 路径和正常退出信号，然后导入官方入口；以 unpackaged 模式避免更改系统协议注册。没有修改官方包，没有读取或写入真实 `~/.dsh`，也没有使用模型凭据或发起模型调用。

所有数据在 `.sandbox/official-desktop-trial/`。这是真实官方代码、插件管理器、Host、原生 guest 和 Spaces 服务的集成验收；不是已签名安装包的安装/升级认证，也不是长期稳定性结论。

## 已取得的实机证据

`home-3`：

- 通过官方插件管理器安装、启用实际 tarball；从 UI 初始化独立管理服务。
- 从设置 UI 创建并明确启动 `native-a`、`native-b`，两者实际运行。未启动空间点击被拒绝，状态仍是 stopped。
- 官方原会话草稿、A/B 各自草稿与编辑器 DOM 保留；只有一个原生 guest。
- 设置 → 新建空间 → 取消后仍留在设置页；看板通过独立固定入口打开。
- 另通过正常管理接口创建 12 个停止空间，共 14 个真实空间；滚动量 184px 时，底部入口的 y 坐标保持 706/762。
- 800×650 renderer 视口无横向溢出，保留官方 40px Windows 标题栏。此项是实际 renderer 的视口检查，不冒充物理窗口最小尺寸检查。
- 正常禁用/卸载清除左栏、布局保留标记和 webview；独立服务继续运行。随后通过公开 service.shutdown 正常停止服务，官方进程退出码 0。

详细结果：`.sandbox/official-desktop-trial/acceptance-home3.json`；长列表任务：`scroll-space-jobs.json`；截图：`native-long-list.png`、`native-800px.png`。这些是本机证据，不作为公开仓库的必需资产。

`home-4` 最终复验通过：全新管理服务与最终协议，两个真实空间正常创建/启动；最终客户端完成 20 轮「设置 → A/B」连续选择，每轮匹配精确的新请求号（3–41），始终保留同一 guest。实际捕获 9 次 Electron `loadURL` 返回异常，页面最终确认均正确收到，没有重发请求。官方草稿、A/B 草稿及编辑器 DOM 再次确认保留，设置新建/取消返回通过，guest 没有 Node 或官方 native bridge。

最终脚本通过 Debugger 只读核对：运行代码与 `packages/plugin/lib/client.js` 全文一致，官方加载器仅追加 source-map footer。SHA256 为 `6586548e87235961a38f4f3206d6582210adf55c4b9f598d9f50abdd45d3ab4f`；最终 tarball SHA256 为 `6cff672c17c788182df01f3573da0d022ba35f90e27aa0c73f4b6842a82c27f4`。

最终插件正常卸载后，布局标记和 guest target 均消失，管理服务及两个空间仍 running。证据：`acceptance-final.json`、`rapid-final.json`、`loaded-client.json`、`native-final-trace.json`、`state-after-uninstall.json`；最终截图为 `native-final.png`。随后独立提交公开 `service.shutdown`，正常关闭隔离环境；官方进程退出码 0，home-3/home-4 的运行权与 endpoint 均已释放，默认 profiles/web、sessions、storages 均未创建（`cleanup-final.json`）。

## 本轮发现并修正

1. 官方 CLI 在 app.asar 内，管理环境安装曾错误选择普通 Node，导致找不到 CLI。明确绑定的宿主运行时现在优先，并保留 Electron-as-Node；新隔离 Home 初始化已通过。
2. 官方 desktop 被误列为可管理空间，存在直接删除链。现在从管理目录排除，相关变更拒绝；专项检查验证文件字节不变。
3. Windows 标题栏被空间页覆盖、深色外栏背景变量不匹配；改为使用官方现有 titlebar/sidebar 变量。
4. 旧导航请求的异步拒绝会影响新选择；现在只终止仍待完成的当前请求。
5. 旧选择回执可能覆盖新的 hash 请求；现在只有当前 hash 与回执请求完全匹配才写入确认。过期回执不改写新请求。
6. 官方 Electron 的 loadURL 可在同页 fragment 已提交、甚至确认已到达时返回 ERR_FAILED。现在读取精确当前 URL：已有确认正常处理；已提交的当前请求沿用原有 45 秒确认超时，未确认不宣告成功、不重发；其他错误仍终止。

最初失败的 Home、安装与导航事件证据保留。验收工具的自动 webview 接管、固定调试端口冲突和运行时限也分别留有日志；最终验证使用无自动接管的官方进程、标准调试协议观察及鼠标/键盘输入，不把工具等待超时包装成产品通过。

## 验证与剩余范围

最终 7 文件组合专项 **138/138** 通过；desktop 管理保护另有 **2/2** 专项通过，三个 TypeScript 检查和 build-spaces 通过。没有把专项结果视为全仓库 CI 通过。`native-desktop.test.ts` 同时验证过期失败不终止、当前失败必须终止、迟到回执不能覆盖新选择。独立审查已覆盖架构适配、desktop 保护和生命周期增量。

Windows 看板后端 ACL/发布凭据仍未支持；页面依然显示 `dashboard/unavailable`，此前缺少 501 CORS 的问题仍在。本实验只验证看板作为系统空间的载体与入口，不能宣布看板数据/发布验收通过。

后续产品化还包括官方版本升级兼容、完整跨平台/签名包验收、大量已访问空间的内存与长期运行，以及全仓库门槛。当前小型 native adapter 不是通用第三方宿主框架。
