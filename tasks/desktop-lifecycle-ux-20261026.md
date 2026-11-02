# 2026-10-26 官方 Desktop 生命周期与提示验收

## 结论

启动、子空间关闭/重启、窗口收起、应用退出/重开、整个服务停止/手动启动、全停后的冷启动均实际走通。当前体验仍不够友好，尤其是未发送草稿在应用退出后丢失，以及正常停机被展示成连接故障。本轮为验收与问题记录，没有修复产品代码、提交、推送或发布。

## 环境与证据边界

- 官方安装版 Desktop `0.2.1-rc.2`，Electron `44.7.0`，内置 Node `24.21.0`；使用当前仓库正式打包插件，安装后的四项核心产物摘要与构建一致。
- 全新 Home、独立 userData、独立缓存及仓库外临时目录；没有读取真实 `~/.dsh` 或复制用户账号配置。
- 用户明确指定本机 Magpie。实时模型目录确认 `minimax-code/MiniMax-M3.1-Flash`；配置 `http://127.0.0.1:3425`，仅本地占位认证、零模型自动重试。
- GUI 点击、输入与截图使用 Windows Computer Use。Electron 启动工具只负责启动、身份核对、只读诊断及首轮配置前的正常退出，不替代界面交互验收。
- 首次无模型配置时停在官方欢迎页，未进行认证操作；配置用户指定的本地模型后正常进入主界面。
- 证据目录：[`.sandbox/desktop-ux-20261026`](../.sandbox/desktop-ux-20261026)。运行原始记录：`H:/Code/dsh-spaces-checktmp/desktop-ux-20261026/run-2026-10-26T10-59-03-699Z/`。

## 已完成的真实流程

| 场景 | 实际结果 | 证据 |
|---|---|---|
| 首次初始化及创建空间 | 初始化有“正在连接空间服务”提示；创建 `space-lifecycle` 后自动启动，状态为 running | `01-initializing.jpg`、`03-created-starting.jpg`、`04-initial-running-state.json` |
| 真实模型请求 | 子空间继承主空间 Magpie 模型，回复“启动验证通过”，turn completed | `05-model-replied.jpg`、`model-evidence.json` |
| 右键关闭 | 直接执行，出现“正在关闭”，转回 Desktop；空间 stopped、generation 2 | `06-running-menu.jpg`、`07-stopping.jpg`、`07-stopped-state.json`、`08-stopped.jpg` |
| 点击已停止空间 | 出现“正在打开”，正常启动并进入原会话；running、generation 3 | `09-starting.jpg`、`10-started-again-state.json` |
| 右键重启 | 一次正常停止再启动；running、generation 5，历史消息与未发送草稿保留 | `11-draft-before-restart.jpg`、`12-restarting.jpg`、`12-restarted-state.json`、`13-restart-preserved.jpg` |
| 关闭窗口到托盘 | 首次明确提示任务继续、可从托盘重开；确认后主窗口隐藏，进程存活 | `14-close-to-tray-confirmation.jpg`，Electron 只读 isVisible=false |
| 再次打开已收起的应用 | 使用同一隔离启动参数唤回同一窗口；会话与草稿仍在。未点击系统托盘图标 | `15-window-restored.jpg` |
| 应用菜单退出 | 官方进程正常退出，code 0；独立服务及子空间继续运行，代次不变 | `configured-desktop-exit.json`、`16-desktop-exited-state.json` |
| 应用正常重开 | 新 Desktop 进程启动，空间 running；打开原会话后历史保留，但未发送草稿丢失 | `17-desktop-reopened.jpg`、`18-reopen-draft-lost.jpg` |
| 重开后模型可用性 | 再次通过 Magpie 同一模型回复“重开验证通过”，turn completed | `19-reopen-model-pass.jpg`、`model-evidence.json` |
| 停止整个服务：预览与取消 | 列出管理空间、测试子空间；取消后服务纪元和空间代次不变 | `20-service-stop-hint.jpg`、`21-service-confirm-technical.jpg`、`22-cancelled-shutdown-state.json` |
| 确认停止整个服务 | 正常停止、端点和所有权释放；UI 转成红色连接错误 | `23-service-stopping.jpg`、`24-normal-stop-shown-as-error.jpg` |
| 已停止服务的手动启动 | 明确确认后启动一次，管理空间 running，子空间 stopped、generation 0；无任务续跑 | `25-service-start-confirmation.jpg`、`26-service-start-wrong-progress.jpg`、`27-manual-start-state.json` |
| 全停后的应用冷启动 | 应用退出并正常停止测试服务后重新打开；本次启动建立新服务，子空间仍 stopped | `28-cold-start-baseline.json`、`29-cold-start-state.json`、`29-cold-start-ready.jpg` |
| 停止状态的右键菜单 | “启动”可用，“关闭/重启”禁用，状态文字为已停止 | `30-stopped-menu.jpg` |

## 问题与建议

### 1. 应用退出后丢失子空间未发送草稿，退出前没有提醒

**实测，优先修复。** 同一段草稿经过子空间重启、窗口收起/恢复都保留；从“应用 → 退出”真正退出 Desktop，再打开原会话时输入框变空。历史消息仍完整。不能将“会话已持久化”等同于“编辑内容已保存”。

建议将草稿按空间与会话稳定持久化；在不能保证保留的情况下，退出前说明具体影响。此处没有进一步判定是宿主还是嵌入会话层负责丢失，需另行定位，不能凭本次现象直接归因。

### 2. 主动正常停机被展示成故障

**实测，优先修复。** 在“停止整个服务”确认后，先出现红色“当前结果尚未确认”，随后进入“空间服务或页面不可用”与英文 `The workbench request did not reach the supervisor.`。同期只读核对端点与所有权均已释放，实际是预期的正常停机。

建议外壳保留此次主动停机意图，观察该次准确作业与所有权释放，在可确认时显示“Spaces 服务已停止”。无法确认时明确标为结果待确认；真实失败仍保留。不要通过重试或掩盖失败来改善文案。

相关位置：`packages/plugin/src/workbench/store/parts/requests.ts` 的停机结果反馈、`packages/plugin/src/client/ui/native-controller.ts` 的终态错误、`native-shell.tsx` 的展示。

### 3. “退出应用”“关闭窗口”“停止空间”“停止服务”的范围没有统一说明

**实测。** “×”首次有清晰的托盘说明，这是正面结果；但应用菜单“退出”直接结束 Desktop，独立服务和子空间继续运行，没有告诉用户这些仍在运行。子空间继承主空间模型时还存在主空间依赖，不能让用户仅凭绿点判断所有能力可用。本轮没有在 Desktop 退出期间发起第三条请求，模型依赖失效期间的具体报错不属于实测结论。

建议在退出入口说明后台空间是否继续运行及主模型依赖的影响，并给出清楚的“仅退出 Desktop / 停止 Spaces 服务”的区分。

### 4. 服务停机确认框暴露内部协议，动作与后果不直观

**实测。** 标题是泛化的“确认这项更改”，正文两次显示 `service.shutdown`，还显示“控制器”及 ISO UTC 过期时间。虽然受影响空间列对了，用户仍需自己翻译操作含义。

建议标题改为“停止 Spaces 服务？”，正文说明停止哪些空间、当前任务会怎样、会话记录是否保留；按钮写“停止服务”。技术详情按需展开。相关位置：`packages/plugin/src/workbench/view/dialogs.tsx` 的 `plan.title`、`plan.changes` 和 `plan.expiresAt` 展示。

### 5. 过程提示已经有，但完成反馈和部分动作名称仍不准确

**实测。** 子空间启动/关闭/重启有底部状态提示，绿点/灰点和菜单文字能反映实际状态；操作结束主要靠提示消失和颜色变化，没有明确结果。关闭当前空间时突然返回 Desktop，重启后又自动回到空间，没有说明这一过程。服务已经停止时点击“确认启动服务”，等待文案仍然写“正在正常停止旧服务并启动一次新服务…”。

建议添加短暂的明确完成反馈，说明当前所在空间及是否保留会话；按真实动作区分“启动”和“重启”。相关位置：`packages/plugin/src/client/ui/native-shell.tsx`、`native-controller.ts`、`service-restart.tsx:39`。

### 6. 关闭/重启子空间没有任务影响说明

**实测入口与源码一致。** 右键菜单点击后直接执行，没有提醒会中断正在执行的任务。本轮关闭/重启时模型调用均已完成，因此没有将“运行中任务丢失”作为已复现结果。

建议至少在存在运行任务时展示影响与确认；空闲空间可保留快捷操作。需要结合实际任务状态设计，避免对每次空闲关闭都增加多余确认。

### 7. 首次设置流程的等待与入口仍有改进空间

**实测。** 首次初始化等待期间只显示“正在连接空间服务…”，没有区分准备依赖与连接。新建空间的创建按钮在头像列表下面，当前窗口高度需要滚动；新空间首次进入还会弹官方预览版说明。建议细化可证明的阶段反馈，创建表单保留可见的操作区，减少重复首次提示。

## 收尾与限制

- 4 次测试 Desktop 进程均正常退出，退出码 0；最终测试服务正常 shutdown，端点与所有权目录均不存在。测试数据及全部证据保留，无强杀、自动恢复或失败重试。
- 官方 EXE/ASAR SHA-256 前后一致；最终无 `profiles/web`、Home 根 `sessions` / `storages`。
- 开始和结束只读进程核对中，原有 8 个官方 Desktop 相关进程的 PID、父 PID、创建时间一致。
- [最终隔离核对](../.sandbox/desktop-ux-20261026/final-isolation-audit.json)。本次为 GUI 与真实模型验收，不以旧自动测试结果代替。本轮没有更改产品实现，未重跑整套源码回归。
- 未覆盖操作系统重启、运行中模型任务强行中断、真实进程崩溃、长期运行、活服务故障状态下的“一键服务重启”分支。已覆盖正常空间重启，以及整个服务明确停止后手动启动的完整循环。
