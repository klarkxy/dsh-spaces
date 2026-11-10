# 首次导航诊断与初始页面加载竞态

日期：2026-11-02。Codex 编排、审查和独立验收，Grok 施工。用户要求先补齐脱敏诊断，取得实际失败证据后再修；只用隔离 Home，不提交、不发布、不更新日常安装。

## 当前状态

已经捕获并定位一处更早的首次导航失败，修复和永久回归已写入。最终完整检查与修复后的开发链接、发行包实测尚在执行。

这处失败发生在初始 `about:blank` 向入口页面跳转期间。它与此前 D/P 两个样本的管理页面 `view-ready-timeout` 分开记录；不能据此声称旧的 35 秒超时已查明或修复。前一轮原始证据见 [首次管理页超时定位](manager-first-open-timeout-20261102.md)。

## 脱敏诊断

新增 `src/shared/nav-diag.ts`，外壳、portal 和 child bootstrap 记录固定阶段。记录包括来源、递增序号、单调耗时、路由与目标类别、主帧标志、数值错误码、HTTP 状态和闭合的错误枚举。每个发射器最多 96 条，包含截断标记；首次导航结果或终态后停止记录。

不记录原始 URL、查询和片段、票据、Cookie、Authorization、channel、epoch、lease、空间名称、输入或任意异常文字。日志字段使用白名单；异常字段、计时器和日志接收端出错不改变产品控制流程。生成到页面中的诊断函数能在标准浏览器脚本环境执行。

外壳记录初始页面加载、入口与选择请求、导航事件、被忽略的子帧/`-3` 事件和失败终态。portal 区分管理页面就绪截止与选择截止，记录两种就绪握手和首次选择结果。child bootstrap 只在原来的 `location.replace` 前后增加静态标记，保留原 meta refresh、目标和安全头。

独立采集器位于 `.sandbox/manager-nav-diag-20261102/`，在官方 Electron 主进程被动观察事件，将白名单记录连续保存为 JSONL，最多 2,000 条。没有接管请求、连接网络调试器或改变官方安全守卫。原始控制台文字被丢弃；持久化异常和截断有独立状态。

## 真实失败与因果对照

证据根：`H:/Code/dsh-spaces-checktmp/manager-nav-diag-20261102/`。以下两份是**修复前构建**，实际安装摘要已核对。

| 样本 | 结果 |
| --- | --- |
| `dev-2026-11-02T12-10-14-940Z` | 首次实际点击成功。guest 创建至新建指令约 1,431 ms，实际创建表单可见。点击约在主模型注册完成 33 秒后，不能称为后台启动中的点击。 |
| `pack-2026-11-02T12-21-21-798Z` | 点击前界面为“准备中”，首次实际导航失败。服务保持 ready，只有一次 Supervisor 启动和一次主模型注册，无子空间。错误页可见。 |

发行包失败的冻结记录为 `baseline-early-frozen-navigation.jsonl`，关键 UTC 时间：

1. `12:23:36.486Z`：初始空白页 `dom-ready`。
2. `.489Z`：入口 bootstrap 的新导航开始。
3. `.491Z`：上一张空白页发出 `did-finish-load`。
4. `.497Z`：guest 被销毁。没有入口文档提交，也没有加载失败事件。

同一隔离官方 Desktop **0.2.1-rc.2 / Electron 44.7.0 / Node 24.21.0** 中，独立隐藏测试窗口对 `loadURL` 时序进行对照。`baseline-early-main-load-probe.json` 显示：在 `dom-ready` 中调用下一次加载，新导航开始后，旧空白页的 `did-finish-load` 会使新 Promise 完成，此时实际地址仍为 blank。改在 `did-finish-load` 或 `did-stop-loading` 后发起的两项对照均到达目标。这个测试不改产品失败控制器，也没有重新启动该服务。

Electron 44.7.0 对应源码的 `_awaitNextLoad` 监听 `did-finish-load` 和 `did-stop-loading`，完成回调不匹配具体文档。版本匹配的源码副本为 `.sandbox/manager-nav-diag-20261102/electron-web-contents-v44.7.0.ts`，SHA-256 为 `DC74B4357DEC62ECCA307FEB0823F6E993085CCD28479C0BC4C8E84A1C50FAE8`。

两份 renderer 侧探针中，新导航都在旧 finish 之后才实际开始，因此没有复现。它们的成功结果保留，不能替代上述实际失败和主进程时序对照，也不能证明所有首开问题都来自这一处。

## 修复

`NativeHostController.createGuest` 现在等初始空白页的 `did-finish-load` 已出现，且随后 `did-stop-loading` 到达，再发出第一次 bootstrap `loadURL`。`dom-ready` 仅作为观察阶段。这样上一轮加载的完成/停止事件不会落入下一次加载的 Promise。

原来的 15 秒初始准备时限、取消和停止、租约释放、bootstrap 地址校验、选择截止和失败终态保留。没有增加睡眠、重试、重连、恢复或放宽权限。诊断新增 `guest-load-stopped` 固定事件，相关模拟 guest 发送完整的初始加载顺序。

永久回归先在未修实现上运行：`dom-ready` 后已经出现一次 bootstrap，期望为零，测试按预期失败。修复后，dom-ready 和 finish 阶段均不启动 bootstrap，stop 后只发出一次 bootstrap 并继续一次选择。日志分别为 `worker-controller/blank-load-old-failure.log` 和 `blank-load-after.log`。

## 检查与实测

- Grok 定向：初始页面修复及相关 native/diagnostic 测试 63/63；portal 生成脚本、身份边界、35 秒截止、HTTP 失败和 bootstrap 标记测试 7/7。Codex 已阅读代码、差异和日志；这不是正式 Desktop 复验。
- Codex 独立完整检查 `checks-1`：测试清单通过，类型检查发现计时起点隐式 `any`；额外测试类型检查发现一处 mock 类型转换。已修正，原失败保留。
- `checks-2`：测试清单通过，起点类型明确后暴露一处 `now` 的类型收窄遗漏；停止在类型阶段，构建和后续测试未执行。正在补齐并检查。
- 后续并发检查的进程生命周期失败和串行复查卡死，根因是 Codex 桌面应用持续执行 `taskkill /T`，WMI 进程查询被取消；与本轮改动无关。用户退出 Codex 后重跑。
- [x] 最终完整检查：`check:all` 单次 14/14 通过，用时约 4 分钟（`.sandbox/manager-nav-diag-20261102/checks-after-wmi/`）。
- [ ] 最终构建的全新开发链接实测。
- [ ] 最终构建的全新发行包实测。

## 清理与证据边界

首份采集准备目录 `dev-2026-11-02T12-06-54-172Z` 因辅助脚本在 Electron 求值环境中使用动态导入而失败，尚未进行交互。已确认没有存活的该测试进程或端点，目录保留；修正辅助脚本后使用新的隔离目录。它不是产品导航失败。

上述修复前 dev/pack 样本均已通过 `service.shutdown` 计划正常停止，作业分别为 `acceptance-24d4cf43-1ead-4fba-be1f-98e09d57c015` 和 `acceptance-53fbe6ee-46f6-4b5a-9932-74e79e1c7622`，状态 succeeded，端点释放；官方应用正常退出码均为 0。独立测试窗口正常关闭。未强杀、未删除失败现场。

官方 EXE 与 app.asar 的前后摘要一致；测试 Home 未出现 `profiles/web` 或默认 `sessions` / `storages`。没有读取真实 `~/.dsh`、更新日常插件或修改官方 SDK。工作树相对此轮精确快照的差异保存在 `.sandbox/manager-nav-diag-20261102/task-diff.json`；HEAD 保持 `c7f6fdeea7c5d1703d53ff980975351c5ab3c13d`。
