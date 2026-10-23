# 2026-10-23 架构梳理与第一波重构

- [x] 全仓只读架构测绘：包边界双向依赖（src↔packages）、shared 上指 core/domain、god 文件、supervisor/spaces-control 一词多义、WorkbenchApi 三处手写为主要别扭点；六边形分层在 src 内部成立、在包边界断裂。
- [x] 既有 2026-10-20→22 工作流先落本地基线 `a213321`（用户授权本地提交；不推送）。
- [x] 用户决定整包移除已封存看板：删除 packages/dashboard、core/domain/dashboard、adapters/node/dashboard、门户 `@dashboard` 目标与发布计划、工作台视图与封存开关、private-files、docs/dashboard 与 DASHBOARD.md、18 测试、9 脚本、6 工作流、3 tsconfig；Home 回到纯聊天面，Home overlay 随看板一并移除。历史文档（tasks/**、docs/plans/**、host/implementation.md、message-bus/phase-one.md）原样冻结，能力可从 git 历史找回。
- [x] 分层 DAG 修复：supervisor 端点格式移入 src/adapters/node、loopback 解析移入 src/shared，LLM activity 协议移入 src/shared（llm-bridge 再导出），llm-share/llm-connections 下移 src/shared（selectSharedConnections 经 core/domain/llm-resolution 再导出），孤儿 @dsh-spaces/core 整包删除，客户端构建守卫由失效的 src/main 改拦 src/adapters 与 src/shared/node。
- [x] 合并树验证：check:test-lists、typecheck（node/web/spaces/tests）、build 与 test／spaces／workbench／workbench:recovery／llm／blueprints／browser 全绿。仅本地提交，不推送。
- [ ] 第二波：src/adapters/node 按领域拆目录（home／llm／blueprint／maintenance／products／runtime／snapshots／server／diagnostics／payload／profile），进行中。

# 2026-10-22 Desktop UI 链接安装与手动服务操作

- [x] 用户明确授权错误页“确认受影响空间后手动重启服务”。已实现认证预览、一次性确认、正常停机完成后单次启动；只对确认的 Desktop 开放，不自动重试、不强杀、不清证据、不重启子空间或续跑任务。同步有限政策例外。
- [x] 官方安装版 Desktop 先启动空白环境，再通过插件 UI 链接仓库并启用，首次／重开注册均 200。另用旧服务＋新链接插件复现 404；手动预览取消不改变服务，确认后同一个 Desktop 注册 404→200、main 草稿保留、设置可用、运行中测试子空间保持停止。服务正常停止后的手动启动也通过。
- [x] 完整 15 组首次 14 通过；spaces 旧方法清单断言修正后整组 148 通过／1 跳过。工作台 573／2 跳过、LLM 123、Chromium 15 均通过，类型／构建／包预检通过；原失败保留。隔离实例已正常关闭，官方文件哈希保持，功能验收期间 7 个非测试进程身份保持。未操作真实 Home，未提交推送：[验收报告](manual-service-restart-20261022.md)。

# 2026-10-22 Desktop 启动保留 main

- [x] 用户追加独立官方 Desktop 调试后，四个新隔离 Home 实测并修复首次注册时序：Supervisor 初始化时原注册返回 400，现先只读等待管理器就绪再首次注册；失败不注册、不重试。修复包首次初始化／正常重开均各一次 200，同服务纪元与 manager generation 不变，main／草稿保持。
- [x] 另用旧包启动隔离 Supervisor，仅升级该测试 Desktop profile 后复现真实 `MAIN_REGISTRATION_REFUSED:404`；新版 main 保持可输入，设置详情保留错误，返回草稿不丢，无重试。未读取真实 Home，不能据此确定用户实际服务版本。
- [x] 追加专项 9/9；新一轮完整检查 14/15 组通过，默认组一项子进程提前退出单独复查通过；工作台 558 通过／2 跳过，LLM 122/122，Chromium 13/13。全部测试实例正常退出，原有 7 个 Desktop 进程身份和官方文件哈希保持，未提交推送：[实机报告](main-startup-desktop-20261022.md)。
- [x] 修复后台发现／启动失败无条件打开整页错误面板：默认保留当前 main；只有正在使用或明确打开 Spaces 页面时才立即显示错误。设置入口标明服务不可用，可查看原始详情；错误终态、不重试、不重启及原生 guest 释放保持不变。
- [x] 回归覆盖 `MAIN_REGISTRATION_REFUSED:404`、连接未结束时打开设置、后台轮询失败、显式页面失败；Chromium 实际验证 main 输入、原 DOM 和草稿保留、查看详情／返回以及失败后不重连。工作台 555 通过／2 跳过，浏览器交互 13/13。
- [x] Node 26.10.0、官方 rc.2 SDK 与仓库外临时根下运行完整 15 组：14 组通过，默认测试 269 通过／1 项进程 API 启动超时；原测试不改超时单独复查 1/1 通过。三组类型、构建、包预检通过，首次失败保留：[完整记录](../.sandbox/main-startup-checks-20261022/result.json)、[超时复查](../.sandbox/main-startup-checks-20261022/process-manager-timeout-recheck.log)。
- [x] 首轮仅为源码／构建及隔离 Chromium 验证；后来追加的官方安装版 Desktop 验证见上。两轮均未操作真实 Home 或重启用户服务，用户当前 404 实例的实际服务版本尚未确认。未提交、推送或发布。

# 2026-10-22 全仓审查五项问题修复

- [x] 修复聊天 `01a160ff-8a2d-72f0-bb39-52b394669293` 的 1 项 P1、4 项 P2：ZIP 读取在载荷复制前检查累计大小、目录/本地头范围及重叠引用，解析复用同一验证结果；空间绑定按空间隔离异步结果与编辑状态，应用选择限制为当前可见且 observation 完整的空间；会话授权按准备请求引用计数并释放，已准备/在途 lease 独立持有授权；同步/异步原子 rename 均单次执行，传播首次失败。
- [x] 回归覆盖恶意 ZIP 零载荷复制、正常分享导入导出、迟到读写、详情页与不完整 observation、300 个顺序授权及并发引用、准备失败释放、释放后 stream/图片有效、三类 Windows 首次 rename 错误。ZIP 独立安全复审未发现可证实绕过或兼容回归。
- [x] Node 26.10.0、rc.2 SDK、仓库外隔离临时根下，完整 15 项检查通过：[机器结果](../.sandbox/review-fixes-checks-final-20261022/result.json)。规定八组 1,675 通过、0 失败、8 项既有条件跳过，工作台 Chromium 12/12；额外 LLM Chromium 2/2。最后源码的类型复查通过，重新构建后的包预检与 LLM 122/122 通过：[补充结果](../.sandbox/review-fixes-checks-final-20261022/post-edit-result.json)。早期沙箱 EPERM、测试夹具类型及延迟断言失败保留于工具记录和首轮检查目录，不覆盖历史失败。
- [x] 保留既有未提交工作；未提交、推送、发布、部署或访问真实 Home。本轮是源码、打包与隔离交互验证，不关闭既有 S1/P0/P1、安装版 Desktop 或持续运行门槛。

# 2026-10-21 当前版本收口与主空间 LLM 继承施工

- [x] 2026-10-22 检查收口：三份文件已查明为 S0 既有删除，上一轮审计误读 deleted:true，已保留原文并纠正；worker/包预检改为目录持有 Node 写入内存构建结果，针对性 12/12 与包预检通过。完整检查 15/15 已通过，指定 Astra 最终独立复核 READY（仅本轮检查收口）。[本轮报告](../docs/plans/verification-closeout-results-20261022.md)。SDK 不动，不提交推送。

- [x] 2026-10-22 正式标题／手动与自动压缩接入完成；Astra 首轮 R1 自动失败吞错、R2 过早绑定拒绝已修。最终五组运行 42 项通过（自动 500／开始前失败各 6、正式手动 14、自动成功 5、Magpie 11），MiniMax 最终 8 次请求均 200；LLM 120/120。15 项检查 12 通过，workbench/recovery/包预检仍为临时文件 Access is denied。指定 Astra 最终独立复核 READY（仅本轮固定 SDK 有界阶段）；[本轮报告](../docs/plans/llm-auxiliary-results-20261022.md)。SDK 不动，不提交推送，不关闭 S1/P0/完整 P1/Desktop 门槛。

- [x] 用户追加正式主插件/facade、模型发现与 controls、普通创建真实 Agent/UI 验证授权。本轮已接入：默认/明确模型、reasoning 来源、图像工具、DeepSeek 多轮、运行中新增 provider 与 500 单次失败，最终真实 Supervisor/官方 Web/正式包新 Home 14/14；LLM 117/117、integration 21/21、browser 1/1。Astra 首轮三项 proposal/取消/初始化清理缺口已修并复验，最终独立复核 READY（仅本阶段）。[阶段报告](../docs/plans/llm-formal-plugin-agent-ui-results-20261021.md)；证据 `plugin-main-facade-1/run-2026-10-21T15-32-02-483Z/RESULT.json`。完整检查仍四项失败且保留原日志，SDK 不动，不提交推送，不关闭 S1/P0/完整 P1/Desktop。

- [x] 用户追加正式 Supervisor 注册认证、图像与 DeepSeek 集成授权；已接入实际 Supervisor/所有权与真实子进程 IPC，官方 CLI 主服务加载原 pi-ai/DeepSeek 插件，图像 Files/工具/多轮/JSONL 重开与故障共 31 项通过。[本轮报告](../docs/plans/llm-supervisor-images-deepseek-results-20261021.md)；最终证据 `p0-supervisor-images-deepseek-1/run-2026-10-21T13-26-02-756Z/RESULT.json`。Astra 三轮 REVISE 的取消及异步终结缺口均已修复，最终 Astra 独立复核 READY（仅本轮有界集成）；完整 15 项检查执行但 workbench/recovery/包预检有真实失败，详见报告。官方 SDK 不变，不提交推送，正式 UI/产品启用和 S1/P0/P1 门槛未闭合。

- [x] 用户追加下一阶段集成验证授权后，接通独立主进程＋两个子空间进程的认证 HTTP/NDJSON、真实官方 read 与权限、官方 JSONL 持久化及新进程多轮 replay；最终 26 项具名断言通过，指定 Astra 独立复核 READY（仅隔离集成范围）。首轮复核指出的取消/500 断言漏洞已修正，旧失败、新 Home、错误及落盘重读证据保留；[集成报告](../docs/plans/llm-plugin-integration-results-20261021.md)，最终证据 `p0-plugin-integration-1/run-2026-10-21T12-07-03-516Z/RESULT.json`。SDK 不变，817 个 S0 产品文件一致。

- [x] 用户批准 Astra 插件方向后执行三个阻断原型，完成 39 项具名核心断言与独立 Astra 复核：服务/来源 13、附件 13、公开准备 9、真实官方 CLI 补充 4。官方 SDK 未改，817 个非协调产品文件保持 S0；[结果报告](../docs/plans/llm-plugin-prototype-results-20261021.md)，机器索引 `.sandbox/construction-20261021/p0-plugin-proofs-1/SUMMARY-final.json`。仅有界核心可行性，不是完整 P0/契约/产品验收。
- [x] 原型修正了 Astra 初始装配推论：bundle patch `name` 为匹配校验，不能改名替换。采用子空间层禁用原服务条目、插入插件子类条目的公开组合；实际官方 Agent/标题执行器/压缩 summarize/计量服务接入。旧失败全部保留。
- [x] 补充真实负例：聊天默认 A→B 不重定向已选 A 的标题/压缩；主 policy 允许两次重试时，active 官方 retry 下真实子 Agent 500 仍单次；失去/撤销委派上下文时零主 store 读取。旧 proof3 retry 声明撤回，正确证据归最终 proof1。
- [ ] 前轮交付三个原型后，用户已授权并实际继续上述集成验证。正式 Supervisor 注册认证和图像/DeepSeek 网络链路已有上列源码与隔离证据；facade/UI controls 和正式标题/压缩进展见上列追加阶段，Files 失败政策、完整配额/流控及安装版 Desktop 仍待。S1/P0 不闭合，完整 P1 未放行，不提交推送。

- [x] Codex 接手只读核对 MiniMax 原生会话 `mvs_574730b0a4ae4c0687716738c79ce75c`、原始失败与 S0 摘要；817 个非协调文档产品文件与 S0 一致。当前 root 的 llm/pi-ai/attachment rc.2 源文件与既有隔离 SDK 相同，非新拉包认证。见 `.sandbox/construction-20261021/codex-takeover-2/SOURCE-AUDIT.json`。
- [x] 用户纠正执行边界：我们只是插件，不修改官方 SDK。撤销将上游接口实现列为下一步；旧 v0.2/Astra READY 保留为历史文档结论，不是当前施工批准。技术计划与提案已同步；不改 SDK、node_modules、官方安装包或凭据。
- [x] 插件公开 middleware 位置局部验证：真实 rc.2 `LlmRuntime` 的 prepared stream 在 `llm/stream` 中仍携带 file block 和原始 replay source，短路时未进入默认 adapter；`next()` 对照会投影文件并过滤异源 replay，原冻结请求不变。新目录 `codex-takeover-2/RESULT.json`，零供应商调用；第一次清理 API 错误保留于 `codex-takeover-1/FAILURE.json`。仅边界测试，不宣称真实 Agent、图像、G2/G3/G4 已过。
- [x] 官方 Agent 冻结前入口实证：使用既有隔离 rc.2 SDK 的官方 Agent loop、会话服务和测试 adapter，`agent/request` 异步返回的 reasoning/maxTokens 写入真实请求头，并用于唯一一次冻结派发。证据 `.sandbox/construction-20261021/codex-agent-request-1/RESULT.json`；内存会话、零供应商调用，不是主空间远端交接、真实 provider 多轮、图像或完整 G4 通过。
- [ ] 插件方案重新准入：用官方 `agent/request` 冻结前入口验证 controls/defaults 的交接与真实 Agent 关联；保留投影前文件授权和 replay 来源检查；验证公开服务组合的图像隔离，不猜关联、不运行中替换全局服务。不再等待或调用候选 SDK 方法。C01–C18 需重新映射实现位置，尚不冻结契约或放行 P1。

- [ ] 18:36 用户选择在普通终端执行单次检查脚本，结果目录待提供，S1 仍未闭合；不为等待结果创建提醒或重复运行。
- [x] 用户授权仅在本仓库形成最小官方接口设计，不改上游。[接口修订提案 v0.2](../docs/plans/llm-official-seam-proposal.md) 已完成并经指定 Astra 复审 READY（仅文档）：两阶段官方准备句柄、冻结前 controls provenance、请求级图像访问、子空间文件权威投影/manifest、虚拟 adapter replay 保真门及 C01–C18 验收要求。首轮 REVISE 的三项信息流缺口已修；SDK 可行性与 P0 未因此通过，候选接口未实现、capability 契约未冻结。

- [x] 用户授权按 [施工方案](../docs/plans/construction-20261021.md) 实施；无提交、推送或发布授权。S0 基线 `26aab5d`，120 个 tracked 改动、84 个未跟踪文件；源摘要和所有权表：`.sandbox/construction-20261021/s0-1/baseline.json`，已有改动保留。
- [ ] S0/S1a 环境与机器检查：Node 26.10.0、Chromium 已存在；SDK 为匹配锁定依赖的 `.sandbox/dsh-rc2-upgrade-20261018/sdk`。授权临时根 `H:/Code/dsh-spaces-checktmp` 中 Node 写入成功，当前会话和 Bridge 原生 esbuild 写入均被拒；原始单次探针保留。真实剩余三组已于 18:06 完成：workbench 546 pass/7 fail/2 skip，recovery 26 pass/5 fail，包预检 exit 1；失败均为外部临时 worker/validator 的 Access is denied，见 `s1a-checks-1/remaining-once/result.json` 和全日志。未修改 ACL、未提权、未换临时根，不将检查失败记成通过。
- [ ] S1b 官方 Desktop 四项验收：未启动本轮实机。指定 Astra 首次驱动复审 REVISE 后，已修订异常句柄、unknown owner、npm 包身份和启动次数判据；颜色改为 pending-visual-review，不自动判通过。父代理在授权外部临时根执行语法及静态检查均 exit 0，见 `s1b-desktop-1/REVIEW-FIX.md`；查询失败、fatal crash、视觉结论与正式包仍待。修订后未宣称独立验收 READY，不继承旧包结果。
- [x] 修订方案独立复审 READY（仅计划层）：保留用户原宿主作为主空间；官方 Web 专用非 web 验收 profile 与 Desktop desktop profile 均须预先隔离数据并检查 protected trees，不复制用户配置、不把管理器当主空间、不用夹具替代实际宿主。
- [ ] S1a 汇总：清单、三组类型、构建和七个独立测试脚本本轮通过，条件跳过逐项保留；三组真实失败见上，不再记为未执行。完整 runner 未一次性运行，不声明全量通过。原 `result.json`/`result-tests.json` 是各批当时状态，后续实际结果以 `result-remaining.json` 与 `remaining-once/result.json` 补充；不覆盖历史。主代理仅改三份 Markdown，产品源摘要保持 S0。Bridge files_changed 收集因失效旧 worktree 路径不可用，必须独立核对磁盘，未修复旧 worktree。
- [ ] 条件 P0 放行：S1a 剩余外部原生写权限阻塞已有实证，类型/构建通过，当前未发现该失败关联产品缺陷；允许在 `.sandbox/construction-20261021/p0-*` 进行不依赖该编译步骤的公开 API/受控 provider 原型。S1b 仍待真实 Desktop，S1 不闭合，P0 官方 host/UI 证据未通过也不闭合；P1 重新准入要求 S1a 全量和 S1b 四项全部通过、S2 摘要冻结、P0 四道门与契约冻结全部完成。

- [ ] P0 G2/G3 集成：Grok 原型返回 adapter harness G2 PASS/G3 BLOCKED；指定 Astra 复核为 FAIL（仅门槛声明），不接受生产门槛 PASS。G2 使用自行构造的 adapter/profiles Map，不是已运行主空间公开 generation；G3 现有官方图像 resolver 捕获插件 ctx 且无请求级读取参数，但原碰撞夹具不足以证明所有 scoped 附件方案不可行，文件 handle 投影另属未验证。原始 `p0-llm-1/RESULT.json` 保留，`CONTRACT.md` 只作历史提案，不冻结共享类型、不进入 P1；后续仅研究现有公开插件接法，不修改 SDK。
- [ ] P0 G1 Web 本轮 failed 且验收环境不合规：实际非 web 官方宿主、Spaces 链接插件、公开 LLM/默认模型/profile 服务存在；observer 的 loaderEntry 匹配为空后中止，鉴权/unary/dispose/原驱动退出后 protected-tree 检查未执行。记录于 `p0-host-1/RESULT.json`。父代理复核发现 `host.mjs:125-127` 将 TMP/TEMP/TMPDIR 设为仓库内 CACHE/tmp，违反外部临时根要求，本轮不作为合规 G1 通过证据。记录 PID 2476 已退出；父代理事后只读确认三个受保护目录仍不存在，另记补充审计不覆盖原结果。不重启失败环境；G1/G4 未闭合。

# 2026-10-20 前端动效重构与 Desktop 打开即启动

- [x] 四个界面（Workbench、宿主 Spaces 面板/外壳、Dashboard、Browser）引入 motion 14.4.0，共享 `src/shared/ui/` token 与动效原语；大文件拆分为 `workbench/view/`、`workbench/blueprint/`、`client/ui/`、`dashboard/src/ui/`、`browser/src/ui/`，导出、类名、aria 与文案保留。失败与提示内容不进入不透明入场动画；iframe 与原生视图占位不变换、不重挂。独立验收复核 READY。
- [x] 宿主栏主空间下加分割线；原生外壳失败后再点栏按钮重新显示已记录的失败（不重连）。
- [x] Desktop 打开时只读发现没有存活 Supervisor，本次打开发起一次受保护的启动；会话中失败不再启动，启动失败如实报告不重试。
- [x] `toolchain.json` 被宿主升级取代的绑定判为 stale（非维护证据），沿用其目录继续检查维护证据；损坏/不完整记录仍阻止退休。政策补入 `docs/let-it-crash.md`。
- [x] 设置页重整计划 [settings-ux-redesign](../docs/plans/settings-ux-redesign.md) 第 0 阶段：修复动效重写丢失的「保存服务设置」提交（加 DOM 回归断言并验证可抓住）；Desktop 设置整页铺满；确认弹窗显示空间显示名。第 1–3 阶段（D1–D4 按建议获批）：导航四组+折叠维护区；空间详情页替代诊断对话框；停止/重启非破坏性预览免确认；创建后自动进入；Desktop 侧栏「＋」经门户受控 intent 消息打开创建对话框；统一「空间模板」页（拖放导入、保守识别）；插件只在详情页，`plugin.versions` 只读接口 + 版本下拉（默认 npm latest 标签，否则最新稳定版）；术语统一、空状态 CTA、错误就近显示且来源界面不在屏幕时回落横幅。独立验收两轮 READY；全量检查除 3 组沙箱 esbuild 限制外通过。
- [x] 看板能力封存（2026-10-21，用户指示「先封存，等以后再唤醒」）：新增 `workbench/dashboard-sealed.ts` 的 `HOME_DASHBOARD_SEALED` 开关；Desktop 侧栏 ▦ 看板按钮隐藏（⚙ 设置保留），首页面只留聊天视图（落到首页即直进聊天），看板/发布授权视图与其数据会话不再开启。`@dashboard` 门户目标、仪表盘后端、发布 schema 与全部 dashboard 测试原样保留。唤醒＝把开关改回 false，回检 native-desktop 的 @dashboard 链路并重拍侧栏截图（settings-wa）。
- [ ] `test:workbench`、`test:workbench:recovery`、`check:plugin-package` 在会话沙箱中因 esbuild 原生子进程无法写仓库外临时目录而未验证；需在普通终端运行 `check:all`（2026-10-21 收尾轮在沙箱内复跑确认：除这三组已知失败外全绿，失败名单与上轮逐项一致）。真实 Desktop 尚待用户实测：打开即启动、侧栏「＋」、插件版本下拉，以及深色主题下侧栏配色——侧栏的 `--dsw-alias-*` / `--dsw-specific-*` 令牌由宿主应用提供、仓库夹具里只能回落浅色，真机深色表现要在实测中确认。
- [x] 设置页重整收尾（2026-10-21）：P6 闭合——空间列表行移除启停/重启/删除，只留进入/排序/管理，生命周期操作的权威位置为空间详情页，右键菜单为快捷方式；死代码 `SpaceActions` 删除。修复收尾测试暴露的缺陷：`runPreview` 直写 `commandPending` 不占用 `wrapDepth`，预览在途时一次并发的 wrap() 读取完成会把忙碌标志提前清除（详情页按钮在命令进行中提前解禁）；`runPreview` 现与 `wrap()` 共用同一计数，由更新后的禁用态用例覆盖。界面证据截图按最终用词与主题全部重拍（settings-wa/wp/w3c）：service 浅色截图不再是深色字节副本；Desktop 侧栏截图改用 `prefers-color-scheme` 机制（宿主外壳不听 `data-theme`）并修正浅色页底。`TemplatesShareTab` 死代码确认已清（全仓零引用）。`check:all` 复跑：除沙箱受限三组外全过（test 268/268、spaces 148、llm 100、blueprints 94+239、browser 13、dashboard 52+152、workbench:browser 12、workbench 546/555、recovery 26/31）。

# 2026-10-20 Node 24 与官方 Desktop Browser

- [x] 支持 Node 24.21+（24.x）和 26.x，统一运行时守卫、包 engines、工具链发现、类型基线和 CI 矩阵；不替换官方 Desktop 内置 Node。
- [x] 官方 Windows Desktop 0.2.1-rc.2 / Electron 44.7 / Node 24.21 安装版实际隔离 Home 验证：初始化、普通空间创建/进入/启动/重启、正常关闭重开、服务停机；代次 1→3，同一 Supervisor，无任务重放。
- [x] 用户追加授权的 Browser Space 官方原生适配：官方 lease、最外层 sandbox guest、认证 manager 展示通道、地址/标题同步、A/B/A 保留、隐藏释放、新分区和失败不重试。最终包在另一新 Home 实测，包括拒绝 iframe 的页面及实际 -312 导航失败。
- [x] 两版本八组汇总各 1600 通过 / 8 条件跳过，额外界面测试各 12/12；最后失败标签显示修正后，native 专项各 19/19、类型/构建/包预检及最终包实机通过。失败轮原样保留，详见 [完整记录](node24-desktop-20261020.md)。
- [x] 最终插件安装包已生成；实际安装内容核对、源文件冻结、既有脏文件与官方 EXE/ASAR 保留、正常停机无遗留进程/端口均有证据。不访问真实 Home，不提交、推送或发布。

# 2026-10-20 根目录本地链接调试

- [x] 修复两处导航问题：侧栏/portal 不再用缓存状态误拒绝已运行空间，manager 区分用户选择与加载 token，并沿用同目标在途认证。102 项相关回归及 11 项浏览器回归通过。
- [x] 新 Home 根目录软链接完整实测通过：初始化、创建、首次启动后立即双击、重启后缓存仍为 starting 时立即双击、重建宿主重开与正常停机；generation 1→3，manager/Supervisor 稳定，独立检查无遗留进程/监听。证据 `.sandbox/link-navigation-fix-20261020/run-1/`。
- [x] Windows async rename `EPERM` 根因已通过管理员文件跟踪确认：仓库内 TMP 的 staging 后代被 Codex 并发打开，Windows 拒绝整目录改名。新增 `check:all` 隔离并验证仓库外临时目录，未改运行时单次发布或加重试；普通用户仓库外 32/32 对照通过。授权管理员完整轮 15 项检查全部通过，规定八组 1,601 通过 / 0 失败 / 0 跳过，额外浏览器 11/11、包预检通过。原失败与受限沙箱原生构建写入失败均保留；详见 [根因与验收](runtime-eperm-20261020.md)。
- [x] 追加完整软链接 UI 验收：初始化、创建、启动、重启后页面显示，以及关闭宿主→重建→重开均通过；PID/generation 1→3、manager/Supervisor 稳定、注册和链接保留、正常停机与无遗留端口均有证据。最终轮为 `.sandbox/root-link-lifecycle-20261020/run-7/`，本轮无模型调用或产品源码修改。
- [x] 前轮两处导航失败已在上方追加修复及复验，原失败现场保留。正常重启仍有卸载旧页的空白间隙，不声明无缝切换或所有导航路径稳定。
- [x] 用户确认仓库根目录直接安装；私有根包暴露现有 `@dsh-spaces/plugin` 构建产物和 bundle，保留独立发行包及六组件契约。
- [x] `dev:web` / `dev:link` 使用独立 `spaces-dev` profile 和持久调试 Home，复用目录链接，不打包、重装或清空调试数据；Windows 默认 CLI 发现通过。
- [x] 官方 0.2.1-rc.2 实跑根目录 `add .`、链接配置层、浏览器工作台入口，以及重复构建的数据/配置/链接保留。清单、三组类型、构建、八组测试（1,587 通过、7 项条件跳过）及包预检通过。
- [x] 保留原有未提交工作；不提交、推送、发布，不访问真实 Home 或写入 `profiles/web`。本轮没有执行完整初始化或安装版 Desktop 验收。

详见[实现与验收记录](local-link-debug-20261020.md)。

# 2026-10-18 DSH 0.2.1-rc.2 升级

- [x] SDK、锁文件、新安装默认 CLI、配套 Cordis/loader/Schemastery、CI 和有效说明对齐官方 rc.2；Spaces 保持 0.4.0，最低支持版本和已有空间 pin 不变。
- [x] 适配新旧宿主兼容性结果、按目标版本处理 engines.dsh 优先级、逐包检查与切换前复查；统一 LLM 版本常量和响应校验，补齐真实传输回归。
- [x] Node 26.10.0 下清单、三组类型、构建通过；八组规定测试最终 1,585 通过、7 项平台权限跳过；额外 Chromium 11/11、旧宿主兼容回归 44/44。独立 Astra 审查 READY。
- [x] 最终插件包在全新官方 rc.2 Home 完成安装、UI 初始化、创建/进入/重启空间、重开、停机与卸载；没有模型调用、强制清理或遗留端口。
- [ ] 保留早期 Windows 临时文件与并行启动偶发失败证据，后者根因未判定；不关闭历史持续 UI 调查，也不将官方 Web 验收写成安装版 Desktop 验收。

详见 [升级与验收记录](dsh-rc2-upgrade-20261018.md)。原有未提交工作保留，未提交、推送、发布或访问真实 Home。

# 2026-10-15 迁移债务审查施工（Grok 原生子智能体）

用户授权按审查结果施工，不提交、推送或发布。基线 `26aab5d`，四个 Grok 4.7 子智能体按文件边界并行实现，主代理负责集成和验证。

- [x] 公开错误码共享契约及脱敏原因透传，保留未知错误与原型键保护；七个现行公开码不再被客户端丢弃。
- [x] 工作台状态读取首次失败终止并保留可见原因，过期 writable 快照不再允许变更；历史成功作业不重放创建通知，本次提交及已观察活动作业完成仍提示；移除无消费者前端入口。
- [x] A8 接入生产精确行校验并用隔离官方 CLI 实跑通过；标准安装门改用注册制 space-coding 并增加注册/隔离/重启断言，图标浏览器测试接入 CI；声明目录清理拒绝重定向并移除七个旧产物。标准安装完整流程本轮未跑，静态预检通过；修复共享验收模块导出已删除 FALLBACK_NODE 导致的加载失败。
- [x] 运行时发布单次 rename 失败留真，回归证明不重试；旧恢复命令在磁盘边界拒绝且计划字节不变，移除内部死分支、孤儿 crash 夹具及误导测试标题。
- [x] Node 26.10.0 下清单、三组类型、构建、八组规定测试全部通过（1,576 通过、7 个平台权限跳过）；额外浏览器 11/11、包与标准安装预检通过。独立受控 Chromium 验证终态读取、错误可见且脱敏、历史通知不重放；日志/机器结果在 `.sandbox/migration-fixes-grok-20261015/`。真实官方宿主持续 UI 与旧生产 Home 迁移不由这些检查替代。

本次施工不关闭下方 `read.deadline` 持续 UI 根因项，不触碰真实 Home 和历史失败证据。

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
- [x] 2026-10-18 升级时统一 `packages/*/README.md` 中的当前 SDK、默认 CLI 和兼容下限说明；历史验收版本保持原文。

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
