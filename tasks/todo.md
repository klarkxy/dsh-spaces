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
- [x] P2 按空间固定版本（已定决策，未实现）：每个空间固定精确的 DSH 运行时版本，官方基础插件（dsh-base / dsh-web-app）内置于运行时并随之变化，Spaces 不向 profile 安装；第三方插件安装与升级只接受精确版本。升级在空间设置中由用户发起，版本来源为插件库与 npm。已有空间首次启动时固定为当前实际使用的版本；新空间默认宿主的 DSH 版本。切换前不自动建快照，禁止降级。管理空间（spaces-hub）跟随宿主 CLI。Spaces 声明支持的 DSH 最低版本，桥接必须兼容整个范围；低于最低版本的空间启动失败并提示到空间设置升级。删除全局 runtime.install / runtime.upgrade 与协调升级。提供用户触发的删除未使用运行时（`f1e8a90`、`74ea256`、`cddabe9`、`86d51bf`）。
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
