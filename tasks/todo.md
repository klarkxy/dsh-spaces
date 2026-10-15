# 2026-10-15 全新 Home 持续 UI 验收（Playwright 干净上下文）

在 Devin 中延续 10-14 的未关闭项。全新隔离 Home、Node 26.10.0、未修改的官方 rc.2 SDK、上一轮包 `a313325d…`（源码冻结校验未变）、Playwright Chromium 全新上下文（无累积 Cookie），每步截图 + ARIA + Supervisor 状态快照，`requestfailed` 经 CDP 逐条特征化。验收驱动与证据在 `.sandbox/ui-accept-devin-20261015/`（`REPORT.md`、`RESULT.json`、`host-playwright-7/`）。

- [x] 初始化、创建 Browser 空间、进入、重启（generation 1→3，manager PID/generation/epoch 不变）、首页、停止服务（endpoint 释放、作业 succeeded）、显式一次重开（新 epoch，看板加载）、神圣树检查：run 7 共 8/9 通过；run 5 曾 9/9 但驱动把事件计了两遍且漏计 Supervisor 事件，数字已在报告中更正，不作为结论。
- [ ] 持续 12 分钟窗口 FAIL（run 7）：04:05:21Z 两条同时发往 Supervisor 的请求在浏览器内停滞约 5.2 s 才开始 DNS/连接（CDP timing `domainLookupStart=5240ms`，服务端耗时约 220 ms）；dashboard `overview` 查询在未发出时被 5 s frame deadline 中止，首次失败即终态，切回首页后看板持续显示 `看板读取已停止 · dashboard/unavailable · read.deadline · overview · transport · 5012ms` 直至窗口结束（探针 14–48）。这与 10-14 未归因的 U01 `read.deadline` / 无状态 `board.transport` 同类，而且发生在干净 Cookie、未打补丁 SDK 下，排除了 Cookie 累积和 header 上限作为唯一原因。停滞发生在浏览器侧请求发出之前，发起方未定；候选为 Chromium 对该 origin 的 socket 池/调度排队，需 `--log-net-log` 复跑才能判定。run 5 同窗口未见该失败，复现率 1/2。
- [ ] 观测但未判定：显式重开后 manager 页仍渲染上一纪元的 `已创建 / 进入空间` 提示（10 s 后仍在）；`localStorage` 键名两纪元一致。停止服务时两次运行呈现不同面：run 5 为 `结果尚未确认，没有重新发送请求` 提示，run 7 为宿主页 `workbench/unavailable` alert、管理帧消失。
- [x] 未提交、推送、发布；未访问真实 `~/.dsh`；10-14 两轮证据目录未改动。

# 2026-10-14 实机确认问题修复与 Node 26 隔离复验

- [x] P1 活动模型 Apply：绑定实际子进程身份和空闲预留，忙碌或未知状态拒绝；维护任务也计入活动。最终安装包真实受控流验证忙时拒绝、generation 不变、原流完成、空闲后 Apply 成功，供应商请求只有一次。
- [x] P1 损坏空间登记：保留实际失败，启动和写入准入校验，不伪造空列表；停止依照实际自有运行记录。schema 和截断 JSON 两个新 Home 反例均通过，坏字节不变。
- [x] 其余确认源码问题：Browser 保护 Supervisor 来源、同坐标组件漂移实际对齐并严格读回、非法目录缓存拒绝、停机保存的 before-stop/final-save 阶段区分、第三方 peer 预检，以及已知作业错误码投影完成。最终包针对原生案例 14/14 通过。
- [x] Home 身份、首次失败进度和诊断转发、Portal/原生失败分类及停止结果未确认提示完成；不重发变更、不新增恢复路径。公开诊断修复不能代替原停顿根因验收。
- [x] 独立官方 rc.2 聊天客户端补丁：受控普通 Web 中，断流前、失败后、刷新历史后均保留部分文字和 TRANSPORT；一次 prompt、一次断流、一次供应商请求，历史字节不变。该补丁不在 Spaces tgz 中，未替换真实 SDK，也未上游发布。
- [x] Node 26.10.0、新隔离 Home 下规定检查及额外交互/包预检共 15 个组最终有通过记录。最后 unavailable 白名单小修后重新运行受影响的清单、三组类型、构建及 workbench；其他未受影响组继承前次通过，机器索引注明边界。
- [x] 最终包 bb06ac5e… 已在新隔离官方 Web 宿主安装并核对组件/客户端；358 个构建输入保持冻结。原 1,991 份证据和 24 份关键失败状态文件最终哈希不变；17 个受检 Home 未写 sacred trees。未提交、推送、发布或迁移真实 Home。
- [ ] 持续官方 UI 验收尚未关闭：最终宿主页实见 portal/transport-failed，原 U01 read.deadline 停顿及 Browser 标签调用失败仍未归因。正常重启、停机、显式新启动成功不抵消这些失败。嵌入控件操作受工具限制；独立打开 3103 管理页被自动审批拒绝，拒绝后没有绕过。

2026-10-14 后续：用户已允许独立隔离管理页访问。Supervisor 64 KiB 请求头上限、Portal 同一 selection 只转发一次及 Browser 有限错误分类已通过受影响检查并重新打包。全新 Node 26 Home `host-mux-native` 实际创建、启动、正常重启 Browser（generation 1 → 3）并读取首页与重启后的 Browser 页面；manager PID 和 epoch 未变。06:42:11 UTC 观察到外层宿主和管理器同时 `ECONNRESET` / WebSocket 1006，断开前 Pong 正常，无 heartbeat 主动终止证据；发起方仍未知。Dashboard fetch 与 SDK generation 取消没有直接信号绑定，不能将旧 board.transport 一概归因于 mux。完整持续 UI 仍为 REVISE；359 个构建输入、原 1,991 份静态证据和 24 份关键失败状态哈希不变。详见 [后续界面报告](../.sandbox/ui-fixes-node26-20261014/REPORT-UI-CONTINUATION.md)。

详见 [本轮报告](../.sandbox/live-fixes-node26-20261014/REPORT-FINAL.md)、[机器证据索引](../.sandbox/live-fixes-node26-20261014/DELIVERY.json) 和 [独立复核](../.sandbox/live-fixes-node26-20261014/final-review/REVIEW.md)。独立审查接受限定的源码/包/原生修复范围；完整持续 UI 结果仍为 REVISE。

# 2026-10-13 审查四项修复与 Node 26 统一

- [x] Windows Global DOS junction 通过共享 native 路径检查识别；Diagnostics 外写、Snapshot 外部复制和无法解析的既有链接明确拒绝，合法内部链接仍通过。
- [x] 作业公开理由在写盘和读取投影时覆盖 quoted/serialized JSON、Unicode key、数组/对象和嵌套 YAML 凭据；旧记录原字节保留，普通多行失败原因保留。
- [x] HostShell/portal 保留脱敏的初始化、角色与实际调用失败原因，迟到响应、旧计时器和泛化 snapshot 错误不覆盖当前原因。
- [x] 快照依赖按真实包位置检查，补齐实际入口、同名文件和 entryless 包校验；一次独立 Node 进程批量解析，避免长期 Supervisor 的模块缓存接受旧入口，不执行依赖代码或 preload。
- [x] 按用户决定仅支持 Node 26.x：默认工具链 26.10.0，engines、入口检查、CI、类型定义和有效说明同步；不再维护 Node 24，不自动修复旧工具链。下文 Node 24 记录保留为历史事实。
- [x] 最终 Node 26.10.0 下清单检查、三组类型检查、build、全部八个规定测试组均通过；额外 Chromium 交互 10/10，打包预检通过。Dashboard 使用隔离 rc.2 SDK，测试使用隔离 Home/TMP，保留既有跳过项。

详细证据：[修复验收报告](C:/Users/27837/.codex/state/plugins/codex-security/scans/dsh-spaces/artifacts-9e2f67813588fc12355310567a8174bd6acfbfe217fa74c764678d45634fcd4b/artifacts/fix-summary.md)。本轮没有提交、推送、发布或替换已安装宿主；未重新跑完整实机场景或长期运行验收。

# 2026-10-13 实机缺陷修复与新隔离 Home 复验

- [x] 分享头像上限、自带/本地组件坐标、Browser待手动信息修复；模板/分享/蓝图真实创建与显式启动通过。
- [x] 快照运行时复制范围收窄、可信前缀与依赖闭包校验前置；新无密钥 Home 正常快照和只读 Doctor 通过。
- [x] 真实失败理由经 Host/Remote/UI/作业存储保留并脱敏，迟到旧错误不串页；Cookie无效Origin在派发前拒绝，15个真实请求403。
- [x] Windows Archive模块解压失败修复；另一个全新 Home 真实安装alpha.2，停止/运行空间升级和实际启动通过。
- [x] 原失败现场23个关键文件哈希不变；本轮失败Home和脚本原文继续保留，没有恢复/重放。
- [x] 最终Home用户指定MiMo连接经UI保存与显式应用，真实两轮42→43成功；另一个新工作区的pwsh输出437，真实todo闭环通过。
- [x] 规定全部检查已运行，类型/构建/LLM/Browser/浏览器DOM通过；未提交、推送、发布或迁移真实Home。
- [ ] Node24链接边界尚未验收：最终全套23次junction相关失败，Node26只作诊断对照，没有削弱安全断言。完整生产故障注入、Browser总线UI、raw流delta、在位宿主包替换和完整嵌入交互等仍有覆盖缺口。

详细结果、46案例矩阵及原始误判审计：`.sandbox/live-web-fix-20261013/REPORT.md`。最后测试宿主 `http://127.0.0.1:2262/`，最终 Home `upgrade-verified/home`。这是本地实机修复记录，不是全矩阵通过声明。

# 2026-10-13 重构审查修复

- [x] 显式启动沿用首次发现的控制所有者，交给既有串行启动流程退休可证明死亡的普通租约；只读发现不清理，活、模糊、外来与交接所有者仍受保护。维护锁、Home 内标记，以及绑定、显式和默认快照目录中的 `pending-restore.json` 均阻止退休，原租约、端点和证据保留。
- [x] 管理插件对齐失败后，认证 `space.start` 同样被拒绝并保留原诊断，不再次安装或启动管理器。
- [x] 取消管理器初始化中断后的续装；初始化期间拒绝并发变更，任务执行再次检查写权限，当前失败阻止后续写入。遗留 `manager-bootstrap.json` 在重开时保留，损坏记录也不猜测或重建。
- [x] 空间详情的目标 DSH 版本随候选加载派生，保留仍有效的用户选择，并在空间或固定版本改变时重置。
- [x] 删除全局 `runtime.install` 的 UI、公开类型、schema、计划生成和执行入口；旧请求与旧保存计划明确 unsupported，按空间安装与未使用运行时删除保留。
- [x] 独立复核结论 READY，无未关闭问题。Node 24.19.0 下，测试清单检查、三组类型检查、最终构建、全部八个规定测试组及额外 Chromium 交互组均通过（交互组 10/10，其他组保留既有跳过项）。Dashboard 使用隔离安装的 DSH 0.2.0-rc.2；所有运行测试使用隔离 Home 和临时目录。结果与日志索引见 `.sandbox/fix-review-20261013/verification-summary.json`。未执行已安装官方宿主验收，未提交、推送或发布。

# 2026-10-12 空间改为注册制，不再扫描收养 profile

用户批准的设计变更：空间只在 Spaces 中创建（直接创建、模板、蓝图、分享导入）；profile 目录固定 `profiles/space-<name>`，数据在 `hub/space-<name>`，成员资格以 `hub/spaces.json` 中带 `createdAt` 的注册项为准。Spaces 不扫描、不收养、不修改其他 profile 目录；旧版本或其他途径创建的 profile 不迁移，仍是普通 DSH profile。

- [x] S1：注册制空间跟踪——`SPACE_ID_RE`/`SPACE_NAME_RE`、注册即空间、创建登记 `createdAt`+宿主版本 pin+显示名、删除只作用于已注册空间、删除 `pinExistingSpaces`、蓝图/模板/分享导入走同一创建路径、按空间操作拒绝未注册 id（`39d1af9`）。
- [x] S2：移除收养——删除 onboarding 扫描与 `onboarded`、profile 分类（`ProfileKind`/`classifyProfile`/`onboardingAction`）、`needsConversion`/`needsIsolation`/`isolation` 字段与 UI、`space.verify`（归入 removed kinds → `workbench/unsupported`）及相关 schema/i18n/测试；Spaces 自建空间的隔离 patch 写入保留（`b849ef9`）。
- [x] S3：界面对用户显示 displayName（栏、运行时 pinnedBy、快照空间列表、插件与 LLM 空间选择器、蓝图结果），创建对话框给 `SPACE_NAME_RE` 名称提示；文档与 `REQUIREMENTS.md` 改为注册制表述（本条目即该提交记录）。

# 2026-10-12 真实验收缺陷修复（F1–F5）

真实浏览器验收（`.sandbox/e2e-20261012`）暴露的问题修复。DSH 0.2 中官方插件内置于运行时并随之变化，Spaces 从不向 profile 安装它们。

- [x] F1：官方插件改为运行时内置；删除 `official-plugins.ts`、启动时官方版本检查与 `space.runtime.set` 的官方重绑步骤，修复带本地 `@deepseek-ai/*` 依赖的 profile 全部 `settings/mutate` 被拒（Defect 1）与 `assertOfficialRuntime` 误报（Defect 4）（`f4cd452`）。
- [x] F2：Spaces 自有组件漂移自动对齐：管理器插件 payload 摘要与 view-bridge 分别校验、只装不一致项；空间启动时 view-bridge / llm-bridge / Browser 与所选制品不符即从制品重装；自有归档统一摘要命名（Defect 3）（`d53e03c`）。
- [x] F3：服务停止后（管理身份仍在、Supervisor 不可达）工作台页提供“启动工作台”，点击显式冷启动一次；仅挂载绝不冷启动（Defect 2）（`2a1c6f2`）。
- [x] F4：归档列出/读取/解包改用依赖中的 npm `tar`（7.5.22），保留条目名过滤、大小上限与路径安全检查；Windows 盘符绝对路径不再被 GNU tar 误解析为远程主机（`9e2f5d2`）。
- [x] F5：文档措辞改为官方插件内置于 DSH 运行时并随之变化、Spaces 从不向 profile 安装；本条目即该记录。

# 2026-10-12 P1：升级改走宿主插件（第一阶段）

用户决定移除 Spaces 应用内自我更新：Supervisor 与管理 profile（`spaces-hub`）跟随宿主安装的插件。升级路径为 `dsh plugin --profile web add <新包>` → 管理界面停止服务 → 重新打开 Spaces。本仓库自带的桥接（view-bridge / llm-bridge / Browser）保持在每个空间启动时自动对齐。

- [x] P1a：冷启动总是选择宿主插件自带的组件组；仅当选中指针摘要一致才复用旧选择，旧 payload 不再按新清单校验（`7c39c07`）。
- [x] P1b：Supervisor 可写启动时在管理器启动前对齐管理插件与绑定组件组；对齐失败即阻止启动并报告原因（`0bae5f9`）。
- [x] P1c：删除自我更新与组件交接：`workbench.upgrade`、`workbench.prepare`、`component-handoff`、一次性 launcher、`--accept-handoff`、管理界面更新面板与对应 RPC。旧式更新遗留证据（`workbench-upgrade.json`、`.dsh-spaces-upgrade/journal.json`）仍阻断写入；旧客户端的 `workbench.upgrade` 返回 `workbench/unsupported`（`4f0a551`）。
- [x] P2 按空间固定版本：每个空间固定精确的 DSH 运行时版本，官方基础插件（dsh-base / dsh-web-app）内置于运行时并随之变化，Spaces 不向 profile 安装；第三方插件安装与升级只接受精确版本。升级在空间设置中由用户发起，版本来源为插件库与 npm。已有空间首次启动时固定为当前实际使用的版本；新空间默认宿主的 DSH 版本。切换前不自动建快照，禁止降级。管理空间（spaces-hub）跟随宿主 CLI。Spaces 声明支持的 DSH 最低版本，桥接必须兼容整个范围；低于最低版本的空间启动失败并提示到空间设置升级。删除全局 runtime.install / runtime.upgrade 与协调升级。提供用户触发的删除未使用运行时（`f1e8a90`、`74ea256`、`cddabe9`、`86d51bf`）。
- [x] `validate:plugin` / `validate:distribution` 仍假定普通 profile 提供 `spaces/*`（专用 manager 之前的设计），已过时：已删除两个校验入口与 `scripts/verify-spaces-plugin.mjs`、`scripts/verify-spaces-distribution.mjs`；共享 harness 移至 `scripts/lib/distribution-harness.mjs`（本条目即该提交记录）。
- [ ] `packages/*/README.md` 中残留 `0.1.7-alpha.1` 等旧版本说明，待统一。

# 2026-10-12 清理与结构拆分

用户授权按主题分批本地提交，不推送、不发布。升级架构（组件清单、交接、快照）本轮不动。

- [x] 提交自有 Electron 壳移除（`bff1fde`）。
- [x] A：删除不可达的恢复结算、restore/recover 桩、孤儿模块与壳时代导出，启用 `noUnusedLocals`（`a00cae3`）。公开恢复命令仍明确失败，历史恢复证据仍阻断写入。
- [x] B：新增 `check:test-lists` 守卫与 `test:dashboard`，补齐 20 个未入组测试，修复 3 项基线失败和两处测试侧竞态（`15f71f1`）。
- [x] C：把 `workbench-supervisor.ts` 拆到 `src/adapters/node/supervisor/` 下的模块和四个协作者，对外导出不变（`2af8c61`）。
- [x] D：REQUIREMENTS 定位改为插件，历史任务记录归档到 `tasks/archive/`（`f20fcb6`）。
- [x] E：看板请求体超限时在 8 MiB 上限内读完再回 413，客户端不再因连接重置丢失 413；超过上限直接断开（`824e575`、`b931430`）。
- [x] F：测试类型检查 187 → 0，新增 `typecheck:tests` 并接入 CI，只改测试代码（`d83d18e`）。
- [x] 蓝图 `assertBundlePatches` / `provenanceMismatch` 不接回：应用时的真实模块解析（`blueprint-workbench.ts` 中 `resolvedIdentityAllowed`、"no bundle patch" 资格检查）和生成时的 `locateProvenancePointer` 已覆盖它们的用途。
- [x] G1–G4：Supervisor 小清理（`8ef220f`，含无 CLI 分支补调 `refreshAvailability`）、生命周期状态收进 `supervisor/lifecycle.ts`（`d52faa4`）、空间运行登记 `supervisor/space-runs.ts`（`1e4cb10`）、计划执行 `supervisor/plans.ts`（`a7fc599`）。主文件 2316 → 2042 行，子模块依赖回调明显减少。
- [ ] 负载下的既有偶发失败（`e9e0099` 上同样出现）：`tests/dashboard-supervisor.test.ts` 任务偶尔以 failed 结束或被 `workbench/maintenance` 拒绝；`packages/blueprint` 的 `native.test.mjs` 端口获取竞态。

# 2026-10-12 移除自有 Electron 桌面壳

用户确认 Electron 方案废弃，产品只通过插件安装进官方 DSH Web / DSH Desktop。本轮移除自有桌面壳，不做发布。

- [x] 删除 `src/main`、`src/preload`、`src/renderer`、`src/adapters/desktop`、`src/shared/desktop-shell.ts`、`src/shared/layout.ts`、`electron.vite.config.ts`；`src/shared`/`src/core`/`src/adapters/node` 与 `packages/*` 保留（官方 Desktop 宿主桥接不属于自有壳）。
- [x] 删除 Electron 脚本（dev-electron、ensure-electron、run-smoke、verify-spaces-desktop、verify-workbench-dual-control）与桌面 CI 工作流（desktop-startup.yml、release.yml）；`scripts/verify-component-update.mjs` 改用 `attachExistingSupervisor` + `mintSupervisorHandoff`，不再依赖桌面客户端。
- [x] 删除壳专属测试（browser-guest、desktop-startup*、desktop-service-client、frontend-recovery、package-build、development-refresh 及其孤儿模块）；`supervisor-reopen`、`process-manager`、`llm-secret-leaks`、`write-paths` 改为不引用壳。
- [x] package.json 移除 electron/electron-builder/electron-vite/electron-updater 与 vite/tailwind/lucide-react/motion/fontsource 及 electron-builder 配置；`npm run build` 现在只构建组件组。
- [ ] `.github` 之外的历史验收记录（tasks/、docs/dashboard/ 等）按惯例保留原文；其中提到的桌面流程不再是现行门槛。
- [ ] 官方 Desktop 宿主嵌入（native-host 桥、`dsh-app://app`）保留，仍待独立验收。

# 2026-10-09 精简 MVP：消息总线、能力查询、Browser Space

当前工作分支包含最小跨 Space 总线、权限过滤的静态能力查询，以及可作为第六组件安装的独立 Browser Space。云端验收边界见 [Workbench Browser Web 验收](../docs/workbench.md#browser-web-acceptance-in-an-isolated-home)，可复现脚本为 `scripts/accept-browser-web.ts`。未做 PR、合并或部署。

- [x] 官方 DSH 0.2.0-rc.2 Web 双 profile 在隔离临时 Home 内真实创建、安装插件、启动两个 Host，认证 RPC、默认拒绝、过滤能力查询、跨 Space openURL/listTabs 通过。
- [x] Browser-only root 经官方 SlotCore 选举和服务器端渲染验证；六组件构建/打包及专项测试通过。
- [x] 最终三套类型检查与完整构建通过；workbench 539 项中 534 通过、5 失败，5 项在原始基线对应文件同样重现；spaces 139 通过、3 跳过。运行使用 `node --import tsx --test` 执行脚本同一文件列表（云端 tsx CLI 管道受限）。
- [ ] 基线测试债务：额外 frontend-recovery/dsh-cli/plugin-library 64 项中 61 通过、3 失败，与原始基线一致；完整默认 test 在 Linux 的 Windows taskkill fixture 失败后挂住，已中止，不计为全套通过。本轮只更新旧“禁止任何 preload”断言为专用窄桥和真实 sender/frame 约束，没有改动这些基线失败。
- [x] 本机 Web 地址栏、可嵌入页面、A/B/A 状态保留、首页切回和 800px 布局通过；见 [本机验收](archive/browser-local-acceptance-2026-10-10.md)。
- [ ] Web 拒绝嵌入提示不完整：实际截图主要为浏览器破损图标，只有通用 Web preview 文案与外部打开入口，未完成产品层面的清楚说明。
- [x] 本机真实工作台完成 Browser 预设创建 → 实际安装 → 首次启动生产链；官方 Desktop 隔离宿主也完成 UI 安装、初始化、创建及显式启动，持久化作业均 succeeded。详见本机验收记录。
- [x] 自有 Desktop 当前构建连接隔离服务后，原生网页、A/B/A 保留、页内导航同步及 guest 接口隔离通过。已实测隐藏超过 2.5 秒后 guest 销毁、返回原始地址；不保证长期离开后的页面/登录状态。
- [ ] 官方 Desktop 0.2.0-rc.2/Windows 原生 Browser 呈现失败：有效地址创建标签后显示 `Native Browser is unavailable.`，无网页 guest；深色宿主标签文字对比度也不足。原始官方代码隔离实测，不代表原安装 EXE 完整引导/登录验收。
- [ ] 旧五组件安装不能直接热升级到六组件包；本轮只提供新隔离安装路径，没有自动迁移。用户本机若有旧 Home，先按此限制选择新 Home，不覆盖原有数据。
- [ ] Terminal Space 尚未实施，另行设计与授权。

# 2026-10-09 跨 Space 消息总线第一阶段（历史阶段记录）

按用户授权在云端实现最小请求／响应总线，不推送、不 PR、不合并、不部署。接口与验收见 [第一阶段说明](../docs/message-bus/phase-one.md)。基线 `c8e831e970f5b9ac64c8a7be527bdd42cd69ed53`。

- [x] 复用 Supervisor 私有子进程 IPC，身份绑定实际会话；目标操作精确 Space 白名单，默认拒绝，无新凭据或监听端口。
- [x] 异步请求／响应、超时／迟到、并发、防伪及同名重启隔离、退出／断开资源清理；不重试、不回放、不承诺超时即未执行。
- [x] 新增通信与真实 Supervisor/Cordis 最小 Host 集成 10 项通过；关联组合 41/41，spaces 139 通过／3 跳过；类型检查和完整构建通过。
- [x] 完整 workbench 511 通过／5 失败；5 项均在未修改基线的对应文件重现（80 通过／5 失败），不宣称全套绿色。
- [ ] 停在第一阶段供评审；静态能力查询、Browser 及其它后续阶段未开始。官方完整 Host／发行包／多平台验收未运行。

# 2026-10-09 Blueprint 归属与 DSH 0.2 迁移

用户授权把独立蓝图插件迁回本仓库；蓝图保持独立使用，Spaces 依赖蓝图完成空间创建和配方导入导出。随后明确统一升级到 DSH 0.2，并在独立 Web 复测通过后授权本地提交。范围、实现与验收进度见[迁移记录](archive/blueprint-migration-0.2.md)。未授权推送、发布或写入真实 Home。

- [x] 源码归属迁回、独立包仓库外安装、v1/v2 共享协议及 DSH 0.2.0-rc.2 适配。
- [x] 构建、针对性回归、独立复核与真实 Web 创建／导出／复制／分享码和 JSON 导入通过。
- [x] 修正动态配置准入、历史任务结果串线、包校验原因丢失、嵌套页面复制权限和长码截断。
- [x] 独立 Web 复测通过，迁移改动与验收记录纳入用户授权的本地提交。
- [ ] 推送、发布、生产 Home 迁移及安装版 Desktop 验证不属于本次本地提交。


更早的记录见 [archive/todo-history.md](archive/todo-history.md)。
