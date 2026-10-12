# DSH Web 发布前实机验证（2026-09-26）

本文件保留修复前的失败事实。后续修复及最终通过证据见 [Windows 看板修复验收](windows-dashboard-fix-2026-09-26.md)。

结论：**基础空间流程通过，整体不通过，暂不进入版本发布。** Windows 默认 Home 看板仍不可用，具体平台错误也被 CORS 缺失遮蔽。本次未修改产品源码、升版、提交、推送或发布。

## 候选与运行环境

- 基线 `990cc80faf65d5335c6c330cb1470ab925ccc4f3` 加当前未提交改动，包含官方 Desktop 适配和空间头像。不是仅验收已提交的 main。
- Windows、Node 24.16.0、本地已安装的官方 DSH CLI 0.1.7-alpha.1、仓库 Playwright 1.62.1。未重新确认该 CLI 是否为官方最新版本，也未把本次结果扩展到官方 Desktop rc.2。
- 从当前源码重新构建并打包，通过官方 `dsh plugin add` 安装到命名 `acceptance-host`。该 profile 从官方 Web 虚拟默认配置创建，应用既有隔离 patch 后启动真实 DSH Web；浏览器为真实 Chromium，无接口 mock、无模型调用。
- 插件 tarball SHA-256：`3691a5d229dd1cac0b644675289fed74c0cce1fcc4a62c36a06af437eb7bdbbd`。
- Home 为 `.sandbox/web-release-check-20260926-run2/home-Wn2Xt0`。真实 `~/.dsh` 未读写；默认 `profiles/web`、`sessions`、`storages` 在本次隔离 Home 中始终未创建。

## 已验证

- 当前 `build-spaces`、spaces/node/web 三个 TypeScript 检查和 `git diff --check` 通过。
- 标准安装注册插件；初始化之前不存在管理空间。
- 浏览器完成首次进入并点击初始化，真实 Supervisor 创建唯一 `spaces-hub`，工作台嵌入原宿主。
- 经真实管理 API 创建和启动 `coding`，浏览器点击左侧空间，view-bridge 握手成功、目标 iframe 可见。空间内仍是官方首次使用引导；本次没有把聊天输入、保存或模型响应计为通过。
- 重复进入不创建第二个管理空间；关闭再启动普通 Web 后仍进入同一管理空间。
- 800×700 浏览器下宿主页宽度与 scrollWidth 均为 800；已检查首页和空间截图。
- 主动 `service.shutdown` 的持久任务为 succeeded，Supervisor PID 死亡、endpoint 失效、管理及空间端口关闭。没有把提交后连接中断当成成功证据。
- 独立 Web 宿主清理完成后，标准卸载删除依赖及 bundle，dump-config 不再包含插件；所有本次测试端口均已关闭。

## 发布阻塞

1. **Windows Home 看板不支持。** 默认页面显示“看板读取已停止 / 当前内容不可用 / dashboard/unavailable”。同一浏览器会话请求 `/api/dashboard/v1/query` 实际得到 HTTP 501，错误码为 `dashboard/unsupported-operation`。`WorkbenchSupervisorRuntime.initDashboard` 在 Windows 直接返回，file-store、bootstrap 和 publisher 也有明确平台拒绝。多空间发布、固定卡片及撤权未能验收。
2. **平台错误缺少 CORS。** 使用管理 Host Origin 发起 OPTIONS，同样返回 501，`Access-Control-Allow-Origin` 缺失；真实浏览器控制台记录预检失败，所以页面丢失具体 unsupported 原因。这需要与 Windows 后端能力一起解决，不能仅通过改提示认定可发布。

## 测试执行限制与证据

首次打包因用户级 npm 缓存写入权限失败，改为本次专用缓存后重新执行，未更改系统配置。正式流程在最终清理时因独立 Web 宿主端口 8312 仍监听而退出失败；原始 `results.json` 保持 fail，未改写成通过。

后续核实 PID 89728 的命令行确属本次 `acceptance-host --port 8312`，提权清理该进程及子进程 92204。后台的正常 shutdown 在此之前已验证成功，残留属于测试启动的独立 Web 宿主。独立后续检查确认 7934、8312、10140、3104、3103 全部关闭，并完成卸载及保护路径断言。清理不计为产品正常退出通过。

- [原始结果](../../.sandbox/web-release-check-20260926-run2/results.json)
- [清理、卸载与隔离复核](../../.sandbox/web-release-check-20260926-run2/followup.json)
- [运行日志](../../.sandbox/web-release-check-20260926-run2.log)
- [看板实机截图](../../.sandbox/web-release-check-20260926-run2/dashboard.png)
- [800px 截图](../../.sandbox/web-release-check-20260926-run2/dashboard-800.png)
- [空间截图](../../.sandbox/web-release-check-20260926-run2/coding.png)

本次没有全仓库回归、远端 CI 或发布制品验证。修复上述阻塞后，应在最终候选上重新完成 Windows 看板/发布和 Web 用户流程，再做版本、CI 与制品准备。
