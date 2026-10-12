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
- [ ] `WorkbenchSupervisorRuntime` 仍约 2000 行，计划执行与生命周期管线未拆。

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
