# 2026-09-25 参考官方 desktop 优化启动流程

参考官方 DSH desktop 启动流程（六阶段百分比进度、`Startup completed in X ms` 总耗时、port 0 + stdout 读回）优化本地启动。已提交 `7319d48` 并推送 main；未打版本、未发布。

- [x] 桌面启动分阶段进度（attach 8% → prepare 24% → launch 56% → connect 82% → load-workbench 92% → ready 100%）：共享阶段类型与百分比映射、`DesktopServiceClient.onStage`、main 阶段状态机（`src/main/desktop-startup-progress.ts`，单调前进、防回退、失败不打印完成日志）、overlay 阶段文案与进度条（中英双语）。
- [x] 启动总耗时日志：`Startup completed in X ms (cold start|attached to existing service)`，时钟覆盖 open 延续的冷启动，仅成功就绪打印。
- [x] 冷启动去重：首次 attach 判决经 `priorDiscovery` 透传跳过 bootstrap 入口的重复全量探测（锁内 TOCTOU 复查保留）；`pollEndpoint` 复用 HomeController/锁对象；`bootstrapManager` 的 dump 结果复用给 `syncLoader`（同 profile 一次 `--dump-config`）；payload 校验合并为一次 manifest/digest 计算（时效比对校验保留）。
- [x] `presentWorkbench` 与托盘空间刷新并行（finally 汇合，刷新失败不阻塞呈现）。
- [ ] 评估后放弃：空间端口改 `port 0` + stdout 读回（改变端口稳定性语义，现有 reservePort + 端口一致性校验已满足安全要求）；`packLocalArtifacts` 锁前并行（输出到 per-Home 共享 toolsRoot，破坏单写者约束）。
- [x] 类型检查、完整构建、desktop-startup 全链及 workbench/主套件回归；新增 desktop-startup-progress、阶段序、priorDiscovery、dump/payload 复用等定向测试。workbench-package-upgrade 9 项、sample-plugins 1 项、supervisor-handoff 2 项失败经干净 main 对照确认为本机既有问题，与本轮无关。

# 2026-09-22 官方 alpha 全面迁移

- [x] 默认 CLI、开发下载入口、CI 与 SDK / peer / 锁文件统一到 `0.1.7-alpha.1`；移除旧 settings-file 合同。
- [x] 原生设置持久化、旧命名空间设置及 bridge 迁移、共享 LLM 投影与并发保存；中断留证、不恢复、不续跑，默认 web 及根设置隔离。
- [x] 新旧空间的真实安装、启动、原生页面与正常停止；当前构建 Electron 首页、品牌和设置开关验收。
- [x] 完整构建、类型检查、相关全量回归及独立完整性复审。最终证据与未验边界见 [alpha 迁移记录](alpha-migration.md)。仅本地修改，未切换用户已有运行中 Home，未提交、推送或发布。

# 2026-09-22 默认官方 CLI 版本更新（本轮早期历史）

- 用户随后明确选择最新实验版：当前默认已由本轮暂选的 rc.3 切换为 **`0.1.7-alpha.1`**。新安装、`dev:web` 下载入口及安装文档一致；固定精确版本，不跟随浮动 alpha 标签。下方 rc.3 对比作为本轮调研历史保留。
- [x] alpha 默认值下相关测试 23 通过、1 项真实 CLI 集成未运行，node/web 类型检查及 `build:spaces` 通过；读回 Supervisor 构建产物含新默认值。
- 当时 alpha 完整启动兼容性尚未验证：首次隔离 npm 安装遇到 registry TLS `ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC`；SDK 当时仍为 rc.2。后续完整迁移与当前验证结果以上方记录为准。
- 当时已确认 peer 预发布范围和 settings-file 的适配缺口；后续迁移已替换这些合同并完成独立设置及管理 profile 启动验收。

- [x] 新安装默认由 `latest` 改为精确版本 `0.1.5-rc.3`，同步 `dev:web` 下载默认值及安装文档；已有选定运行时不自动切换，SDK 构建依赖仍为 `0.1.5-rc.2`。
- [x] 实时核对 npm：`latest=0.1.5-rc.2`、`next=0.1.5-rc.3`、`alpha=0.1.7-alpha.1`。rc.3 尚无单独 GitHub Release/tag；下载包的 CLI 文件与 rc.2 一致，差异为 package.json 版本与依赖，不据此推断全部依赖无功能变化。
- [x] CLI、运行时存储与版本准入测试 23 通过、1 项真实 CLI 集成未运行；node/web 类型检查通过。本轮未迁移现有 Home、未验证 rc.3 完整桌面运行，未提交、推送或发布。

# 2026-09-22 开发启动加载旧界面修复

- [x] `dev` 构建完整组件，取得桌面单实例锁后按内容更新现有开发沙箱；同版本不同内容可更新，内容一致跳过安装。
- [x] 正常停止空闲服务；保持冷启动与 Home 写锁、独立管理 profile、安装读回及原子选取；失败保留维护证据，不重试或续跑。既有工具目录与组件指针保持一致。
- [x] 真实 `pnpm run dev` 更新原 `.sandbox/dsh-home`，首页、设置、固定关闭与 Esc 实测通过；重复启动拒绝且原 Supervisor 不变，无调试参数重开输出 `current`。
- [x] 原有数据及默认目录指纹一致；定向测试、类型检查与独立审查见 [开发刷新验收](development-refresh.md)。仅本地修改，未提交、推送或发布。

# 2026-09-22 Logo 与看板娘替换

- [x] 使用用户提供的图片统一桌面/托盘/打包图标、空间默认图标、工作台入口及首页图标；原图保留于 `resources/brand-source.jpg`。
- [x] 通过 DSH 的 `sidebar.brand.mark` / `conversation.hero.brand.mark` 插槽替换原生首页 Logo 和看板娘；不改写 DSH 原生文件或默认数据目录。`scripts/render-brand-icons.py` 统一生成静态资源。
- [x] node/web/spaces 类型检查、完整构建、图标/客户端入口定向检查 7 项通过；工作台 UI 与空间图标 55 项、文案 11 项通过。同步更新原先要求“鲸鱼”字样的文案断言，图片源文件哈希与用户附件一致。
- [ ] 真实桌面首页截图：`.sandbox/branding-live.log` 的沙箱运行因 GPU 启动失败退出；沙箱外隔离运行 `.sandbox/lease-diagnosis/live-Q2IRtJ/result.json` 因管理进程未能启动而未进入首页。本轮不声明真实首页显示已验收。测试实例已关闭；未提交、推送或发布。

# 2026-09-22 首页与设置整理

用户要求首页进入 DSH Web，管理功能归入设置，并解决关闭按钮难找的问题。本轮只做本地修改、构建与隔离验收，不提交或发布；保留此前的启动修复。记录见 [首页与设置验收](home-settings.md)。

- [x] 首页显示当前管理 profile 的原生 DSH Web；切换空间和设置保留首页实例与草稿，不改写默认 `web`。
- [x] 管理分类移入设置；常规只保留语言、主题，端口与服务停止放入高级。
- [x] 固定右上角关闭、Esc、焦点归还与键盘导航；窄窗口、滚动和设置草稿回归通过。
- [x] 真实隔离桌面首用流程与最终截图验收；显式主题不再被 DSH 颜色覆盖。

# 2026-09-22 正常重开与后台诊断修复

用户明确要求修复控制进程退出后永久挡住应用启动的问题，并允许 Cursor 施工。主 Agent 负责启动合同、互斥、集成和验收；Cursor 负责后台诊断。本轮仅本地修改与验收，不提交、推送或发布。现行边界见 [故障政策](../docs/let-it-crash.md)，下方历史“死亡租约永不释放”不再约束一次新的用户启动。

- [x] 新的用户启动可安全释放本次观察到的死亡 Supervisor 租约及匹配端点；保留失败证据，不重放任务。
- [x] 启动准备使用带进程身份的互斥，竞争者连接获胜者，不重试失败启动；正常释放失败如实报告。
- [x] 后台自身留存有界脱敏诊断，桌面退出不影响记录；早退及时报错，错误页复制真实诊断。
- [x] 回归、构建、真实隔离桌面重开与独立审查；证据见 [本次验收](supervisor-reopen.md)。

# 2026-09-21 v0.4.0 发布（完成）

用户已授权提交、推送并打版本，取代下方蓝图实施阶段的仅本地限制。版本统一为 0.4.0，沿用 GitHub Release 工作流；不执行 npm publish。

- [x] 提交蓝图实现，合并远端 main 的桌面启动修正。
- [x] 版本更新、本地组合回归与构建（蓝图 196 通过/4 权限跳过，桌面启动 55 通过，类型与构建通过）。
- [x] 推送 main 和 v0.4.0，确认 CI 与三平台发布构建。
- [x] 核验 10 个正式附件、三平台更新清单及 Windows 产物；真实蓝图流程和桌面冷启动通过，Release 已公开为 Latest。见[发布验收记录](release-0.4.0.md)。

# 2026-09-21 蓝图能力（本地完成，进入 0.4.0 发布）

用户选择以 JSON / 分享码分发插件组合与配置预设；数据备份、迁移和重载另属一条链。规范已按用户要求移至根目录 [BLUEPRINT.md](../BLUEPRINT.md)，供蓝图使用者与开发者共同阅读。用户授权 Grok 负责本轮全部实现（含前端），主 Agent 负责合同、编排、集成验收和文本；仅本地施工，不推送或发布。执行范围和验收证据见 [蓝图实施记录](blueprint-implementation.md)。

- [x] 编写格式、来源与版本、组合与配置、本机输入、依赖/互斥、应用流程和验收要求。
- [x] B1：JSON Schema、严格 JSON / J / Z 编解码、域校验、输入绑定和关系诊断。
- [x] B2：现有 Supervisor / product API 内的生成、预览、应用和本机映射。
- [x] B3：桌面与浏览器共用的蓝图界面，保持数据导入导出独立。
- [x] B4：根文档及用户/开发者入口、独立测试、真实运行与浏览器验收、集成审查。

# 2026-09-21 桌面正常启动体验修复

- [x] 将确认无后台的连接结果改为正常 `stopped`，不伪装成安装或控制器故障。
- [x] 桌面打开时先连接已有服务，仅在确认不存在且环境就绪时正常冷启动一次；首次安装成功后继续启动。
- [x] 正常未启动卡片提供主按钮；真实故障只显示诊断与日志，不再提示重装环境。
- [x] 保留单写者与协议检查；无清锁、接管、失败自动重试、故障恢复或任务重放。
- [x] 本地 21 项启动状态机测试通过；覆盖安装/连接并发和一次性启动边界。
- [ ] 定向 CI、双语 UI 与 Windows 实际桌面入口验收，结果记录于本次修复 PR。

# 2026-09-21 v0.3.1 发布

用户已授权推送 main 并发布补丁版本；该授权取代下面历史合并阶段的仅本地限制。沿用 GitHub Release 工作流，桌面与六个组件包统一版本；本次不执行 npm publish。

- [x] 本地合并与真实流程验收完成，源码位于 main。
- [x] 推送发布提交与 v0.3.1 标签，main CI 与三平台发布构建全部通过。
- [x] 核对公开 Release、10 个附件与三平台更新清单；从正式 Windows 安装包提取的程序通过真实桌面/浏览器验收。见[发布记录](release-0.3.1.md)。

# 2026-09-20 分支合并与架构收敛

本文件继续作为唯一活动账本。[本次计划](../docs/plans/spaces-merge-convergence.md)，[执行与验收记录](merge-execution.md)。用户已授权 Grok 施工，主 Agent 编排、集成和验收；本次前端也交 Grok，Kimi 不参与。仅本地实施，不推送或发布。

- [x] A0：固定最新基线与本地备份引用，完成独立测试基线；官方 CLI 补充检查已通过，真实双端与安装包仍单独验收。
- [x] A1：279 个差异路径逐项审计，加核 3 个导入点独有差异；4 处文档/验收脚本遗漏已补齐，2 处 Windows 测试问题已独立复测。
- [x] A2：`d8a692d` 连接旧分支历史；merge 前后 tree 相同，旧分支已为祖先。
- [x] B1：统一协议、权限、实例身份与正常升级交接合同。
- [x] B2：后台用例、任务与管理写入收敛到现有 Supervisor。
- [x] B3：模板、分享、批量、设置、插件缓存和诊断能力完整接入统一接口。
- [x] B4：桌面使用共享工作台与后台，退出旧业务装配；最终打包程序与 Chromium 验证同一活动任务在桌面退出后继续完成。
- [x] B5：统一制品、受控升级和遗留代码清理；标准插件、组件更新及正常运行时/快照流程已实测。
- [x] B6：当前本地集成范围的跨端、故障、打包目录及重要审查通过，已快进合入本地 main，旧分支祖先关系保留。签名、NSIS 安装登记/卸载和其它平台等实际未验项见[验收记录](merge-execution.md)。

以下是之前的活动记录与验收限制，本次不重新认定其通过状态。

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

独立于 `web` 的共享连接资源。施工计划：[global-llm.md](global-llm.md)，完整契约：[docs/plans/global-llm-connections.md](../docs/plans/global-llm-connections.md)。P0 已固定 `0.1.5-rc.2` 接入面和配置来源；P1 已实现 catalog / policy / 凭据记录与 CAS；P2 已把共享连接接到官方适配器流式调用；P3 已露出脱敏管理 API、独立凭据通道和无秘密 apply 计划。P4 已露出全局模型中心与 Space 绑定 UI（Web / 桌面）。P5 已实现显式接管、无秘密分享映射和 llm-bridge 打包。P6 已加上发布门禁、秘密扫描和 A 矩阵证据；未跑平台与 A25 见 [global-llm-acceptance.md](../docs/compat/global-llm-acceptance.md)。

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
