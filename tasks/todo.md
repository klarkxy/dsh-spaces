# 2026-09-15 活动任务账本

本文件是**唯一活动任务账本**。根 [TODO.md](../TODO.md) 只作导航和历史摘要。故障政策：[docs/let-it-crash.md](../docs/let-it-crash.md)。开发入口：[AGENTS.md](../AGENTS.md)。

产品路径已按 [docs/let-it-crash.md](../docs/let-it-crash.md) 实施。未在本机跑完的 CLI/浏览器项见 [q-coverage.md](q-coverage.md)。不推送、不发版本，除非用户另说。

插件功能计划：[plugin-management/plan.md](plugin-management/plan.md)。任务 01 证据见 [task-01-write-scope.md](plugin-management/task-01-write-scope.md)，不作为恢复产品已交付。旧批次的执行者、发布许可和完成记录不自动适用于本计划。

## D：文档与任务修订（本轮直接范围）

- [x] D0. 固定基线 `main@c89dc05`，`git ls-files` 分类受控文档，列出公开恢复入口。
- [x] D1. 唯一原则文件、README / REQUIREMENTS / CONTRIBUTING / AGENTS。
- [x] D2. 工作台/安装/包 README、实施计划、本账本、插件管理计划。
- [x] D2b. `tasks/workbench-*.md`、`tasks/pluginization-*.md`、演示/社区/发布文案：重写有效合同，历史盖章，不删 `history-recovery.md`。
- [x] D3. 逐文件交付记录（变更清单、撤销清单、仍有效任务、未迁移代码入口、验证结果、本地/提交/推送状态）。见 [let-it-crash-d-delivery.md](let-it-crash-d-delivery.md)。
- [x] D4. 按已完成实现读回文档。产品路径允许声明运行时已符合 let it crash；未接线历史模块和 CLI/浏览器未跑项见 [q-coverage.md](q-coverage.md)。

## 插件管理与 Space 导入导出（仍有效）

### M1：看清插件错误

- [x] 01. 一次性 Home 实测安装写入范围（测量保留；不是恢复模块建设前置，也不默认以后继续做恢复）。
- [x] 02. 统一插件状态、精确版本下载和多版本缓存；读不到实际版本显示未知；下载失败报错，不改用 latest。
- [x] 03. 工作台/桌面展示安装、启动、崩溃错误（全项目一致）；无修复建议或恢复入口；空间可保持崩溃。

### 已撤销（2026-09-15，不是延期，不勾成已完成）

- 原 03 安装环境恢复点：已撤销。
- 原 04 自动失败恢复 / 自动回滚：已撤销。
- 原 05 重启后恢复与 Doctor 恢复：已撤销。
- 原 06 撤销入口 / 恢复结果入口：已撤销（错误展示并入现 03）。
- 整 Home 快照恢复例外：已撤销。
- 整 Home 回滚最终矩阵：已撤销（改验故障终止、错误可见、无恢复副作用）。
- 失败项重试、原批次继续、中断续接：已撤销。

### M2：空间可分享、可导入

- [x] 07. 普通空间导出插件组成、顺序及可选配置，未知来源明示。不是整 Home 灾难恢复。
- [x] 08. 新空间暂存导入。三个结果分开：空间定义 / 插件安装 / 空间启动。不能要求启动成功才允许空间存在。失败只清理本次未发布且能证明归属的临时资源。
- [x] 09. 补齐桌面入口，完成往返验收；合法但不兼容组合启动失败必须可见，不得修好后才算成功。

### M3：批量与模板

- [x] 10. 批量逐空间执行；首项失败结束该批次（A 保留、B 失败、C 未执行）。无回滚、重试、自动继续或中断续接。
- [x] 11. 新空间模板复用创建流程；已有空间不自动变化；模板导致运行失败只报错。

勾选前按计划逐项保存验证证据。下一功能执行项为任务 02。

## R：运行时代码迁移

完成前不得声明运行时已符合 let it crash。用户已有备份、快照和数据不因迁移被删除。

- [x] **R1** 让错误被准确报告，而不是被吞掉。`WorkbenchFailureContext` + `formatWorkbenchFailure`；job.error 可带空间/阶段/插件或未知/退出码/信号。进程崩溃 lastError 使用同一格式。
- [x] **R2** 取消任务恢复状态机。`queued → running → succeeded / failed / cancelled`。中断任务记 failed（未确认），不重放；损坏记录保留原字节；`settleRecovery` / `recovery.resume` 明确不支持。
- [x] **R3** Supervisor 管理正常操作，不管理故障复活。入口：`src/adapters/node/workbench-supervisor.ts`、相关 runtime/http/views、`home-controller.ts`、`src/main/process-manager.ts`、`packages/supervisor/src/**`、`packages/plugin/src/host/supervisor-bootstrap.ts`。删除故障触发的管理器重新拉起、补装依赖、重建身份、自动接管、恢复运行权、救援模式。已有独立入口仍在线时可以显示管理器失败；入口自己也崩溃时用已有 stderr、启动器或日志，不再搭看门狗。持锁（含死所有者）acquire 为 `workbench/busy`，不 `reclaimDead`。
- [x] **R4** 删除恢复业务链，保留正常安装和必要安全操作。入口：`workbench-maintenance.ts`、`coordinated-upgrade.ts`、`snapshot-store.ts`、`snapshot-executor.ts`、`snapshot-worker.ts`、`restore-session.ts`、`plugin-restore-point.ts`、`runtime-store.ts` 及关联服务。取消配置恢复、安装恢复点、整 Home 恢复、失败回滚、依赖环境拷回、journal 对账恢复、升级后自动回退。提交前失败未切换新结果不是回滚，可保留。不要整份删除 `snapshot-worker`：先保留运行时安装等非恢复执行，并同步打包和启动参数。公开 `recovery.resume`、`snapshot.restore`、`config.restore` 产品入口明确失败。
- [x] **R5** Doctor 收缩为诊断，不再治病。入口：`packages/doctor/src/**`（`unlock` / `recover` / `rollback`）、对应 README 与 `tests/spaces-doctor.test.ts`、`tests/workbench-doctor.test.ts`。只保留能证明不改写环境的诊断与检查。旧恢复命令明确返回「不支持」和非零退出码，不能静默忽略，也不能转发到改名后的旧实现。诊断时不会清锁、改 job、写回运行时指针、重建配置或启动服务。
- [x] **R6** 同步删除 UI、API、CLI 和构建里的残留。入口：`packages/plugin/src/workbench/**`、client/host、`src/renderer/**`、`src/preload/**`、i18n、`scripts/build-spaces.mjs`、`package.json`、打包资源。错误页只留错误详情、查看日志、复制脱敏日志。常规启停卸载留在正常管理位置。
- [x] **Q** 真实故障验收 E01–E18（见 `dsh-spaces-let-it-crash-plan.md` §8）。故障注入保留，改验「失败被如实报告，并且没有发生抢救」。不整组删除 `test:workbench:recovery`；逐项拆分，保留与恢复无关的有效覆盖。不靠假测试、放宽条件或跳过获得通过。未在本机跑到的 CLI/浏览器项见 [q-coverage.md](q-coverage.md)。

## 全局 LLM 连接库

独立于 `web` 的共享连接资源。施工计划：[global-llm.md](global-llm.md)，完整契约：[docs/plans/global-llm-connections.md](../docs/plans/global-llm-connections.md)。P0 已固定 `0.1.5-rc.2` 接入面和配置来源；P1–P6 未完成。

## 其它仍有效、与恢复无关的未完成项

- [x] 取消永久精确版本白名单（兼容看接口与实际能力；未知版本号本身不应直接导致只读）。见 [handoff-2026-09-14.md](handoff-2026-09-14.md)。默认跟随官方 `latest`；每次安装/升级仍固定解析后的具体版本。已测试版本作为证据，不新增长期兼容分支。
- [ ] npm 登录与 scope 权限确认后公开发布，并读回社区搜索和包名安装结果。
- [ ] 未登记手工 DSH 的外部发现仍是已知缺口，不新增恢复接管。见 [workbench-external-discovery.md](workbench-external-discovery.md)。
- [ ] Catppuccin 原主题缺依赖失败：如实记录，不包装成 Spaces 已修复。
- [ ] 最终回归矩阵和新介绍视频（新媒体不得宣传恢复）。

以下保留历史施工状态。历史记录中已完成的恢复实现事实不改写；其中仍当作现行门槛的恢复要求视为已撤销。

# 2026-09-13 当前施工清单

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。

2026-09-14 换机续接与最新版本策略见 [handoff-2026-09-14.md](handoff-2026-09-14.md)。下一步取消永久精确版本白名单尚未实施，以下为原批次的验收状态。

- [x] 核实 npm 官方标签：latest=0.1.5-rc.1，next/最新发布=0.1.5-rc.2。
- [x] CLI rc.2 正式适配并保留 rc.1；真实运行验证，未知版本仍拒绝写入。
- [x] 普通 Web 标准安装后显示初始化入口；显式初始化管理环境并安全进入工作台。
- [x] 预构建插件元数据、发布前检查、CI、pnpm 用户文档及社区收录材料。
- [x] 全新隔离 Home 的安装/初始化/重启/重复初始化/卸载，rc.1 / rc.2 两版本真实浏览器验证。
- [x] 主 Agent 差异审查、真实浏览器验收、最终交付及外部发布状态说明。
- [ ] npm 登录与 scope 权限确认后公开发布，并读回社区搜索和包名安装结果。
- 历史 manager 自升级、故障注入及整 Home 回滚最终矩阵：**已撤销**（2026-09-15，改验故障终止、错误可见、无恢复副作用）。不得用标准安装成功替代，也不得继续作为发布门槛。

完整接口与边界见 [plugin-standard-install.md](plugin-standard-install.md)。以下为原施工历史。

# 首批施工与验收清单

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。

完整契约见 plan.md。Grok 施工；以下验收项由 Codex 独立核实后标记。

当前状态（2026-09-11）：0.2.0 代码及 Windows 本机验收完成。179 项测试、真实运行时安装、升级与分段回退复测、最终安装程序的新旧 DSH 页面及损坏恢复流程通过；平台限制见 [修复验收记录](fix-acceptance-2026-09-11.md)。下列 9 月 8/9 日状态为历史。

续接状态（2026-09-09）：类型检查与差异格式检查通过；最终包界面复测再次超时，清理遇到进程权限拒绝；回归重跑未完成。联网目录查询失败，沙箱外验收的自动审批两次因服务连接中断被拒绝，用户批准待定。已补真实跨版本升级/恢复验收脚本并通过语法检查，尚未执行通过。下面保留 9 月 8 日历史结果；本次未新增完成项，详情见 acceptance.md。

施工状态（2026-09-08 续接）：Grok 已交付，Codex 已接入并独立验收。135 项回归、类型检查、真实 DSH 隔离/生命周期/A8、诊断恢复、Electron 托盘/单实例、快照恢复后重开及退出、Windows 打包程序均通过。快照来源显示已修复，14 项相关测试通过（含新增旧指针兼容用例）。NSIS 安装包已生成，安装向导未实测。联网候选安装受 TLS 错误阻塞，跨版本升级尚未通过。初稿与返工问题见 review-config.md，详细证据与限制见 acceptance.md。

- [x] 1. 产品说明、需求和实施文档同步
- [x] 2. 保留 !!js/注释的配置读写与准确隔离校验
- [x] 3. 启停重启串行、端口预留、停止等待、应用单实例
- [x] 4. 诊断 UI、有限日志、脱敏、配置备份预览与恢复（当时实现事实；配置恢复作为现行能力已撤销）
- [x] 5. 托盘、关闭隐藏、恢复原界面、退出全停（“恢复原界面”指重新显示已有窗口，不是故障恢复）
- [x] 6. 版本库、版本来源、独立安装、统一运行时入口
- [x] 7. 维护互斥、协调升级、预检、失败恢复（当时实现事实；失败回退作为现行能力已撤销）
- [x] 8. 快照 UI、恢复确认、恢复前备份、断网恢复、中断恢复（当时实现事实；快照恢复作为现行能力已撤销）
- [x] 9. 类型检查、单元测试和构建
- [x] 10. 独立 Home 的隔离/A8/生命周期验证
- [x] 11. Windows Electron 用户流程及安装包 smoke
- [x] 12. 独立差异验收，记录平台限制和未验证项

后续路线：配置复制与模板 → 插件矩阵 → MCP 导入与任务提醒。模板与矩阵现由上方 2026-09-15 任务 10/11 承接；其中“部分失败重试”已撤销。本历史段落不施工。

本轮最终产物：`release/DSH-Spaces-Acceptance-0.1.0.exe`。修复后构建、Electron 恢复环境重开以及最终打包程序内置生命周期 smoke 通过；最终包的 Playwright 界面复测在调试连接阶段超时。联网安装/跨版本升级、安装向导及最终包界面复测仍是剩余验收项。
