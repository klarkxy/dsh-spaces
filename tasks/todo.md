# 2026-11-02 首次导航诊断与入口加载竞态

- [x] 补齐外壳、portal、child bootstrap 的有界脱敏阶段记录。实际发行包首开捕获到初始空白页完成事件提前结束下一次 `loadURL` 的竞态，同版本 Electron 独立对照确认。修复初始完整加载等待，回归在旧实现上失败、修复后通过。见 [诊断与修复记录](manager-navigation-diagnostics-20261102.md)。
- [x] 最终完整检查：此前进程生命周期测试失败和串行复查卡死，根因是 Codex 桌面应用每秒约 1–2 次 `git diff` 后执行 `taskkill /T`，WMI 进程查询被大量取消（0x80041032），测试结束子进程失败。用户退出 Codex 后，WMI 查询 20/20、`taskkill /T` 5/5 正常；`check:all` 单次 14/14 通过（`.sandbox/manager-nav-diag-20261102/checks-after-wmi/result.json`）。卡死的串行复查进程已结束，其 `serial-checks/` 记录保留原状。
- [ ] 最终构建的开发链接/发行包实测。
- [ ] 此前两个管理页 35 秒就绪超时仍未确认根因；不将本次更早的入口竞态修复当作它们已解决。

# 2026-11-02 前一轮首次管理页超时定位（未完成）

- [ ] 根因与修复仍未确认。Grok 的局部探针及 Codex 的同版本 Electron、真实管理器、生产控制器对照未复现旧超时，未据猜测修改生产代码。用户补充实际点击后，开发链接与另一套全新发行包均显示创建表单，guest 创建到新建指令分别约 1.44 / 2.86 秒；输入工具点击无效不能当作旧超时原因。这些未改代码的成功样本不构成修复，修复后的验收尚未完成。见 [定位记录](manager-first-open-timeout-20261102.md)。

# 2026-11-02 Desktop 后台启动的永久回归与现行文档

- [x] 修正 `tests/native/native-desktop-startup.test.ts` 的两处误通过：epoch/manager 变体只改被测字段；确认式手动重启的新操作是 `launch-two` 和新的 service epoch，目录与之匹配，旧 controller 保持 failed。stopped 记录上的第二个 controller 只重新加入，不读目录、不打开 portal、不调用 initialize、不启动子空间。终态和首次目录情景拆成各自的测试。未改生产代码。
- [x] 永久 Chromium：既有 `native-startup.tsx` 补上 ready 的 `beginDesktopLaunch` / `desktopLaunchState`，epoch 为 `aa` 重复 32 次，manager 为 hub。注册失败详情仍检查完整 `MAIN_REGISTRATION_REFUSED:404`，并包含可见标签“失败原因”。新增受控后台启动 DOM，覆盖 zh/en 的成功和失败、主输入节点、72px rail、用户点击后才显示原始原因/停止结果/记录保留、三种点击顺序，以及 stopped 记录的重复挂载。该夹具不证明真实宿主进程去重。
- [x] 现行文档区分 Desktop 打开即后台启动和普通 Web 的显式初始化。见 [实现与检查](desktop-background-startup-20261101.md)。
- [x] 本叶命令：`native-desktop-startup` 19/19。两份 DOM 首次并行 11/12，既有 stale rail 在 Playwright 30 秒动作超时，日志保留；该测试单独 1/1，两文件 `--test-concurrency=1` 为 12/12。`typecheck:tests` 退出码 0，`check:test-lists` 119/119。
- [x] 根代理完成完整检查：首轮 `check:all` 12/14，两组打包失败使用独立缓存复查通过（LLM 131 项、包预检）；首轮失败保留。最终构建已通过隔离官方 Desktop 0.2.1-rc.2 的开发链接/发行包后台启动、健康复用、正常停止与重载、确认式重启/启动、冷重开和子空间保持停止；真实界面上的所有权拒绝及双重错误/脱敏也通过。见[完整检查与真实 Desktop 记录](desktop-background-startup-20261101.md)。官方 EXE/asar 未变，未提交、未发布、未更新日常安装或真实 Home。
- [ ] 真实 Desktop 的首次管理页面导航尚未全绿：D、P 两个全新 Home 第一次新建超时，后续确认式新服务/重开成功，第三个全新发行包首次新建约 1.7 秒完成。根因未确认，未添加重试、放宽权限或延长超时；不能把后续成功算作原失败已修好。日志和现场保留，用户原始安装实例未更新。

# 2026-10-29 源码仓库开发模式（dev-checkout）与子空间复制修复

- [x] 子空间 iframe 补 `allow="clipboard-write <子空间 origin>"`（入口 origin 跳转到子空间 origin，只写 `clipboard-write` 不覆盖最终 origin）。"草稿已保存"来自安装版旧 view-bridge 副本，源码已无。
- [x] 宿主插件解析到源码仓库时自动进入 dev-checkout：bootstrap 不暂存、不打包，Supervisor 以 `--dev-checkout` 从仓库运行（cwd 为 tools 目录，避免构建 EBUSY）；管理空间/子空间以 `link:` 安装 `packages/{plugin,view-bridge,llm-bridge}`（新 `pluginLinkDirectory`，`pluginAdd` 校验不放宽），按链接身份对齐。新增 `npm run dev:watch`。发行路径不变。
- [x] 已通过：test-lists、三组类型、构建、npm test 282、test:workbench 631（2 跳过）、test:spaces 修正后通过。隔离 Home 实测：链接安装、无暂存/打包、dev:watch 与运行中 Supervisor 共存均通过；链接包的 client-hmr `rebuilt` 在原型 profile 实测通过。
- [x] 子空间启动失败 `dsh-spaces-llm-bridge → SUPERVISOR_BOOTSTRAP_TIMEOUT`（开发链接与发行 tarball 均复现，`.sandbox/dev-checkout-e2e-20261029-5`、`-6`）。根因：Supervisor 8 ms 内已回复，但子进程同步加载模块超过 5 s，恢复后计时器阶段先于 IPC 回复执行。修复：5 s 到期后经一次 `setImmediate` 再判定超时，期间仍接收回复；阈值、单次 `hello`、各失败边界不变，`hello` 发送失败直接拒绝。新增 `tests/llm/llm-delegation-handshake.test.ts`，阻塞场景在旧实现上失败（`old-impl.log`），修复后 7/7（`new-impl.log`）。
- [x] 隔离 Home 实测（`.sandbox/handshake-fix-20261030/`）：开发链接与发行包两条路径子空间均启动、LLM bridge 完成初始化、可读取主空间模型目录、iframe `allow="clipboard-write <子空间 origin>"` 生效；开发链接下子空间（view-bridge）与管理空间（plugin）的 client-hmr `rebuilt` 通过。复制按钮的框内权限 API 探测在该 Chromium 不可用，只验证了 `allow` 属性。`check:all` 13/14，`test:workbench:browser` 因 Chromium 拒绝端口 6665（`ERR_UNSAFE_PORT`）失败，单独复查 7/7，原失败保留。未提交，未在安装版 Desktop 实测。
- [x] 子空间 `MAIN_NOT_GRANTED`（此前被握手超时掩盖）。复现确认（`.sandbox/main-not-granted-20261030/`）：同一 Web 宿主进程内，服务经 `service.shutdown` 计划停止后再由用户启动，新 Supervisor 的 `initialize` 返回 `MAIN_REGISTRATION_CHANGED`。原因是 `MainLlmService` 仍持有旧纪元端点，`afterSupervisorStopped` 只在 Desktop 手动停止/重启路径调用，主空间因此未在新服务注册。修复：`WorkbenchHostRuntime` 记录交给注册监听的纪元；`remember` 遇到不同服务纪元时，先释放旧纪元注册，再向新纪元注册一次。同纪元行为不变，不增加启动或重试。Desktop 停止/重启共用同一释放步骤。新增两项回归，旧实现失败，修复后通过；`test:workbench` 633（2 跳过）、`llm-delegation` 22/22，类型和构建通过。隔离实测（`.sandbox/main-replaced-20261030/`）：同一宿主第二次启动成功，空间 B 运行且模型策略可读。本项未重跑完整 `check:all`。未提交。

# 2026-11-03 Supervisor 跟随官方 Desktop 退出

- [x] Supervisor 生命周期支持 `--exit-with-host`：宿主侧经 IPC 通道，disconnect 时执行一次正常关闭（停止空间、释放运行权后退出）；关闭失败保持原样不强杀。仅官方 Desktop workspace 身份冷启动传入；Web 与附着路径不变。
- [x] 真实 Desktop 验收（隔离 Home，`H:/Code/dsh-spaces-checktmp/host-exit-20261103/`，脚本在 `.sandbox/host-exit-acceptance-20261103/`）：开发链接与发行包冷启动的 Supervisor 都带 `--exit-with-host`，父进程为 dsh-desktop-host；同宿主重载后 PID 与纪元不变；正常退出 Desktop 后约 1.0–1.3 s 内以 `exit 0 / host-exit` 停止，端点与租约记录移除，无遗留子进程；同一 Home 重开只启动一次新服务；单独结束 desktop-host 进程后约 2.9 s 内同样正常停止。官方 EXE 与 app.asar 摘要不变，隔离 Home 未出现 `profiles/web`、`sessions`、`storages`。关闭失败保持原样的路径只有单元测试覆盖，未在真实宿主上制造。

# 旧阶段仍未关闭的条目

原文与上下文见 [archive/todo-2026-10.md](archive/todo-2026-10.md)；以下逐条照抄，未重新评估。

## 2026-10-21 当前版本收口与主空间 LLM 继承施工

- [ ] 前轮交付三个原型后，用户已授权并实际继续上述集成验证。正式 Supervisor 注册认证和图像/DeepSeek 网络链路已有上列源码与隔离证据；facade/UI controls 和正式标题/压缩进展见上列追加阶段，Files 失败政策、完整配额/流控及安装版 Desktop 仍待。S1/P0 不闭合，完整 P1 未放行，不提交推送。
- [ ] 插件方案重新准入：用官方 `agent/request` 冻结前入口验证 controls/defaults 的交接与真实 Agent 关联；保留投影前文件授权和 replay 来源检查；验证公开服务组合的图像隔离，不猜关联、不运行中替换全局服务。不再等待或调用候选 SDK 方法。C01–C18 需重新映射实现位置，尚不冻结契约或放行 P1。
- [ ] 18:36 用户选择在普通终端执行单次检查脚本，结果目录待提供，S1 仍未闭合；不为等待结果创建提醒或重复运行。
- [ ] S0/S1a 环境与机器检查：Node 26.10.0、Chromium 已存在；SDK 为匹配锁定依赖的 `.sandbox/dsh-rc2-upgrade-20261018/sdk`。授权临时根 `H:/Code/dsh-spaces-checktmp` 中 Node 写入成功，当前会话和 Bridge 原生 esbuild 写入均被拒；原始单次探针保留。真实剩余三组已于 18:06 完成：workbench 546 pass/7 fail/2 skip，recovery 26 pass/5 fail，包预检 exit 1；失败均为外部临时 worker/validator 的 Access is denied，见 `s1a-checks-1/remaining-once/result.json` 和全日志。未修改 ACL、未提权、未换临时根，不将检查失败记成通过。
- [ ] S1b 官方 Desktop 四项验收：未启动本轮实机。指定 Astra 首次驱动复审 REVISE 后，已修订异常句柄、unknown owner、npm 包身份和启动次数判据；颜色改为 pending-visual-review，不自动判通过。父代理在授权外部临时根执行语法及静态检查均 exit 0，见 `s1b-desktop-1/REVIEW-FIX.md`；查询失败、fatal crash、视觉结论与正式包仍待。修订后未宣称独立验收 READY，不继承旧包结果。
- [ ] S1a 汇总：清单、三组类型、构建和七个独立测试脚本本轮通过，条件跳过逐项保留；三组真实失败见上，不再记为未执行。完整 runner 未一次性运行，不声明全量通过。原 `result.json`/`result-tests.json` 是各批当时状态，后续实际结果以 `result-remaining.json` 与 `remaining-once/result.json` 补充；不覆盖历史。主代理仅改三份 Markdown，产品源摘要保持 S0。Bridge files_changed 收集因失效旧 worktree 路径不可用，必须独立核对磁盘，未修复旧 worktree。
- [ ] 条件 P0 放行：S1a 剩余外部原生写权限阻塞已有实证，类型/构建通过，当前未发现该失败关联产品缺陷；允许在 `.sandbox/construction-20261021/p0-*` 进行不依赖该编译步骤的公开 API/受控 provider 原型。S1b 仍待真实 Desktop，S1 不闭合，P0 官方 host/UI 证据未通过也不闭合；P1 重新准入要求 S1a 全量和 S1b 四项全部通过、S2 摘要冻结、P0 四道门与契约冻结全部完成。
- [ ] P0 G2/G3 集成：Grok 原型返回 adapter harness G2 PASS/G3 BLOCKED；指定 Astra 复核为 FAIL（仅门槛声明），不接受生产门槛 PASS。G2 使用自行构造的 adapter/profiles Map，不是已运行主空间公开 generation；G3 现有官方图像 resolver 捕获插件 ctx 且无请求级读取参数，但原碰撞夹具不足以证明所有 scoped 附件方案不可行，文件 handle 投影另属未验证。原始 `p0-llm-1/RESULT.json` 保留，`CONTRACT.md` 只作历史提案，不冻结共享类型、不进入 P1；后续仅研究现有公开插件接法，不修改 SDK。
- [ ] P0 G1 Web 本轮 failed 且验收环境不合规：实际非 web 官方宿主、Spaces 链接插件、公开 LLM/默认模型/profile 服务存在；observer 的 loaderEntry 匹配为空后中止，鉴权/unary/dispose/原驱动退出后 protected-tree 检查未执行。记录于 `p0-host-1/RESULT.json`。父代理复核发现 `host.mjs:125-127` 将 TMP/TEMP/TMPDIR 设为仓库内 CACHE/tmp，违反外部临时根要求，本轮不作为合规 G1 通过证据。记录 PID 2476 已退出；父代理事后只读确认三个受保护目录仍不存在，另记补充审计不覆盖原结果。不重启失败环境；G1/G4 未闭合。

## 2026-10-20 前端动效重构与 Desktop 打开即启动

- [ ] `test:workbench`、`test:workbench:recovery`、`check:plugin-package` 在会话沙箱中因 esbuild 原生子进程无法写仓库外临时目录而未验证；需在普通终端运行 `check:all`（2026-10-21 收尾轮在沙箱内复跑确认：除这三组已知失败外全绿，失败名单与上轮逐项一致）。真实 Desktop 尚待用户实测：打开即启动、侧栏「＋」、插件版本下拉，以及深色主题下侧栏配色——侧栏的 `--dsw-alias-*` / `--dsw-specific-*` 令牌由宿主应用提供、仓库夹具里只能回落浅色，真机深色表现要在实测中确认。

## 2026-10-18 DSH 0.2.1-rc.2 升级

- [ ] 保留早期 Windows 临时文件与并行启动偶发失败证据，后者根因未判定；不关闭历史持续 UI 调查，也不将官方 Web 验收写成安装版 Desktop 验收。

## 2026-10-15 全新 Home 持续 UI 验收（Playwright 干净上下文）

- [ ] 持续 12 分钟窗口 FAIL（run 7）：04:05:21Z 两条同时发往 Supervisor 的请求在浏览器内停滞约 5.2 s 才开始 DNS/连接（CDP timing `domainLookupStart=5240ms`，服务端耗时约 220 ms）；dashboard `overview` 查询在未发出时被 5 s frame deadline 中止，首次失败即终态，切回首页后看板持续显示 `看板读取已停止 · dashboard/unavailable · read.deadline · overview · transport · 5012ms` 直至窗口结束（探针 14–48）。这与 10-14 未归因的 U01 `read.deadline` / 无状态 `board.transport` 同类，而且发生在干净 Cookie、未打补丁 SDK 下，排除了 Cookie 累积和 header 上限作为唯一原因。停滞发生在浏览器侧请求发出之前，发起方未定；候选为 Chromium 对该 origin 的 socket 池/调度排队，需 `--log-net-log` 复跑才能判定。run 5 同窗口未见该失败，复现率 1/2。
- [ ] 观测但未判定：显式重开后 manager 页仍渲染上一纪元的 `已创建 / 进入空间` 提示（10 s 后仍在）；`localStorage` 键名两纪元一致。停止服务时两次运行呈现不同面：run 5 为 `结果尚未确认，没有重新发送请求` 提示，run 7 为宿主页 `workbench/unavailable` alert、管理帧消失。

## 2026-10-14 实机确认问题修复与 Node 26 隔离复验

- [ ] 持续官方 UI 验收尚未关闭：最终宿主页实见 portal/transport-failed，原 U01 read.deadline 停顿及 Browser 标签调用失败仍未归因。正常重启、停机、显式新启动成功不抵消这些失败。嵌入控件操作受工具限制；独立打开 3103 管理页被自动审批拒绝，拒绝后没有绕过。

## 2026-10-13 实机缺陷修复与新隔离 Home 复验

- [ ] Node24链接边界尚未验收：最终全套23次junction相关失败，Node26只作诊断对照，没有削弱安全断言。完整生产故障注入、Browser总线UI、raw流delta、在位宿主包替换和完整嵌入交互等仍有覆盖缺口。

## 2026-10-12 清理与结构拆分

- [ ] 负载下的既有偶发失败（`e9e0099` 上同样出现）：`tests/dashboard-supervisor.test.ts` 任务偶尔以 failed 结束或被 `workbench/maintenance` 拒绝；`packages/blueprint` 的 `native.test.mjs` 端口获取竞态。

## 2026-10-12 移除自有 Electron 桌面壳

- [ ] `.github` 之外的历史验收记录（tasks/、docs/dashboard/ 等）按惯例保留原文；其中提到的桌面流程不再是现行门槛。
- [ ] 官方 Desktop 宿主嵌入（native-host 桥、`dsh-app://app`）保留，仍待独立验收。

## 2026-10-09 精简 MVP：消息总线、能力查询、Browser Space

- [ ] 基线测试债务：额外 frontend-recovery/dsh-cli/plugin-library 64 项中 61 通过、3 失败，与原始基线一致；完整默认 test 在 Linux 的 Windows taskkill fixture 失败后挂住，已中止，不计为全套通过。本轮只更新旧“禁止任何 preload”断言为专用窄桥和真实 sender/frame 约束，没有改动这些基线失败。
- [ ] Web 拒绝嵌入提示不完整：实际截图主要为浏览器破损图标，只有通用 Web preview 文案与外部打开入口，未完成产品层面的清楚说明。
- [ ] 官方 Desktop 0.2.0-rc.2/Windows 原生 Browser 呈现失败：有效地址创建标签后显示 `Native Browser is unavailable.`，无网页 guest；深色宿主标签文字对比度也不足。原始官方代码隔离实测，不代表原安装 EXE 完整引导/登录验收。
- [ ] 旧五组件安装不能直接热升级到六组件包；本轮只提供新隔离安装路径，没有自动迁移。用户本机若有旧 Home，先按此限制选择新 Home，不覆盖原有数据。
- [ ] Terminal Space 尚未实施，另行设计与授权。

## 2026-10-09 跨 Space 消息总线第一阶段（历史阶段记录）

- [ ] 停在第一阶段供评审；静态能力查询、Browser 及其它后续阶段未开始。官方完整 Host／发行包／多平台验收未运行。

## 2026-10-09 Blueprint 归属与 DSH 0.2 迁移

- [ ] 推送、发布、生产 Home 迁移及安装版 Desktop 验证不属于本次本地提交。
