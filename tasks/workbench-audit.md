## 当前有效合同（2026-09-15）

故障政策：[docs/let-it-crash.md](../docs/let-it-crash.md)。活动账本：[todo.md](todo.md)。

隔离、鉴权、单写者、原子写、错误报告，以及用户主动的启动、停止、重启、安装、卸载和配置，仍有效。救援入口、检查并恢复、恢复中断任务、配置恢复、整 Home 恢复、Doctor `unlock`/`recover`/`rollback`、失败回滚、失败重试和中断续接 **已撤销**，不是延期，不勾成已完成。剩余运行时工作见账本 R1–R6（pending）。下文是当时实施与验收记录，不是现行恢复门槛。

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# 工作台独立审计（进行中）

## A1 控制记录候选问题

2026-09-12，Codex独立运行临时Home反例：ensureManager成功后将manager.json写成截断JSON，再次ensureManager未进入恢复模式，重新覆盖了损坏记录（corruptIdentityOverwritten=true）。现有readManagerFile/parseManager将“读取失败/内容损坏”与“文件不存在”都返回undefined，导致误初始化。待Grok交接后集中返回修正；不得将当前在写文件阶段的全项目TS失败当成最终缺陷。

同时需要检查Windows大小写不敏感的名称冲突：existingProfileNames当前Set保留原大小写，spaces-hub匹配可能遗漏Spaces-Hub既有目录。

修正与验收：A1一次聚焦修正已完成；Codex独立重跑24项测试全通过，并再次运行大小写占用与截断manager.json反例，分别选择spaces-hub-2及保留损坏原字节并拒绝重建。A1模块可以交给监督层消费；这不等于已完成桌面/Web接入。

后续监督bootstrap必须注意：needsBootstrap仅表示目录是否存在，不等于已验证安装完成。控制记录预约名称后，若目录中出现非本次引导建立的既有普通profile，不能据此覆盖其插件/配置或将其当成已就绪管理器。

## A2 任务日志候选问题

Codex已在独立临时Home实际复现：

- schemaVersion=999、其余字段看似正常的旧/未来job文件被当成succeeded。需要版本、文件名/id与必需字段一致性验证；损坏记录应保留证据并进入恢复，不能凭宽松字段映射当成功。
- 两个任务先入队，第一个任务phase持久化注入失败；第一个标recovery-required，但第二个仍succeeded且副作用执行1次。必须阻止后续排队变更跨过未解决恢复状态。

接口缺口：目前没有明确settleRecovery/resolveInterrupted入口。监督进程完成实际恢复后，需要受约束地更新旧中断任务终态并恢复队列；仅提交新的recovery.resume任务不能让旧job永远悬挂，也不能自动重放变更。

公共投影需再核查：runtimeVersion不得任意字符串（路径也会通过），view.origin应为干净loopback origin，entryPath不得network-path/外部URL/原始token。未知Error宜返回静态公共错误，不靠有限正则保证任意底层报错安全。

修正验收：Grok唯一重试已处理上述问题；Codex独立运行21项任务测试通过（.sandbox/workbench-jobs-root-tests.log），其中包括两个原始反例。Codex补上未知/损坏记录不能调用settleRecovery伪造终态的门禁，保留字节供doctor处理；可解析中断记录仍可在实际事务恢复后结算。视图新增entryOrigin区分监督引导与最终子origin，并收紧投影。

## B 界面独立审查

初版21项store/SSR测试不足以证明持久DOM：components.tsx条件渲染WorkspaceStage会在首页或轮询故障时卸载iframe；selectSpace提前持久化未就绪目标；create即时成功会自动选中新空间；没有视图就绪超时。已交唯一聚焦修正，要求实际DOM节点/草稿验证以及最后选择胜出、失败保留旧空间。

修正验收：Grok重试后，Codex独立运行30项UI检查（29单测+1真实Chromium DOM）通过。Codex补了临时断线不销毁已访问视图、挂起的授权请求不被轮询重复提交/重置超时，以及删除选中目标后持久化首页。DOM fixture已从忽略的.sandbox迁入tests/fixtures/workbench-ui，测试可复跑。日志.sandbox/workbench-ui-root-tests.log；完整DSH主题切换仍待产品验收。

## A0 实验范围

Codex检查results.json和两张实际截图，两个真实普通DSH主题空间嵌入、草稿输入和入口救援层可见。入口和管理进程仍为实验Node脚手架；不得将该PASS算作正式专用DSH管理profile自维护的验收。后续产品分发必须重新实测。

## 监督与维护集成反例

实际分发根验收新增发现并修正：监督CLI输出双shebang（node --check门禁）；稳定入口内联脚本缺右括号（新增脚本直接解析测试）；DSH rc1在Windows用shell转发pnpm导致空格路径拆参（限定owned archive用带引号的profile相对file spec）；无窗口Node不能用taskkill无/F正常退出（私有IPC调用DSH已注册SIGTERM清理，真实manager退出成功）；监督parseId拒绝合法@scope/name（插件标识单独校验）。

正式A基础实际Chromium截图与results通过，但完整维护/主题/桌面矩阵尚未完成。普通DSH初次启动必须建立并选择空工作区后才能输入草稿，测试不配置真实模型。

Codex独立运行维护15项原测试全部通过，但额外注入snapshots.pendingRestore读取失败，recover返回consistent=true及settleInterruptedJobs=true；错误被当作没有待恢复日志。反例脚本/结果在.sandbox/workbench-maintenance-root-repro.ts。

Codex为监督模块补两个ROOT测试并实际运行：初始化后manager状态仍stopped；子进程停止失败时close不拒绝且释放流程继续。见.sandbox/workbench-supervisor-root-repro.log。代码同时存在stopOwnedAll吞force-kill失败、静态入口不跟随manager状态切换、CLI未默认组合维护模块等整合缺口。监督及维护分别交唯一聚焦审计重试；未通过A批产品验收。

维护重试后Codex再次运行原反例，现为recover失败且consistent=false/settleInterruptedJobs=false；23项维护测试通过。仍需真实打包/事务恢复整合。桌面新增两个ROOT反例都失败：损坏manager身份、未完成Web任务都可绕过server-side写门。已交桌面唯一审计修正。插件引导另交唯一整合修正（缺失artifact参数、新浏览器Cookie引导、桥真实DOM/连接就绪）。
