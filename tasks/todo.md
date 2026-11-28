# DSH Spaces 维护待办

> 只列当前仍需跟踪的事项。完整日期日志和已关闭条目在 [tasks/archive](archive/README.md)，不要在这里追加长日志。

## 2026-11-27 仓库 pnpm 迁移

- [x] 仓库开发、CI 与打包预检迁移到 pnpm 10.29.2；蓝图包使用 workspace 链接，Windows CI 在 install 前规范化 TEMP，npm 子进程不继承 pnpm 的 node-linker。

## 2026-11-27 故障范围收窄：portal 可见时 deadline 与子空间独立渲染进程

背景：2026-11-27 18:38 Desktop 门户 `state-request` / `portal/request-deadline`（HTTP 200 但响应体未读完），发生在 Windows 息屏（Kernel-Power 566）后约 12 秒；Supervisor 与各空间进程均存活。

- [x] Desktop Supervisor portal 的 `state`/`view` 10 秒请求期限只累计页面可见时间；首个状态握手即使页面 hidden 也会发出，已有快照后的隐藏 tick 不发起新的状态轮询，重新可见时恢复正常轮询；耗尽剩余可见预算仍按原路径终态失败，不重试。
- [x] 前端失败报告补充有界 `visibility`（当前状态与最近变化时间），`host.client-failed` 日志上下文记录 `visibilityState`/`visibilityChangedAt`；缺失证据时记录 `null`。
- [ ] 真实 Desktop 待验：息屏/Modern Standby 时 Electron webview 是否真的报告 hidden；下一次同类失败看 `visibilityState`/`visibilityChangedAt`。
- [x] 在本机 Electron 44.7.0 实验中观察到同站异端口 iframe 带 `Origin-Agent-Cluster: ?1` 会进入独立渲染进程并脱离 P0 主线程；首个带头的 P3 文档导航到无头路径后仍保持独立进程。默认 sandbox 在此环境退出，实验使用 `--no-sandbox`；原始数据留在 `.sandbox/exp-oac/`。
- [ ] 普通子空间视图首个文档改为 view-bridge 入口路由 `/__dsh-spaces/view-entry`（带 `Origin-Agent-Cluster: ?1`，再 `location.replace("/")`），使子空间页面崩溃或长任务不再拖垮 portal/manager；管理空间保持 `/`。子空间 OOPIF 崩溃目前只在该空间位置显示崩溃页，框架不感知也不留证，另需设计。真实 Desktop 待验。
- [x] 结论：原生外层 90 秒 `selection-timeout` 保持框架级失败，不收窄到目标空间。portal 内层 35 秒选择期限已按空间返回 `selection-rejected`；外层只在 guest/portal 自身无应答时触发，归属到目标空间属于猜测。

## 2026-11-24 Desktop 桥接诊断、热重载生命周期与仅前端重载

- [x] 修复 Desktop `shell.overlay` 在 `patchReload: "live"` 重挂载后复用已释放前端控制器或回退到旧引用的问题（`disposedBeforeTerminal` + `onControllerChange`）；保留终态失败/停机状态。
- [x] 新增 `workbenchGuide/reportClientFailure` 与 `WorkbenchRemoteError` 传输上下文（含 `hostRpcFailed` 提示与断线重连后一次性落盘），将前端 RPC 闪断、`<webview>` 崩溃/加载失败、门户 `#failed` 与有界 `navDiag` 轨迹记入 `host.jsonl`。
- [x] 在 Desktop 错误页新增用户授权的手动仅前端“重新加载空间界面”入口（只读校验 `role`、`desktopLaunchState` 与 `presentationSnapshot` 后以只读模式重挂控制器，不启停后端或子空间）；更新 `let-it-crash.md`、`AGENTS.md`、`architecture.md`、`workbench.md`、`CHANGELOG.md`，真实 Desktop 实机表现待下一次宿主重载/故障验证。
- [x] 对齐原生宿主外层选择超时至 `90s`（覆盖 `15s + 35s + 35s` 合法冷启动路径）并在超时详情附带最近 `navDiag` 阶段摘要；受控 `WorkbenchApp` 禁用 `localStorage` 旧空间自动恢复，并去重 `view-bridge` 重复 `"ready"` 上报。
- [x] 侧边条按空间展示运行与待处理光效：主空间（`workbenchGuide/hostActivity`）与子空间（view-bridge IPC `attention` + `working`）均只在各自侧边条按钮上绘制绿光（运行任务）或黄光（待审批/待提问，黄光优先），移除全屏与整条侧栏光条，真实 Desktop 实机表现待验证。

## 2026-11-22 审查修复批次

- [x] 主空间模型同步改为经绑定宿主 `dsh-app-boot` 进程内只读合成 `--dump-config`（不写主 profile），覆盖被官方 CLI 拒绝的 `desktop` profile；真实 Desktop 待验。
- [x] Creator/维护批安装接受 `installSpecFor` 生成的精确 GitHub 子目录 spec（`#<commit>&path:/<sub>`），新增严格专用校验器 `isExactGithubInstallSpec`，Windows 上低于 `ARGV_PRESERVING_CLI` 的旧 CLI 拒绝 `&` 形式；通用 `isSafeSpec` 未放宽。
- [x] 两个测试修正：`portable-host-dom` 按 `data-reason="primary"` 精确断言并核对失败时间行；`blueprint-v2-runtime` 改从绑定安装的 optional-bundle catalog 派生断言，移除对已退役 bundle 名的硬编码。
- [x] Desktop 宿主热重载：新插件实例加入既有 launch record 时等待 ready 后仅 attach（`attachJoinedLaunch`/`attachReadyService`），主空间注册在同一 Supervisor epoch 恢复，不重复 launch；attach 失败落诊断并标记 record。
- [x] `unlockDead` 在 lock 目录删除失败时同步清理 reclaim 标记（与 `home-lease.reclaimDead` 一致），后续尝试不再永久报 `reclaim-in-progress`；锁仍按占有保持阻塞。
- [x] Workbench 关机确认修复：submit 返回 queued/running 时继续只读 job 至 terminal；failed/cancelled 恢复普通轮询并显示错误，读取失败保留 unconfirmed 提示而非错误页。
- [x] 分享导出扫描只拒 `apiKey` 字面量，`apiKeyEnv: <env 名>` 合法；托管引用与 `sk-` 字面量仍由各自模式拦截。
- [x] Workbench 不再为组件载荷包（`@dsh-spaces/view-bridge` 等 `SPACES_COMPONENT_PACKAGES`）请求 npm 版本，普通第三方插件请求保留。
- [x] 未处理 Promise 缺口补 `.catch`：`plugin.ts` 的 `bootstrap()` 与 Supervisor 两处 `whenIdle().then(afterPlanJobSettled)`，失败仅记诊断，不重试不改状态。
- [x] 诊断降噪：成功只读轮询（`state`/`startupStatus`/`job`）不再写 `request.started/completed` 与 `http.completed`；失败与变更请求保留；子进程 stderr 行由 `error` 改 `info` 并带 `stream:"stderr"`，异常退出仍为 `error`。
- [x] 托管组件包 `@dsh-spaces/view-bridge` 与 `@klarkxy/dsh-dev-index` 纳入 `PROTECTED_PLUGIN_PACKAGES`：插件列表标记 protected，安装/移除/启停在预览期即拒绝，离线移除、启停别名与精确来源安装同步拒绝；此前运行中移除 dev-index 可进入执行并在子空间 pluginManager 处才失败。
- [x] live 插件操作在变更到达子空间前被拒绝（protected/invalid-input/not-found/代次冲突等确定性 `ControlPublicError`）映射为普通任务错误码，不再被 `workbench/failed` 误当不确定副作用锁存全库维护 flag（该 flag 会连带阻止错误页手动服务重启）；`control/unavailable`/`control/failed` 仍按不确定处理。
- [x] 插件批次失败标题由"启动失败"改为"插件操作失败"（`formatWorkbenchFailure` 新增 `verb`）；空间启停标题不变。

## 2026-11-14 推送前审查

- [x] 修正宿主状态字段、Desktop 启动范围、异常退出与密钥日志、模型路由替换、插件部分结果和界面刷新；复用 dsh-plugins 发布目录并核对 14 个 npm bundle。全量检查通过，最终补丁验证见 [审查记录](archive/review-20261114.md)；真实宿主待验事项保持下列状态。

## 本地诊断轮换日志

- [x] 2026-11-16 停止超时修正：单次协作停止窗口改为 30 秒，延迟退出按具体进程记录，保留失败作业和服务运行权；6 项新增回归、完整检查各组及最终受影响组复核通过。见 [记录](archive/stop-timeout-20261116.md)。
- [ ] 应用上述修复后的真实重启：旧 Supervisor PID `44488` 在子空间全部退出后仍持有失败运行权，正常关闭入口已失效；待用户明确允许一次性结束此旧进程，不能绕过既定禁止强杀边界。见同一记录。

- [x] 实现本地 `debug` / `info` / `error` / `fault` JSONL 日志，位于 Home 的 `.dsh-spaces-control/logs/`，按 7 天/100 MiB 轮换并清理归档，分发构建默认从 `info` 开始。不自动恢复或重启。
- [x] 修复正式 `~/.dsh` 下诊断日志误触发真实 Home 拒绝保护：为 `RotatingDiagnosticLogger`、宿主插件/启动引导及 Supervisor CLI 入口透传 `allowRealHome`，保持未确认宿主身份不落盘与默认测试保护不变。
- [x] 宕机排查：错误页补全传输原因/Supervisor 存活事实/失败时间，宿主 guide 失败写日志，Supervisor keepAlive 65s，日志轮换改按磁盘状态；终态语义不变
- [ ] 在真实 Desktop 中验收日志落盘、宿主日志导出和进程故障留痕；隔离自动化与发布预检不等同于实机验收。

## 发布与真实宿主验收

- [x] 纠正 Git 安装入口：根包自动 prepare 并分发完整组件，用户直接提供 Git 仓库根地址即可。隔离官方 Git 安装与生命周期、单命令构建授权和相关回归通过；公开仓库验收接入 CI。见 [实施记录](archive/git-root-install-20261114.md)。

- [x] 主插件改名为 `dsh-spaces`：代码与文档已统一，旧包继续受保护，换名走显式卸载/安装；完整检查与官方 CLI 双 profile 换名验证通过，见 [改名记录](archive/package-name-20261114.md)。

- [x] 公共插件目录由本仓库维护，开放独立作者贡献，支持按 npm 包名安装和版本限定的实测说明。见 [实施记录](archive/community-catalog-publishing-20261114.md)。
- [x] 清理当前发布流程并统一 Git 源码构建安装说明，保留目录与本地打包；完整检查中的浏览器禁用端口问题已修正，受影响组 27/27 通过。见 [清理记录](archive/git-install-cleanup-20261114.md)。
- [x] 配置 GitHub Release 自动检查、打包、npm 发布和公开归档核对，保存仓库 `NPM_TOKEN` Secret；修正独立 Browser 版本校验后，远端 Node 24/26 与真实 Web 验收通过。维护说明见 [npm 发布](../docs/npm-publishing.md)。
- [ ] `dsh-spaces@0.5.0` 首次 npm 发布请求已接受，但注册表仍为 `0.0.0-stage` 占位，真实版本公开及 npm 安装验收待完成。GitHub Release 归档已发布且下载字节一致，首轮自动流程和本机提交证据见 [发布记录](archive/npm-release-20261114.md)。不重复提交。
- [ ] 2027 年 1 月前完成 npm Trusted Publisher 的交互式 2FA 配置并切换 OIDC；工作流和发布脚本已支持，当前仍使用有有效期的 token。见 [凭据维护](../docs/npm-publishing.md#切换到-trusted-publishing)。

- [ ] dsh² 个人工作宇宙后续验收：八空间/十三次插件安装完成，六个前端可展示，两组合加载失败；实机素材已交付。仍需定位 `settingsScope`、pixel-whale 模块注册、长期门户超时及基础测试 45 个失败条目；主空间总控/模型同步本轮未验。见 [实机记录](archive/dsh2-personal-web-20261110.md)，不视为全量通过。

- [ ] 最终 0.5.0 制品验收：按错误页现有预览/确认流程完成一次真实服务重启（旧 space-control bundle 清理后的实际服务重启仍未执行）。见 [归档记录](archive/todo-2026-11.md) 2026-11-09 管理空间残留旧 space-control bundle。
- [ ] 最终 0.5.0 制品验收：真实 Desktop 加载后的删除/新建验收；失败空间与作业保留，不自动补配置或重放。见 [归档记录](archive/todo-2026-11.md) 2026-11-09 新空间无模型与自定义图标同屏报插件路径错误。
- [ ] 主空间模型配置一次性同步（删除 `@dsh-spaces/llm-bridge` 与实时 LLM 委派）：原有一次性同步已完成隔离 `dsh web` 验收；批次 1 的运行中免停机同步、下一次请求生效和摘要预览仍需在真实 Desktop 与隔离实例实测，旧空间首次启动卸载退役包同样待验。
- [ ] 空间注意光晕：三种空间栏按 `dsh-spaces:space-attention` 通道投影待审批/待提问状态；已有空间的 view-bridge 需按新组件组重新对齐才会上报（此前为 `unknown`、无光晕），真实 Desktop 尚未实测。
- [ ] 真实 Desktop EXE 与 `cordis` 会话内的 `spaces_plan` / `spaces_execute` / `spaces_ui_*` 审批端到端尚未实测。见 [归档记录](archive/todo-2026-11.md) 2026-11-09 主空间空间总控插件设计。
- [ ] `plugin.live.*` 对真实子 DSH 进程（真实 cookie 交换 + 真实 `pluginManager`）的端到端冒烟尚未执行。见 [归档记录](archive/todo-2026-11.md) 2026-11-09 主空间空间总控插件设计。

## 2026-11-10 文案与文档维护态收敛

- [x] 文案修正与润色：修正 Desktop 服务操作提示 `serviceMainSpaceNote`、工作台设置页 `settings.shutdownVsExit`、`errors.profileExists`、Creator 工具 `modelSource` 描述及 `spaces_inspect` `model` 区段描述中残留的旧模型委派与旧退出语义。
- [x] 文档维护态归档与对齐：将空间总控三份早期设计原稿归档至 `docs/archive/space-control-*-20261109.md`，重写 [docs/space-control-design.md](../docs/space-control-design.md) 为现行维护态契约；对齐 [REQUIREMENTS.md](../REQUIREMENTS.md)、[README.md](../README.md)、[CHANGELOG.md](../CHANGELOG.md)、[docs/workbench.md](../docs/workbench.md)、[docs/releases/v0.5.0.md](../docs/releases/v0.5.0.md)、[tasks/merge-contract-v2.md](merge-contract-v2.md)、[tasks/workbench-contract.md](workbench-contract.md) 与包内文档，清理现行文档中的未跟踪本地沙箱路径引用。

- [x] 按用户要求修订 `AGENTS.md` 的真实 `.dsh` 边界：允许只读诊断，直接写入需明确授权，正常授权启动及应用自身的正常运行写入不算违规；开发与测试继续使用隔离 Home。

## Spaces 易用性整改后续批次

- [ ] 每个空间的“打开 Desktop 时启动”：已完成代码与隔离自动化验证，真实 Desktop 待验。默认关闭；开启的空间在管理服务就绪后各自启动一次，失败不重试。
- [x] 批次 2（免停机插件、目标空间计划校验与按空间排队，已完成代码与自动化验证，真实宿主待验）：运行中空间的插件安装/移除/启停改为经子空间 `pluginManager` 免停机应用，需重启时提示用户选择“立即重启”或“稍后自行重启”；工作台空间级计划改为只校验目标空间指纹与代次并在入队时核验 TTL（`/control` 全库修订约束保持不变）；工作台忙碌状态改为按受影响空间计算，无关空间可提交排队并展示“排队中”。
- [x] 批次 3（设置页 6 项人性化收敛，已完成代码与自动化验证，真实宿主待验）：包来源与目录地址移至“常规”并补齐未保存状态判断；插件目录按用途分类、提供一键安装与就地选版本、收敛已装插件移除菜单；空间列表行点击直达详情并收纳排序菜单，内部 ID 下放“高级”、仅在检测到误装管理包时显示清理入口、补齐诊断手动重新读取与删除空间时的数据清理勾选项；新建空间改为显示名称优先并自动生成标识、提供创建后直接启动开关与折叠高级选项；封存期间导入提示与选择器统一面向 `.dshspace` 且保存本机模板简化为单一名称；常见任务进度中文化并补充备份离线目录说明。
- [x] 批次 4（设置页结构与入口收敛，已完成代码与自动化验证，真实宿主待验）：统一空间右键与行尾 `⋯` 菜单（空间设置、启停重启、导出分享文件、存为模板、上下移动、重命名、换图标、删除）并移除空间详情页重复导出卡片；Desktop 原生空间栏右键新增“打开空间设置”直达目标空间详情；新建空间对话框整合“空白 / 从模板 / 从文件导入”三模式，“模板”页收敛为已存本机模板的使用与删除；设置页左侧导航收敛为“空间 / 模板 / 通用 / 维护”四项，低频服务配置收入“通用 → 高级”折叠区，状态、任务、备份、运行时、日志与停止服务合并至“维护”。
- [x] 界面文案精简与润色（已完成代码与自动化验证，真实宿主待验）：移除 Desktop 侧边栏说明弹窗及服务确认冗余附注，移除工作台待机页、新建空间、模型卡片、插件区、诊断区、模板页与维护页中的重复说明段落，统一并收紧中英文提示、状态与错误措辞。
- [x] 维护子页签与原生视觉收敛（已完成代码与自动化验证，真实宿主待验）：“维护”页拆分为“状态与任务 / 备份 / DSH 版本 / 服务”四个横向子页签并去重空状态重复按钮；空间详情返回改为无框 `←` 图标按钮，“预览切换/安装/删除”精简为“切换/安装/删除”；工作台移除多余圆角卡片、紫色渐变与发光阴影，改用 `0.5px` 细分割线扁平分组与官方 `--dsw-*` 原生主题变量。
- [ ] 后续状态与反馈细化（待评估）：进一步细分读取失败、写入失败、重启失败与旧版 API 不支持颗粒度。

## 已跟踪问题

- [ ] 并发 lease 回收用例曾在 `reclaim` 路径竞争期间触发 `assertMissingEntry` 安全拒绝，后续完整检查通过；未修改锁策略，仍需单独评估该计时敏感用例。见 [改名验证记录](archive/package-name-20261114.md)。

- [ ] 官方 Desktop 的本机认证 Cookie 累积可使欢迎页请求返回 HTTP 431，却显示 `Web authentication failed`。2026-11-10 已备份并定向清理 71 个无监听端口的旧 Cookie；隔离同目录 431→200 对照通过，真实 `.dsh` 未写、日常启动未代验，官方累积机制未改。见 [诊断与处置记录](archive/desktop-auth-cookie-20261110.md)。
- [ ] 首次管理页导航/35 秒就绪超时根因未确认；不将后续成功样本视为修复。见 [归档记录](archive/todo-2026-11.md) 2026-11-02 首次导航诊断、2026-11-02 前一轮首次管理页超时、2026-11-02 Desktop 后台启动条目。
- [ ] `MAIN_REGISTRATION_REFUSED:400` 原始根因未确定；补丁加载后的实际拒绝码仍待确认。见 [归档记录](archive/todo-2026-11.md) 2026-11-08 Desktop 主空间注册 400 诊断。
- [ ] `attachReady` 监听器失败后本纪元控制工具不可用，`workbench/unavailable` 无法区分“未接入”和“不可用”。见 [归档记录](archive/todo-2026-11.md) 2026-11-09 主空间空间总控插件设计。
- [ ] 长时间 UI 探针中的浏览器侧 DNS 停顿、`read.deadline`、`portal/transport-failed` 仍未归因。见 [归档记录](archive/todo-2026-11.md) 旧阶段仍未关闭的条目（2026-10-15、2026-10-14）。
- [ ] 负载下的计时敏感用例（launch token、端口分配、`workbench-plugin` portal startup observation “unavailable” 变体）仍可能偶发失败，根因未查；`dashboard-supervisor` 测试已不存在，blueprint `native.test.mjs` 现先等待 `listening` 再读端口，未做负载复测。另有 Linux `taskkill` 挂起记录。见 [归档记录](archive/todo-2026-11.md) 2026-10-12 清理与结构拆分、2026-10-09 精简 MVP。
- [ ] Web 拒绝嵌入提示不完整：实际页面主要为浏览器破损图标和通用预览文案。见 [归档记录](archive/todo-2026-11.md) 旧阶段仍未关闭的条目（2026-10-09）。
- [ ] Terminal Space 尚未实施，另行设计与授权。见 [归档记录](archive/todo-2026-11.md) 旧阶段仍未关闭的条目（2026-10-09）。
