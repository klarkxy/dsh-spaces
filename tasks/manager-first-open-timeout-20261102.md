# 首次管理页超时：定位记录（尚未修复）

> 本文件保留此前未修改生产代码的定位轮。后续已补齐脱敏诊断，并捕获到一处更早的入口加载竞态；当前进展见 [续接记录](manager-navigation-diagnostics-20261102.md)。本文件中的旧 35 秒超时仍未确认根因。

日期：2026-11-02。用户要求 Codex 编排、Grok 施工，定位并修复首次管理页超时，随后复验开发链接和发行包。全程只用隔离 Home，不提交、不发布、不更新日常安装。

## 当前结论

原先两次真实 Desktop 首开失败仍有效，见 [后台启动验收](desktop-background-startup-20261101.md)。这轮没有复现其根因，没有修改生产代码，也没有把随后成功的测试称为修复。用户补充实际点击后，当前开发链接和另一套全新发行包的首次管理页都成功显示创建表单；这是未改代码的补充样本，修复后的验收仍未完成。

原猜测是外层 `loadURL(#select)` 取消了管理 iframe 的跳转。Grok 的 Chromium 探针和 Codex 的同版本 Electron 对照均未出现这一现象，不能据此删除 `ensureManager()`、修改跳转方式、加重试或延长截止时间。隐藏状态、调试器是否连接也未在当前实验中造成失败。这些结果收窄了范围，不足以排除尚未覆盖的宿主行为或时序。

## 诊断与独立执行

Grok 通过 Agent Bridge 完成两个诊断叶，保持默认模型及推理设置。它编写局部导航探针和使用生产 `NativeHostController` 的集成夹具；Codex 审查代码，并在官方 Desktop **0.2.1-rc.2 / Electron 44.7.0 / Node 24.21.0** 中执行独立对照。没有更改官方 SDK 或程序。

补充手动点击后，又派发一次窄范围窗口状态诊断；该叶约 12 分钟后仍未交付可执行夹具或新的因果证据，Codex 取消该叶并关闭 worker session，没有采用其未完成推测。Codex 仅扩展既有诊断夹具完成下表最后一项，没有接手生产实现。

新隔离目录：`H:/Code/dsh-spaces-checktmp/manager-first-open-20261102/dev-2026-11-02T04-09-04-607Z/`。下表中的 `before-` 文件都位于此目录。

| 实验 | 结果与证据 |
| --- | --- |
| Chromium 普通页与隐藏祖先 | Grok 的 33 次导航组合、15 次隐藏祖先组合均到达管理文档。记录在 `.sandbox/manager-first-open-20261102/worker/` |
| Electron BrowserWindow 基本时序 | 18 个对照条件均到达目标；包含不发送 hash、初次加载后发送和子帧提交时发送。`before-electron-race-probe.json` |
| Electron 子帧正在跳转 | 18 个 HTML/HTTP 303 对照条件；HTML 分支在子帧开始跳转、开始后 30ms、子帧加载完成时发送 hash，未出现子帧 -3。303 分支是相应控制条件。`before-electron-inflight-race-probe.json` |
| 真正 webview 的显示/隐藏 | 显示/隐藏、发送/不发送 hash、HTML/303 共 24 次，全部到达目标。`before-electron-guest-race-probe.json` |
| 实际隔离 Supervisor 与管理器 | 独立隐藏 webview，在开启及移除网络调试器后各一次，均到 `#selected/1/@settings`。`before-live-hidden-probe.json`、`before-live-hidden-without-debugger.json` |
| 生产 NativeHostController | Grok 夹具独立编译后，Codex 固定副本执行 `start → openCreate`；1,468ms 完成设置选择并发出 `#intent/create/1`，管理文档已到达。`before-controller-open-create.json`。这是控制器与真实管理器的集成探针；终点是指令交接，不等同于已经验收新建弹窗，也不等同于官方壳的完整交互 |
| 生产控制器与测试窗口状态 | 固定的生产控制器夹具分别在隐藏、显示但不激活、最小化的独立测试窗口中执行，3/3 到达新建指令，耗时 1,617 / 1,467 / 1,511ms。`backgroundThrottling` 均为 true；隐藏/最小化时 guest 的 `visibilityState` 为 hidden。`before-controller-window-state-probe.json`。该对照仍不覆盖旧失败时的完整桌面输入与遮挡环境，不能据此彻底排除宿主时序 |

官方主程序只读源码核对显示：对应 guest 导航守卫限制主帧；会话过滤拒绝官方宿主端口。当前 Desktop/Supervisor/manager 使用不同端口，没有发现端口冲突。没有禁用、替换或绕过官方安全守卫进行正式验收。独立夹具使用自己的测试窗口与会话，不能据此宣称官方壳的守卫和输入链已经通过。

## 实际点击与工具限制

此前 Computer Use 的点击和按键未产生应用响应，随后窗口激活明确报 `failed to activate captured window`；重新枚举、绑定同一窗口后仍失败。中途截图仅显示背景图，曾怀疑锁屏，但只读系统检查返回正常输入桌面 `Default`，不能认定锁屏。后续窗口可读、激活调用可返回，但坐标点击和元素点击仍未触发新 guest。这是本轮采集限制，不能认定为旧两次导航超时的原因。

用户分别在两个隔离窗口手动点击一次“＋ 新建空间”，取得以下被动导航事件和实际表单截图。两次均未连接 guest 的网络调试器，未禁用官方安全守卫。

| 路径 | 实际首次点击与结果 | 证据 |
| --- | --- | --- |
| 开发链接 `dev-2026-11-02T04-09-04-607Z` | 04:55:06.454Z 创建 guest，07.880Z 完成设置选择，07.891Z 交出新建指令，约 **1.437 秒**。创建表单可见。此前该隔离服务已运行约 45 分钟，且独立探针访问过管理器，因此不是管理资源首次冷加载样本 | `before-manual-click-trace.json`、`before-manual-click-result.json`、`before-manual-click-visible.png` |
| 全新发行包 `pack-2026-11-02T04-59-54-814Z` | 05:05:10.023Z 创建 guest，12.840Z 完成设置选择，12.879Z 交出新建指令，约 **2.856 秒**。创建表单可见。此前无管理 guest 或管理页面探针；服务 ready 到实际点击约 4 分钟 | `active-coordinate-manual-click-trace.json`、`active-coordinate-manual-click-result.json`、`active-coordinate-manual-click-visible.png` |

以上耗时从 guest 创建算到新建指令交接；表单通过随后只读 DOM 和截图确认，不把截图采样时间算成表单精确出现时间。发行包目录位于同一个外部隔离根 `H:/Code/dsh-spaces-checktmp/manager-first-open-20261102/`。两者均先提交同文档 `#select`，再加载 `/view/spaces-hub/1`，随后跳转管理源；未记录加载失败或 provisional failure。各只有一次 Supervisor 启动、一次主模型注册，无子空间创建或启动。发行包在 05:06:45Z 正常退出，停机作业 `acceptance-6c454d65-b622-48ff-af49-fbc1c93996eb` 为 succeeded，端点已释放。

开发链接的后续测试窗口均正常关闭，最后通过 `service.shutdown` 计划停止服务；作业 `acceptance-a94f9220-fb8b-49bd-bfe5-cac26340695b` 为 succeeded，端点已释放，再调用应用正常退出。两套 Desktop 均以退出码 0 结束，未强杀，日志与隔离目录保留。

先前探针事件和两次手动点击事件分别保存。记录包括 `did-fail-provisional-load`、子帧提交及加载完成、主帧同文档导航；票据和凭据不写入交付记录。原先失败时未采到完整导航事件，下一步仍需要实际失败的事件序列，才能选择修复及永久回归。

## 边界与检查

两套补充样本均只有一次 Supervisor 启动、一次主模型注册，未创建或启动子空间。官方 EXE 与 app.asar 摘要保持一致；隔离 Home 未出现 `profiles/web` 或默认 `sessions` / `storages`。未读取真实 `~/.dsh`。

实际加载制品核对：旧失败 D/P 和新成功 dev/pack 四份记录中的 `lib/client.js`、`lib/index.js`、`lib/supervisor/index.js`、`lib/supervisor/manifest.json` 分别只有一个 SHA-256，关键构建没有变化。比对文件为 `.sandbox/manager-first-open-20261102/manual-click-artifact-comparison.json`。

工作树相对此轮开始的精确快照核对：生产源码、永久测试、配置及构建输入没有变化，本轮仅增加诊断辅助文件和本记录。HEAD 保持 `c7f6fdeea7c5d1703d53ff980975351c5ab3c13d`。本轮没有重新执行完整项目检查；上轮完整检查和其失败项独立复查仍以原验收记录为准，不能用它们证明尚未实施的修复。
