# DSH Spaces：Let it crash 全项目修订与迁移计划

日期：2026-09-15  
仓库：`klarkxy/dsh-spaces`  
核查基线：`main@c89dc05b364ca2ee4bb803a321c403e8a04cd9c0`  
交付性质：执行计划。本文不代表文档已提交、代码已迁移或测试已通过。

## 0. 范围与完成状态

用户明确要求：所有文档、计划、任务等统一声明核心思想为 **let it crash**。插件自由组合，失败正常；Spaces 只报告错误原因，不帮助用户恢复，不尝试抢救。

本计划区分两个交付：

- **D：文档与任务修订。** 这是原始请求的直接范围：统一有效契约，撤销冲突任务，保留历史事实，登记后续代码差距。
- **R：运行时代码迁移。** 作为后续可执行任务列出，不因完成 D 就宣称 R 已完成。本轮交付计划，不执行远端写入、发版或用户 Home 操作。

已核对根说明、核心工作台契约、最新插件计划、任务清单、Doctor、Supervisor、共享接口、测试入口及关键历史记录。附录按已发现路径列出覆盖清单；执行者仍必须用实际 checkout 的受控文件清单完成逐项审计，不能把关键词无命中当作全文已审核。

## 1. 唯一产品原则

建议建立唯一原则文件 `docs/let-it-crash.md`，其他有效文档引用它，不再各自维护不同版本的恢复政策。

### 1.1 可直接采用的正文

> **核心思想：let it crash。**
>
> 插件由用户自由选择和组合，插件错误、依赖冲突、配置不兼容、启动失败和进程崩溃都是允许出现的结果。DSH Spaces 不承诺任意插件组合都能正常运行，也不负责把失败的环境修复成可运行状态。
>
> 出错时，让失败的操作、插件或进程按照其原有执行边界失败或退出。Spaces 负责如实记录失败，并在仍可用的界面或本地输出中说明发生了什么、已知原因是什么。无法确定根因或具体插件时明确说明未知，不猜测。
>
> Spaces 不提供故障后的自动或手动恢复流程：不重试失败操作、不自动重启或重新连接失败组件、不回滚、不恢复快照、不重装依赖、不自动修改配置或禁用插件、不切换版本或实现、不进入安全模式或救援模式、不续跑中断任务。错误页不提供修复向导或恢复建议。
>
> 正常的用户主动启动、停止、重启、安装、卸载和配置操作仍是独立操作。它们不构成恢复承诺，不由错误处理器代替用户发起，也不能包装成“检查并修复”“恢复中断任务”等入口。
>
> 安全边界、数据隔离、输入和路径校验、单写者约束、原子文件写入及必要的资源释放继续有效。校验失败就拒绝并说明原因，不自动纠正。允许崩溃不等于允许越权、泄露凭据、伪造成功或扩大故障影响。
>
> 本原则适用于桌面端、Web、插件 Host、Supervisor、Doctor、插件管理、导入导出、批量任务、运行时升级、管理器自升级，以及相关文档、任务和验收标准。既有恢复实现属于待移除差距，不是例外，也不是“本轮暂不做、以后继续”的默认路线。

### 1.2 不引入额外的恢复架构

这里采用用户指定的含义，不借用其他体系中的 supervisor 自动拉起、重启树或自愈机制。不得以实现 let it crash 为理由，再搭建一套负责让组件重新活过来的系统。

也不强制放大失败：一个插件记录错误但宿主仍正常运行时，不人为杀掉整个进程；一个空间退出时，不连带关闭其他健康空间。自然故障边界可能是操作、插件、空间进程或管理进程，Spaces 不承诺重构上游插件的内部异常策略。

## 2. 保留与删除的准确边界

| 事项 | 目标处理 | 禁止的变体 |
|---|---|---|
| 异常捕获 | 在必要边界补充上下文、脱敏、报告，再抛出或返回真实失败；致命顶层异常报告后退出 | catch 后返回空配置、默认成功或继续执行依赖步骤 |
| 错误定位 | 保留可确认的空间、包、阶段、退出码、信号和原始错误摘要 | 从“最后安装的插件”推断罪魁祸首；凭空给出根因 |
| 本地日志 | 有限长度、脱敏，不自动上传；日志失败不能覆盖原始业务错误 | 为保证日志落盘构建重试、自愈或不退出机制 |
| 生命周期 | 正常用户指令执行一次；观察退出；只管理已确认归属的进程 | 崩溃重启、失败重连、自动启动替代管理器、误杀外部进程 |
| 用户主动重启 | 独立的新命令、新任务；使用用户当前选择的配置 | 错误页“一键修复”在背后回滚、换版本、禁用插件或重装 |
| 浏览器刷新 | 重新读取仍在执行的任务状态，不重发变更 | 后端已中断时自动重放任务；轮询触发接管或重启 |
| 安全与隔离 | 保留认证、Origin/source/generation 校验、单写者、隔离 root 和路径限制 | 把任意第三方组合兼容性审查扩展成永久版本白名单或通用依赖求解器 |
| 原子写入 | 未提交的临时文件不替换原文件；执行前必要验证 | 已提交失败后再写回旧文件、跨目录补偿或环境对账 |
| `finally` 清理 | 有界释放本次持有的句柄、锁及能证明归属的未发布临时资源 | 扫描并修复旧环境、删除用户数据、恢复旧版本、清除归属不明的锁 |
| 失败现场 | 记录已完成步骤、可能的部分副作用；不额外修补磁盘 | 宣称失败意味着完全没有改动；为了“干净”覆盖现场 |
| 旧快照和备份 | 不再承诺恢复、不再创建恢复链；已有用户资产不因迁移被删除 | 删除用户旧备份以证明功能已移除；保留隐藏恢复执行入口 |
| 导入导出 | 用户主动创建新空间的分享能力，不含故障状态恢复 | 覆盖损坏空间、失败后还原旧空间、把导入当作灾难恢复 |
| 批量操作 | 首项失败即终止本批剩余执行；已成功项保留 | 回滚成功项、自动跳过失败后继续、失败项重试、原批次中断续跑 |
| 默认值 | 缺少可选输入时使用明确的正常默认值 | 操作失败后悄悄切到另一来源、CLI、版本、主题或实现 |
| 历史记录 | 保留实际做过的事、当时结果和证据 | 改写旧测试通过数；把“历史代码恢复”当作产品恢复功能整体删除 |

安装命令内部的包管理器行为、第三方插件自己的行为和操作系统行为，不在“Spaces 从不触发恢复操作”的可控承诺之外被一并保证。验收测量 Spaces 自己发起的调用和它控制的路径，不伪造对任意第三方代码的安全或零副作用保证。

## 3. 当前已确认的冲突

| 位置 | 当前问题 | 必须落地的修订 |
|---|---|---|
| `README.md` | 中英文定位仍包含恢复核心、可恢复快照、恢复前置门禁 | 改为隔离、生命周期与错误报告；恢复能力列为移除目标或历史能力，不继续推广 |
| `docs/workbench.md` | 救援页、检查并恢复、恢复中断任务、配置恢复、整 Home 恢复、Doctor 恢复命令 | 删除有效用户教程和功能承诺；以失败展示与日志查看取代，不伪装实现已删 |
| `tasks/plugin-management/plan.md` | 普通插件不自动恢复，但整 Home 恢复仍保留；失败项可重试、剩余项可继续 | 从局部约束升级为全局约束；取消整 Home 恢复例外与旧任务续跑 |
| `tasks/todo.md` | 新段落已取消部分插件恢复，但旧未完成回滚矩阵仍挂起 | 标记恢复类待办已撤销，保留仍有效的安装、错误报告、导入导出与安全测试 |
| `tasks/workbench-contract.md` | 稳定入口包含恢复页，任务包含中断恢复标记与恢复合同 | 去除恢复命令、状态和工作流；保留安全通信、幂等与操作预览 |
| `tasks/workbench-jobs-worker.md` | `recovery-required`、全局 hold、`settleRecovery` 和 `recovery.resume` | 改为终态失败/中断记录；不要求恢复后才能继续，不重放旧命令 |
| `packages/doctor/README.md` | 同时提供诊断、unlock、recover、rollback | 只保留只读诊断与非变更验证的目标；移除恢复、解锁建议和操作入口 |
| `packages/supervisor/README.md` | 管理器停止后保证救援页、检查并恢复 | 独立控制服务可保留，但不负责复活或修补；仍在线时只报告真实故障 |
| `src/shared/workbench.ts` | 实际接口含 `recoveryRequired`、恢复状态、快照/配置恢复等命令 | 登记并实施公开接口、客户端、服务端、持久化读法的同步迁移 |
| `package.json`、`.github/workflows/ci.yml` | 恢复测试是现有测试/CI 入口的一部分 | 替换其断言，保留里面独立的安全、响应性、隔离与兼容测试，不整组盲删 |

补充：2026-09-14 交接文件已要求取消永久精确版本白名单。保持这个决策，不因本次改造重新收紧为“未知插件/版本一律禁止”。旧 rc.1/rc.2 是验收证据，不自动证明其他版本兼容，也不自动成为永久运行门禁。

## 4. 文档修改方法

### 4.1 原则文件和开发入口

新增 `docs/let-it-crash.md`，采用第 1 节简短正文和第 2 节必要边界。若仓库没有 `AGENTS.md`，可新增不超过一页的开发入口；若已有则修改现有文件，不再增设平行规则文件。

建议 `AGENTS.md` 核心内容：

```markdown
# Project rules

Read docs/let-it-crash.md and tasks/todo.md before planning or editing.

DSH Spaces follows let it crash: report the actual failure, do not recover it.
Do not add automatic retries, restarts, rollback, restore, repair, fallback,
or interrupted-job replay. Do not add manual recovery workflows either.
Keep authentication, isolation, single-writer constraints and atomic writes.
Historical recovery plans and tests are not current requirements.
Documentation completion is not runtime migration completion.
```

`CONTRIBUTING.md` 引用同一原则。不要把现有安全规则全部删掉，也不要建立更复杂的 ADR/策略框架来维护一条原则。

### 4.2 根文档

**`README.md`**：同时更新中文和英文。定位去掉恢复核心；删除当前用户向的恢复教程、恢复前置门禁和恢复能力宣传。增加错误示例与“不承诺任意组合正常运行”。迁移未完成时，用明确的“目标政策 / 已知实现差距”提示说明旧恢复代码仍存在；不能直接写成产品已经不执行恢复。

**`REQUIREMENTS.md`**：新增核心原则或最高优先级条款；FR2 将崩溃处理定义为状态与错误原因，普通重启保留在常规生命周期中而非恢复承诺；撤销恢复、自动修补、升级回退等有效要求；保留 FR/NFR 中真实的隔离、输入安全、串行写、原子写与隐私。原始实测段落保留日期，不重写为本轮验收。

**`IMPLEMENTATION_PLAN.md`**：早期实施记录保留，但顶部有效范围去掉快照恢复；“健壮性/崩溃恢复”改为错误传播与可观测失败；阶段完成判据不再要求抢救成功。旧时间线中已完成的恢复实现标注已被新政策取代。

**`TODO.md`**：与 `tasks/todo.md` 明确主从关系。建议后者是唯一活动任务账本，根 TODO 作为导航和历史摘要，不继续维护相互矛盾的未完成列表。

### 4.3 工作台及包文档

`docs/workbench.md`、`docs/plugin-standard-install.md`、`packages/*/README.md` 全部检查中英文正文、命令例子、状态名称、启动参数、诊断说明和相关链接。

- 工作台错误页只显示状态、错误详情和本地日志入口；不显示“救援入口”“需要恢复”“检查并恢复”“恢复中断工作”。
- Supervisor 不保证管理器出错后自动补齐安装、重建身份或拉起管理器；冷启动只由正常用户启动/初始化请求触发。
- Doctor 目标职责仅为诊断。任何看似只读的 verify 也要检查是否启动代码、写文件或触发上游副作用；不得无证据称其绝对只读。
- `--snapshot-worker`、`--snapshot-root` 等参数在代码移除之前不得从仍需运行的当前启动示例中直接删掉。文档阶段注明旧依赖及待迁移；实现完成后同步删除旧参数、示例、打包配置与资源要求。
- 入口仍然在线时可以显示故障；入口进程本身崩溃时依赖 stderr/启动器/现有日志，不另建看门狗保证展示页面。

### 4.4 历史、计划、派工和验收的分层

每份受控文档登记一种处理方式：

- **有效契约：** 直接改正文、状态、流程、任务依赖和验收标准，不能只在顶部贴免责声明。
- **混合文档：** 当前计划与历史记录分节；重写有效部分，历史部分保留事实。
- **历史报告：** 顶部增加“历史证据，恢复要求自 2026-09-15 起已被取代”；保留原始操作和实际结果。文内“仍待完成”的恢复要求标已撤销。
- **原始证据：** 原日志、截图、JSON 测试结果、许可证与来源材料不重写、不伪造；通过索引说明不再作为现行恢复验收要求。

建议历史声明：

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求已由 2026-09-15 的 `docs/let-it-crash.md` 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。

撤销任务使用明确文字，例如：

`整 Home 回滚最终矩阵：已撤销（2026-09-15，改验故障终止、错误可见、无恢复副作用）。`

不要把“取消”勾成“已完成”；不要把已完成历史改成“从未存在”。

## 5. 最新插件计划的逐任务修订

针对 `tasks/plugin-management/plan.md`、`task-01-write-scope.md`、`tasks/plan.md`、`tasks/todo.md`：

| 原编号 | 处置 | 修订后的交付定义 |
|---|---|---|
| 01 | 保留历史测量，不继续建设恢复模块 | 保留安装/卸载真实写入范围、共享依赖和版本证据；恢复试验只是历史，不再写成将来恢复功能的默认前置 |
| 02 | 保留 | 状态准确、精确版本下载、多版本制品缓存、错误归属；没有读到实际版本就显示未知，不用 latest 冒充 |
| 03 | 扩大适用范围并收紧边界 | 桌面/Web 的安装、启动、崩溃、卸载失败可见；无自动或手动恢复入口；插件归属不明时明确未知 |
| 原 03/04/05/06 恢复线 | 已撤销而非延期 | 安装恢复点、自动回滚、重启/Doctor 恢复、撤销入口都不得重新接线 |
| 07 | 保留 | 导出组成、顺序、版本和可选配置；不导出凭据、聊天、运行进程状态，不变成整 Home 灾难恢复 |
| 08 | 修改 | 导入定义/安装结果与运行结果分开。格式、路径和对象校验通过后可发布新空间；不能要求所有自由组合启动成功才允许空间存在。后续启动失败显示崩溃，不撤销空间 |
| 09 | 保留并补充失败往返 | 成功包可以往返；合法但运行不兼容的组合可导入并在启动时明确报错，不被“修好”后才算成功 |
| 10 | 修改 | A 成功、B 失败时 A 保留、B 失败、C 未执行，本批终止。删除失败项重试、原任务继续和中断续接。用户另选目标产生新请求，不复活旧任务 |
| 11 | 保留并收紧 | 模板是新空间的创建输入，不自动改已有空间；模板导致运行失败正常报错，不自动换模板或依赖 |

导入的暂存清理只适用于本次能证明归属、尚未发布的临时资源。已发布空间、已有环境或无法证明归属的遗留目录不自动删除。进程被杀后不启动“自动清理并完成导入”的重放流程。需要减少设计时宁可保留临时残留并报错，不建设跨重启恢复/清理服务。

## 6. 后续运行时代码迁移任务

以下是应写进新活动任务账本的实现任务，不是本次已经完成的改动。先核对调用关系再删文件，不能只按名字删除。

### R1：错误合同和真实失败传播

主要入口：`src/shared/workbench.ts`、`src/shared/spaces-control.ts`、`src/shared/types.ts`、`src/main/diagnostics.ts`，以及调用这些类型的 Node、IPC、HTTP、Remote 与 UI 适配。

沿用已有错误结构，按需增加少量可选上下文，不搭建新的错误框架。最低可用字段为机器可读 `code`、可读 `message`，以及已知的空间/包/阶段/退出信息。底层原因经过脱敏和长度限制后保留；浏览器不收磁盘路径、凭据或原始启动 token。

不得增加 `recoveryPlan`、`suggestedFix`、`autoRetry` 等指导恢复字段。不能继续把所有未知异常压成只剩 `workbench/failed` 而没有可解释原因；确实未知时提供可确认的症状和脱敏日志摘要。

**完成判据：** 真正失败不会变成功；错误链可追踪；无法归属时不捏造；界面和复制内容不泄漏秘密；诊断失败不掩盖原始故障。

### R2：任务失败终态，取消恢复状态机

主要入口：`src/adapters/node/workbench-jobs.ts`、`src/shared/workbench.ts`、任务执行接线与 `tests/workbench-jobs.test.ts`。

正常状态足够简单：

```text
queued -> running -> succeeded | failed | cancelled
```

删除恢复用途的 `recovery-required`、`recovery.resume`、`settleRecovery` 和恢复 hold。进程重启后，对于可读取且确认属于前次执行的非终态记录，展示中断失败，保留原阶段，并注明执行结果/部分副作用可能不确定；不重放命令，不对账修补环境，也不冒称此前必定没成功。

损坏 JSON 或未知 schema 只报告无法读取，保留原字节；不重建默认数据伪装为空。若无法安全维持任务幂等或锁边界，可拒绝相关写操作并说明缺失证据，但不存在“必须恢复成功才解锁”的产品流程。

同 requestId 幂等读取仍保留；重复查询、刷新和重复提交同 ID 不产生新执行。新的正常用户操作是新请求，不能借新 ID 自动重试失败操作。取消只影响未开始/明确可停止的执行，不撤销已经发生的副作用。

**完成判据：** 重开和刷新不会 spawn、安装、恢复、补偿或重放旧任务；旧任务终态不会因后续新任务成功而被改写。

### R3：收缩 Supervisor 和生命周期

主要入口：`src/adapters/node/workbench-supervisor.ts`、`workbench-runtime.ts`（若 checkout 中存在）、`workbench-http.ts`、`workbench-views.ts`、`home-controller.ts`、`src/main/process-manager.ts`、`packages/supervisor/src/**`、`packages/plugin/src/host/supervisor-bootstrap.ts`。

保留现有控制服务的正常用途：本机绑定、认证、单写者、用户指令、真实状态查询、生命周期管理。去掉错误触发的管理器重建、补装、重启、重连、自动恢复运行权和救援工作流。

正常初始化尚未完成就失败：终止该次请求，报告缺失步骤，不在下次打开页面时偷偷完成。锁所有者活跃或身份不明：报告，不强行清锁或杀进程。正常进程退出带来的 OS 资源释放不属于恢复；不得为旧锁单独保留一个 Doctor 解锁产品入口。

致命控制服务异常可输出后退出。健康的独立服务无需被故意连带杀死，也不为了展示错误新建第二个永久进程。

**完成判据：** 故障后的进程创建/启动计数不增加；普通用户主动启动仍可执行；未拥有的进程不被控制。

### R4：删除恢复业务链，不把旧功能藏起来

主要入口：`src/adapters/node/workbench-maintenance.ts`、`workbench-maintenance-ports.ts`、`src/main/coordinated-upgrade.ts`、`snapshot-store.ts`、`snapshot-executor.ts`、`snapshot-worker.ts`、`restore-session.ts`、`plugin-restore-point.ts`、`runtime-store.ts` 和实际关联的 core 服务。

需要取消：配置恢复、安装恢复点、故障后快照恢复、整 Home 回滚、依赖环境拷回、journal 对账恢复、管理器/运行时升级失败的自动回退和后台续接。

公开入口中的 `recovery.resume`、`snapshot.restore`、`config.restore`、专用修复/误装修复入口、恢复用快照管理面，应随服务端实现、调用者和文案一起移除。普通插件卸载与普通配置编辑可以继续存在，但不能由故障处理器调用或伪装为清理修复按钮。

升级可以保留用户主动选择、解析并固定版本、准备候选、最小验证、原子切换指针等正常安装步骤。提交前候选失败不切换指针是没有提交，不是回滚；提交后出错不再切回旧环境。不承诺对跨目录多步修改提供全成功或全撤销事务。

注意 `snapshot-worker` 已被文档用于 runtime install 和耗时 IO。删除恢复分支前先保留或提取仍有效的非恢复执行能力，不能删掉 worker 导致正常安装、打包或响应性失效。若命名已不准确再做必要重命名，不另造一套通用执行平台。

**完成判据：** 恢复链无生产调用入口；正常安装/升级不会因缺少已删除参数而坏掉；失败副作用如实报告；旧用户备份不被迁移清理掉。

### R5：Doctor 只做诊断

主要入口：`packages/doctor/src/index.ts`、`inspect.ts`、`resources.ts`、`recover.ts`、`common.ts`、对应 README 和 `tests/spaces-doctor.test.ts`、`tests/workbench-doctor.test.ts`。

保留能证明不改写 Home、不启动服务的只读检查。移除 `recover`、`rollback`、`unlock` 的用户入口和执行链；资源解析不得在检查时更新 runtime 指针、清旧锁、改 job 或对账 journal。

旧命令调用应明确返回不支持和非零退出，不静默忽略，不转译为新名称的恢复操作，也不输出一套手动恢复教程。旧数据格式只作为诊断输入读取；不可读就说明不可读。

**完成判据：** 对正常、损坏、未知 schema、运行时缺失、锁冲突等隔离 Home，执行前后受保护数据和配置字节不变；观察不到启动服务、安装包、删除锁或写回指针的行为。

### R6：桌面、Web、CLI 与发布资源同步

主要入口：`packages/plugin/src/workbench/**`、`packages/plugin/src/client/**`、`packages/plugin/src/host/**`、`src/renderer/**`、`src/preload/**`、`src/main/**` 中的 IPC/错误展示、相关 i18n、`scripts/build-spaces.mjs`、`package.json`、打包 manifest 和工作流。

移除恢复按钮、恢复模态框、恢复状态 badge、旧恢复 handler、死路由、导出的恢复类型与导出入口、仅为恢复保留的依赖和资源。旧页面客户端访问已移除 API 必须获得明确失败，不返回虚假成功。查找中文和英文版本，避免只改一个语言。

错误页只提供错误详情与本地日志的查看/复制；正常生命周期操作保留在常规管理区，不打包成推荐的救援步骤。启动失败不能继续显示运行中；保留上一个健康视图时必须同时标明本次切换失败，不能造成成功错觉。

构建、脚本名和文档示例同步，不隐藏已经不再使用的恢复代码。此类变化属于行为/接口移除，发布说明应在真正发布时明确说明，不能沿用旧恢复承诺。

**完成判据：** 两端与 CLI 同一失败语义；无隐藏恢复入口；构建不再依赖已删除资源；无死导出或死配置。

## 7. 错误提示规范

示例仅描述预期格式，不是对现有产品错误的实测结论。

```text
空间 coding 启动失败

阶段：加载插件
插件：example-plugin@1.2.3
原因：缺少服务 example.database
退出码：1

该次启动已失败。查看错误详情 / 复制脱敏日志
```

不能确定根因时：

```text
空间 coding 的进程已退出

观察到：进程收到 SIGKILL
根因：无法从现有输出确定
插件归属：未能归属到单个插件
```

不出现“已自动修复”“建议重新安装”“正在恢复”“检查并恢复”“回滚后重试”。日志中出现 SIGKILL 只能说明观察到信号，不能据此断言是哪个插件或谁杀了进程。

错误必须说明可能已发生的部分修改。没有记录完成并不证明命令没有生效；不通过偷偷读回并修复来制造确定性。

## 8. 验收矩阵

每个用例需要同时验证：**失败真实可见、根因/未知说明准确、没有恢复动作、正常安全边界不退化**。

| ID | 注入/场景 | 应有结果 | 必查的禁止行为 |
|---|---|---|---|
| E01 | 插件安装 CLI 非零退出 | 本次安装任务失败，显示包、阶段、退出信息与已知副作用 | 不重试、不换源/版本、不恢复环境、不启动空间 |
| E02 | 已安装插件在启动时抛错 | 空间启动失败/崩溃，显示实际错误 | 无重启、无自动卸载、无替代插件 |
| E03 | 运行中的插件抛错且宿主退出 | 退出被观察，状态正确 | spawn 次数不因故障增加，不停启其他空间救援 |
| E04 | 插件报错但宿主未退出 | 展示插件错误，真实进程状态保留 | 不人为制造整个宿主崩溃，不误报进程已死 |
| E05 | readiness/运行操作超时 | 有界结束并报错；只清理已确认归属的本次活动资源 | 不延长超时直至“成功”，不换端口/版本自动重跑 |
| E06 | 在变更中 kill 执行进程并重新打开 | 原任务显示中断失败或无法确认，保留证据 | 无 journal 对账、无任务重放、无补偿写入 |
| E07 | 任务执行期间仅刷新浏览器 | 读取同一个仍在运行的任务 | 不重复执行变更，不新建同业务命令 |
| E08 | A 成功、B 失败、C 待执行 | A 保留，B 失败，C 未执行，本批失败终止 | 无 A 回滚、B 重试或自动继续 C |
| E09 | 管理 profile 崩溃 | 已在线入口显示故障；入口也死则有现成 stderr/日志 | 不补装管理器、不新建救援进程、不自动拉起 |
| E10 | 升级在提交前/提交后分别失败 | 前者不提交，后者保留真实失败现场与可能部分改变 | 不把提交前保留旧指针误称回滚；提交后不切回 |
| E11 | job/配置损坏或未来 schema | 明确不能读取；原字节保留 | 不设默认配置冒充成功，不清空记录，不启用恢复模式 |
| E12 | 活锁、未知所有者或外部进程 | 拒绝相关控制并说明原因 | 不解锁、不接管、不杀无法证明归属的 PID |
| E13 | 错误包含 token、cookie、凭据或聊天内容 | UI、复制及本地日志遵守既有隐私边界 | 不为展示原始原因而泄密，不只留无意义通用错误 |
| E14 | 合法的导入定义含不兼容插件 | 定义导入/安装/启动结果分开；运行失败正确展示 | 不要求自动修复后才接受空间，不回滚已发布空间 |
| E15 | 请求已移除的恢复 API/CLI | 明确失败，保持调用格式的错误语义，CLI 非零退出 | 不转发到隐藏旧实现，不把未知命令当成功 |
| E16 | Doctor 读取旧恢复痕迹 | 只读呈现可确认信息 | 不清锁、不改指针、不改 job、不删除旧备份 |
| E17 | 原有隔离、Origin 校验、路径穿越、并发写测试 | 仍按原安全意图通过 | 不以减少防御为由移除安全约束 |
| E18 | 普通启动/停止/卸载/新导入和正常构建 | 正常功能仍可用，每次只执行该指令 | 不因为删除共享 worker/类型而破坏非恢复能力 |

### 8.1 测试方法要求

故障测试必须调用生产入口或真实组合，不能重写一份“不会恢复的测试实现”自证通过。至少有真实一次性 Home 的进程故障和浏览器错误显示证据。

观察 `spawn`、安装命令、restore/recover 调用、runtime 指针写入、控制权操作和目标路径变化。区分原操作自身的部分写入、允许的错误记录、明确归属的临时资源释放，以及故障后新增的救援写入。不能笼统断言“失败后整个 Home 字节完全不变”。

测跨空间影响时冻结不相关空间的后台写入或使用独立观测点；不要把健康空间自己持续写日志误判为故障恢复。第三方安装本来涉及的共享依赖写入需要结合任务 01 的证据解释，不把会话隔离夸大为插件文件系统沙箱。

旧测试中混合的 Origin/凭据/未知 schema/进程归属/响应性断言要保留。只取消“恢复成功是通过条件”，不通过删测试、改成空断言或无条件 skip 获得绿灯。

所有运行测试使用新建的一次性 Home，不读写真实 `~/.dsh`，不调用真实模型。平台没有实测就明确未验证，不能用 Windows 或编译成功代替 macOS/Linux 运行证据。

## 9. 实施顺序与拆分

| 顺序 | 任务 | 前置 | 完成判据 |
|---|---|---|---|
| D0 | 固定 checkout 基线，列出受控文档、任务、脚本和公开接口 | 无 | 每个文档有有效/混合/历史/原证据分类；记录新增或差异文件 |
| D1 | 建立原则文件并统一 README/需求/开发说明 | D0 | 中英文相同政策；无恢复例外；安全边界明确 |
| D2 | 修改所有有效计划、派工、验收和活动任务 | D1 | 恢复任务明确撤销；历史事实保留；最新插件计划不再续跑 |
| D3 | 完成文档差距登记和独立文档验收 | D2 | 逐文件覆盖记录、旧条款到新条款的映射；未实施代码单列 |
| R1/R2 | 最小错误合同、任务失败终态 | D3 | 类型和状态机一致；无恢复命令/重放入口 |
| R3/R4/R5 | 控制服务、变更执行、Doctor 去恢复 | R1/R2 | 真实错误传播；恢复业务链无生产调用；正常非恢复能力保留 |
| R6 | 桌面/Web/CLI/本地化/构建资源同步 | 公共合同稳定 | 无 UI/API 悬空调用，无旧救援文案 |
| Q1 | 测试断言、故障矩阵和真实集成验收 | 实现迁移完成 | E01–E18 有证据；安全与正常功能回归不退化 |
| D4 | 根据实际运行状态最终校正文档和交付清单 | Q1 | 才能声明运行时迁移完成；仍失败/未验证项如实列出 |

当前优先完成 D，不让新的插件功能绕过原则修订继续扩展恢复模块。版本选择、导入导出等独立功能不要顺手全部重写。

一个整合者负责共享合同、根任务表和合并；文档、Node 和 UI 可按文件互斥分工。独立验收只按真实结果报告，不借改待测产品代码或放宽测试来满足预设结论。不继承历史批次的 agent 名称、Git/发布授权或完成状态。

## 10. 执行前审计与验证命令

以下命令是给执行环境使用的清单，本计划交付时未运行仓库测试。

```bash
# 记录真实 checkout，不覆盖未提交工作
git status --short
git rev-parse HEAD

# 受控文档清单，含根目录和嵌套目录
git ls-files -- '*.md' '*.mdx' '*.rst' '*.txt'

# 查找恢复语义候选，再逐处人工分类
git grep -n -I -i -E \
  'recover|restore|rollback|rescue|repair|retry|reconnect|self.?heal|fallback|safe.?mode|恢复|回滚|救援|修复|重试|续跑|续接|兜底|降级|自愈' \
  -- '*.md' '*.mdx' '*.rst' '*.txt'

# 查找跨语言公开恢复入口和状态
git grep -n -I -E \
  'recovery-required|recoveryRequired|recovery\.resume|settleRecovery|snapshot\.restore|config\.restore|recover\(|rollback\(|unlockDead|reclaimDead' \
  -- src packages tests scripts .github package.json

# 收尾检查
git diff --check
git diff --stat
```

`git grep` 没有匹配时退出码 1 是正常的查询结果；真正执行错误不能用无条件忽略掩盖。关键词扫描只是候选定位，不可机械将所有 restore/recover 替换掉。正常恢复窗口显示、Git 历史代码恢复、历史故障证据、原子准备阶段都要按语义处理。

代码迁移后的已有验证入口：

```bash
npm ci
npm run typecheck
npm run typecheck:spaces
npm test
npm run test:spaces
npm run test:workbench
npm run test:workbench:browser
npm run build
npm run build:spaces
npm run validate:isolation
npm run validate:lifecycle
npm run validate:a8
```

这些运行验证先确认使用的是一次性 Home、所需测试 CLI 已准备且没有与正在运行的应用共享沙箱。现有 `test:workbench:recovery` 应在重组断言后改成准确的失败路径测试入口，例如拟新增 `test:workbench:failures`；这个新名字目前只是提议，不能当成现成脚本执行。故障脚本也应改验 E01–E18，不照跑旧的成功回滚验收然后宣称新原则通过。

Markdown 链接、标题锚点和当前用户命令需独立检查。纯文档提交不需要伪造一轮运行测试，通过状态只写实际执行范围。

## 11. 交付物与最终完成定义

### 文档交付 D

1. 核心原则文件及所有有效入口的引用。
2. 逐文件修订清单，含无需改动的证据性文件及原因。
3. 恢复类任务撤销清单，新的错误报告/无恢复验收任务清单。
4. 历史记录状态标注，保留原始证据和真实完成记录。
5. 未迁移运行时接口、调用链、UI、测试和构建依赖的清晰任务表。
6. 实际做过的文档检查结果、未覆盖项和提交/推送状态。

### 运行时交付 R

只有恢复入口、执行链、错误状态机、UI、CLI、打包资源和测试都完成同步，并有真实故障验证，才可写“运行时已符合 let it crash”。

不要求旧恢复字样在整个 Git 历史或所有证据中消失；要求所有有效需求不再要求抢救，所有生产可达路径不再帮助恢复，所有失败都不被伪装成成功。

最终报告分别写：D 已完成/未完成，R 已完成/未完成，测试范围，平台范围，本地修改/提交/推送/发布状态。不推送成功就不写已推送；没有改代码就不写恢复机制已移除。

## 12. 可直接交给执行 Agent 的任务描述

> 请基于当前 `klarkxy/dsh-spaces` 工作树实施本计划的文档交付 D。先记录 Git 状态与基线，不覆盖用户改动。完整列出根目录、docs、packages、tasks 及文档性分发材料，按有效契约、混合记录、历史报告、原始证据分类。
>
> 项目最高原则是用户指定的 let it crash：插件自由组合，失败允许发生；只反馈可确认的错误，不提供自动或手动恢复，不重试、重启、回滚、恢复快照、重装、修补配置、降级、切替代实现或续跑中断任务。正常用户独立发起的操作、安全与隔离检查、原子写入、必要资源释放保留。
>
> 不能只增加原则段落。必须修改冲突的有效正文、流程图/状态说明、接口目标、任务依赖和验收条件；撤销恢复类活动任务，特别取消最新插件计划中的整 Home 恢复例外、失败重试和中断续接。历史实现与测量保留事实，并明确不再作为现行恢复要求。
>
> 将运行时代码中仍存在的恢复接口、job 状态、Doctor 命令、救援 UI、升级回退及测试断言按 R1–R6 登记为未完成，不在本次文档阶段冒称已删除。不要顺手扩大到新的产品功能，不沿用旧批次的发版授权。
>
> 交付逐文件变更、撤销任务、实施差距、实际检查证据和未覆盖项。不能推送则交付本地 diff/patch 和结果，不声称远端已修改。所有真实运行验证仅用一次性 Home。

---

# 附录 A：按文件/文件组的覆盖与修订清单

本表给出已发现文档路径的派工落点。具体历史报告不全部改写正文；是否仍有有效待办由 D0 全文复核。路径集合随实际 checkout 扩充，不依据旧文件名臆造存在的文件。

| 文件或文件组 | 处理方式 | 核心改动/核查点 |
|---|---|---|
| `README.md` | 重写有效正文 | 中英文定位、恢复宣传、版本描述冲突、当前状态与目标状态 |
| `REQUIREMENTS.md` | 混合修订 | 核心原则、FR2、相关 NFR、恢复类需求撤销；实测保留 |
| `IMPLEMENTATION_PLAN.md` | 混合修订 | 当前追加范围、健壮性/恢复阶段、验收定义；早期记录保留 |
| `TODO.md` | 活动项修订 | 与 tasks/todo.md 主从一致，取消恢复类待办 |
| `CONTRIBUTING.md` | 有效约束 | 引用原则，错误边界和审查要求，保留安全规则 |
| 拟新增 `docs/let-it-crash.md` | 唯一原则 | 第 1 节正文与必要边界 |
| `AGENTS.md`（有则改，无则拟新增） | 开发入口 | 简短引用，不另造重复政策 |
| `docs/workbench.md` | 重写有效正文 | 双语救援页、维护、快照、Doctor、命令示例 |
| `docs/plugin-standard-install.md` | 有效教程核查 | 初始化失败终止，不自动补装/续接；正常安装保留 |
| `packages/core/README.md` | 包说明核查 | 不再定义恢复核心；当前/目标能力区分 |
| `packages/plugin/README.md` | 包说明修订 | 管理器、普通空间角色、故障提示、去恢复入口 |
| `packages/doctor/README.md` | 重写目标职责 | 只读诊断，恢复/解锁命令与推荐流程退场 |
| `packages/supervisor/README.md` | 重写目标职责 | 去救援、自愈和错误触发拉起；共享 worker 依赖如实描述 |
| `packages/view-bridge` 下实际存在的文档 | 范围核查 | 桥失败/失联只展示，独立 origin 安全保留 |
| `tasks/plan.md` | 混合修订 | 当前入口指向新原则，旧恢复计划不再有效 |
| `tasks/todo.md` | 唯一活动账本 | D 与 R 分开；取消回滚矩阵，不勾成完成 |
| `tasks/plugin-management/plan.md` | 逐任务修改 | 本文第 5 节全部要求 |
| `tasks/plugin-management/task-01-write-scope.md` | 历史证据 | 写入范围测量保留，不为恢复功能留默认复活入口 |
| `tasks/workbench-contract.md` | 有效合同修订 | 恢复命令/状态/流程退场，安全与幂等保留 |
| `tasks/workbench-implementation.md` | 混合修订 | 顶部固定需求及当前未完成项更新；时间线保留 |
| `tasks/workbench-supervisor-worker.md` | 派工/历史分层 | 不再建设管理器复活、救援与自动接管 |
| `tasks/workbench-controller-worker.md` | 派工/历史分层 | 单写者与身份校验保留，错误恢复和清锁要求撤销 |
| `tasks/workbench-jobs-worker.md` | 合同和待办修改 | 终态失败，移除 hold/settleRecovery/resume 目标 |
| `tasks/workbench-maintenance-worker.md` | 派工/历史分层 | 快照/配置恢复/回滚去除，正常变更保留 |
| `tasks/workbench-maintenance-product-worker.md` | 验收重定向 | 由成功恢复变为正确失败与无额外变更 |
| `tasks/workbench-maintenance-responsiveness-worker.md` | 分离独立要求 | UI/控制服务响应性测试保留，不保留救援事务 |
| `tasks/workbench-maintenance-faults-worker.md` | 历史/待办分类 | 旧恢复故障验收作废或被新用例取代，不更改旧结果 |
| `tasks/workbench-crash-worker.md` | 历史/新验收映射 | kill 后恢复成功不再是通过条件 |
| `tasks/workbench-doctor-worker.md` | 派工/历史分层 | 离线恢复、对账、回滚、解锁去除 |
| `tasks/workbench-restore-receipt.md` | 历史证据 | 收据规则不继续成为运行阻塞门槛 |
| `tasks/workbench-package-upgrade-worker.md` | 派工/历史分层 | 保留显式自升级正常路径，取消失败回滚和冷恢复 |
| `tasks/workbench-package-acceptance-worker.md` | 验收修改 | 自升级失败报错与无补偿；无虚假成功 |
| `tasks/workbench-self-update-audit.md` | 审计/待办分层 | 恢复相关缺口标政策取消，安全与正常更新问题保留 |
| `tasks/workbench-plugin-worker.md` | 派工/历史分层 | 初始化、安装、Host 失败不自动补完或重装 |
| `tasks/workbench-ui-worker.md` | UI 目标修订 | 错误卡片，删除恢复按钮/流程 |
| `tasks/workbench-browser-failures-worker.md` | 失败验收修订 | view 失败、失联、刷新不触发恢复；消息认证保留 |
| `tasks/workbench-desktop-worker.md` | 桌面目标修订 | 常规启停/托盘保留，不恢复崩溃任务 |
| `tasks/workbench-dual-control-worker.md` | 控制权验收核查 | 双端只读与互斥保留，不把恢复接管当通过目标 |
| `tasks/workbench-foundation-worker.md` | 历史/待办分层 | 独立入口可以观察错误，不要求救援功能 |
| `tasks/workbench-documentation-worker.md` | 文档派工修订 | 中英文、命令、状态、旧实现差距同步 |
| `tasks/workbench-audit.md` | 审计/待办分层 | 取消恢复缺口，保留真实安全与生命周期问题 |
| `tasks/workbench-external-discovery.md` | 边界核查 | 未登记进程只读/不可控边界，不新增恢复接管 |
| `tasks/workbench-rc2-worker.md` | 历史证据/策略更新 | 历史版本验证保留，与取消永久白名单决策一致 |
| `tasks/workbench-xp-compatibility-worker.md` | 适配边界核查 | 显式用户选定适配器与故障后自动换实现分开 |
| `tasks/workbench-demo-video-worker.md` | 分发叙事修订 | 不再演示或宣传救援、恢复、回滚 |
| `tasks/workbench-demo-narration.json` | 文案源修订 | 只修改叙事文本；不冒称已有视频已重制 |
| `tasks/pluginization-plan.md` | 计划/历史分层 | 取消恢复核心与 Doctor 救援路线 |
| `tasks/pluginization-core.md` | 合同/历史分层 | 共享错误与管理能力保留，恢复服务目标撤销 |
| `tasks/pluginization-runtime.md` | 合同/历史分层 | 正常安装与能力检查保留，不故障回退 |
| `tasks/pluginization-doctor.md` | 计划/历史分层 | 只读诊断替代离线恢复目标 |
| `tasks/pluginization-lock.md` | 安全边界核查 | 互斥保留，不添加恢复解锁工作流 |
| `tasks/pluginization-host.md` | Host 目标核查 | 错误传播，去异常后补救接线 |
| `tasks/pluginization-frontend.md` | UI 目标核查 | 与错误卡片和无恢复命令一致 |
| `tasks/pluginization-desktop.md` | 桌面目标核查 | 适配一致，正常视图显示不误删 |
| `tasks/pluginization-bundle.md` | 包职责核查 | 不将恢复模块继续写成必需能力 |
| `tasks/pluginization-localization.md` | 双语文案核查 | 错误事实，不含修复建议或恢复动作 |
| `tasks/pluginization-theme-compatibility.md` | 兼容边界核查 | 已知失败如实记录，未知组合允许尝试，不自动换主题 |
| `tasks/pluginization-themes-worker.md` | 验收/派工核查 | 不为所有主题强行修好后才算空间可用 |
| `tasks/pluginization-themes-acceptance.md` | 历史证据 | 保留实际成功/失败，不伪造新通过 |
| `tasks/pluginization-acceptance.md` | 验收/历史分层 | 恢复成功条件被新的故障验收取代 |
| `tasks/pluginization-trial-acceptance.md` | 历史证据 | 试用结果保留，当前恢复要求撤销 |
| `tasks/pluginization-distribution.md` | 分发目标修订 | 移除恢复分发要求，保留正常安装测试 |
| `tasks/pluginization-windows-distribution.md` | 分发/历史分层 | 独立 Doctor 诊断与构建资源同步 |
| `tasks/plugin-cli-rc2-worker.md` | 版本记录核查 | 保留接口验证事实，不新增长期恢复兼容分支 |
| `tasks/plugin-standard-install.md` | 计划/验收分层 | 正常安装有效，失败不补装或重建 |
| `tasks/plugin-distribution-worker.md` | 分发派工核查 | 包元数据、安装说明和错误政策一致 |
| `tasks/plugin-community-submission.md` | 对外文案核查 | 不宣传恢复、兜底或任意插件兼容 |
| `tasks/handoff-2026-09-14.md` | 交接更新 | 新原则优先；去恢复资产及回滚待办，版本策略保留 |
| `tasks/history-recovery.md` | 历史证据+活动段落修订 | 保留历史代码找回事实；旧“当前有效需求”改为当时需求 |
| `tasks/acceptance.md` | 历史证据/待办修订 | 旧通过事实保留，未完成恢复目标撤销 |
| `tasks/fix-acceptance-2026-09-11.md` | 历史证据 | 说明旧恢复能力验收不代表现行产品承诺 |
| `tasks/review-2026-09-11.md` | 历史审查 | 保留旧问题与证据，活动恢复建议取消 |
| `tasks/review-config.md` | 配置审查 | 原子写、隔离校验保留，修复/恢复目标区分 |
| `tasks/spaces-demo-video-worker.md` | 对外叙事修订 | 不再把恢复作为产品卖点 |
| `tasks/spaces-demo-video-acceptance.md` | 历史与新要求分开 | 旧媒体验收保留；新媒体不宣传恢复 |
| `tasks/spaces-demo-narration.json` | 文案源修订 | 对齐新原则，不篡改既有生成媒体文件 |
| `tasks/releases/**` 中的实际文档 | 历史/当前声明分类 | 历史发布说明保留，现行介绍与未来发布说明更新 |
| `tasks/artifacts/**` 中的实际文档 | 证据索引核查 | 只更新解释性索引，不重写原始结果或截图 |
| `.github` 下实际存在的模板/指导文档 | 开发/验收约束核查 | 取消要求恢复成功的验收或问题模板提示 |
| `web-dump-config.txt` | 原始实测材料 | 不因原则改动重写配置证据 |
| `LICENSE`、第三方许可证和引用原文 | 保留 | 不参与关键词替换，不改版权与来源 |

# 附录 B：测试、脚本与非 Markdown 接线检查

这些路径属于 R/Q 的实现范围，D 阶段只登记，不把可执行代码当作文档擅自删改。

| 范围 | 处置 |
|---|---|
| `tests/workbench-jobs.test.ts` | 恢复冻结/结算改为失败终态与不重放；schema、幂等、凭据断言保留 |
| `tests/workbench-supervisor.test.ts`、`workbench-maintenance.test.ts` | 真故障不恢复，正常功能和安全边界继续验收 |
| `tests/spaces-doctor.test.ts`、`workbench-doctor.test.ts` | 只读检查与拒绝旧恢复命令，移除成功回滚条件 |
| `tests/snapshot-store.test.ts`、`plugin-restore-point.test.ts`、`restore-session.test.ts`、`frontend-recovery.test.ts` | 逐断言分类，随着生产恢复链移除而移除相关测试；保留独立数据安全要求 |
| `tests/restore-selected.test.ts` | 先看语义；可能是恢复选中视图，不能仅凭文件名删除 |
| `tests/coordinated-upgrade.test.ts`、`runtime-store.test.ts` | 分清原子提交前准备失败与提交后回滚；后者不再被要求 |
| `tests/cooperative-children.test.ts`、`maintenance-responsiveness.test.ts`、`xp-compatibility.test.ts` | 不随 recovery 脚本名整组删除，保留非恢复目标 |
| `tests/process-manager.test.ts`、`diagnostics.test.ts`、`plugin-ops.test.ts` | 生命周期、错误原文/脱敏、无自动重试/重装 |
| `scripts/verify-workbench-crash.mjs`、`tests/fixtures/workbench-crash/**` | 从 kill 后成功恢复改为 kill 后失败可见、无自动恢复，保留生产路径测试 |
| `tasks/recovery-acceptance.mjs`、`real-snapshot-check.mjs`、`real-upgrade-check.mjs`、`restored-*.mjs` | 区分历史实验与有效门槛；不再用于宣称新政策符合；不在真实 Home 运行 |
| `scripts/verify-plugin-install-write-scope.mjs` | 测量能力可留，恢复实验不能成为生产恢复模块的新入口 |
| `scripts/build-spaces.mjs`、Supervisor manifest、Electron 打包条目 | 删除无用恢复产物时保留 runtime install 等共用能力 |
| `package.json`、`.github/workflows/ci.yml` | 同步测试清单与名字，保留混合测试中的安全/隔离/响应性覆盖 |
| 前端/CLI/Node i18n 与内嵌 HTML 字符串 | 中文英文都查，不留下“检查并恢复”“恢复中断工作”等生产动作 |
| 源码注释、导出 barrel、生成的 API schema/CLI help | 与公开合同同步；生成物由对应源重新生成，不只手改输出 |

# 附录 C：核查来源

以下链接固定到本次基线，便于执行者核对原文；不是对后续 main 的完成状态承诺。

- [基线提交](https://github.com/klarkxy/dsh-spaces/commit/c89dc05b364ca2ee4bb803a321c403e8a04cd9c0)
- [根 README](https://github.com/klarkxy/dsh-spaces/blob/c89dc05b364ca2ee4bb803a321c403e8a04cd9c0/README.md)
- [工作台用户文档](https://github.com/klarkxy/dsh-spaces/blob/c89dc05b364ca2ee4bb803a321c403e8a04cd9c0/docs/workbench.md)
- [最新插件管理计划](https://github.com/klarkxy/dsh-spaces/blob/c89dc05b364ca2ee4bb803a321c403e8a04cd9c0/tasks/plugin-management/plan.md)
- [活动任务清单](https://github.com/klarkxy/dsh-spaces/blob/c89dc05b364ca2ee4bb803a321c403e8a04cd9c0/tasks/todo.md)
- [工作台接口契约](https://github.com/klarkxy/dsh-spaces/blob/c89dc05b364ca2ee4bb803a321c403e8a04cd9c0/tasks/workbench-contract.md)
- [任务持久化与恢复冻结记录](https://github.com/klarkxy/dsh-spaces/blob/c89dc05b364ca2ee4bb803a321c403e8a04cd9c0/tasks/workbench-jobs-worker.md)
- [共享工作台接口](https://github.com/klarkxy/dsh-spaces/blob/c89dc05b364ca2ee4bb803a321c403e8a04cd9c0/src/shared/workbench.ts)
- [Doctor 说明](https://github.com/klarkxy/dsh-spaces/blob/c89dc05b364ca2ee4bb803a321c403e8a04cd9c0/packages/doctor/README.md)
- [Supervisor 说明](https://github.com/klarkxy/dsh-spaces/blob/c89dc05b364ca2ee4bb803a321c403e8a04cd9c0/packages/supervisor/README.md)
- [真实崩溃验收旧要求](https://github.com/klarkxy/dsh-spaces/blob/c89dc05b364ca2ee4bb803a321c403e8a04cd9c0/tasks/workbench-crash-worker.md)
- [版本策略交接](https://github.com/klarkxy/dsh-spaces/blob/c89dc05b364ca2ee4bb803a321c403e8a04cd9c0/tasks/handoff-2026-09-14.md)
- [历史代码恢复记录](https://github.com/klarkxy/dsh-spaces/blob/c89dc05b364ca2ee4bb803a321c403e8a04cd9c0/tasks/history-recovery.md)
- [测试与构建入口](https://github.com/klarkxy/dsh-spaces/blob/c89dc05b364ca2ee4bb803a321c403e8a04cd9c0/package.json)
