# 工作台化实施记录

## 当前有效合同（2026-09-15）

故障政策：[docs/let-it-crash.md](../docs/let-it-crash.md)。活动账本：[todo.md](todo.md)。接口合同：[workbench-contract.md](workbench-contract.md)。

仍有效：专用 `spaces-hub`、72px 空间栏、独立 iframe、单写者、本机 `127.0.0.1`、独立监督进程、浏览器 DTO 不含路径/token、隔离 Home 验收、普通空间不承载完整管理器。

已撤销为现行需求：救援/维护恢复页、整 Home 快照恢复、配置恢复、失败回滚、独立恢复 CLI、损坏即进入恢复模式、中断恢复、kill 后抢救成功。损坏或身份不明：拒绝相关控制并说明原因，保留原字节；不清锁、不接管。

未完成项只剩：R1–R6 运行时去恢复；插件管理 02–03/07–11；取消永久版本白名单；外部发现缺口；主题失败如实记录；最终回归与新视频（不宣传恢复）。不得把下列历史批次完成当成总目标完成，也不得把恢复未完成继续列为阻塞。

**目标政策 / 已知实现差距：** 源码仍含恢复状态机与入口，直至 R 完成。

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。

状态：施工中（历史批次）。2026-09-12；分支 codex/spaces-pluginization；起点 5585060。用户批准完整 A—D 计划，Grok 施工，Codex 接口编排、整合、独立验收。不得把批次完成当成总目标完成。

## 固定需求（当时）

- 专用 spaces-hub 管理 profile，名称冲突时递增后缀，不覆盖旧 profile。原 profile 原地接入，保留数据和默认启动入口。
- 72px 外层空间栏，独立 iframe 工作空间，保留草稿/滚动/会话，最后一次切换胜出，视图就绪后才切换，失败保留原空间。
- 普通空间不运行完整 Spaces 管理服务；误装只提供返回工作台。允许无管理权的独立轻量视图桥。
- 本机 Windows/Chromium；仅绑定 127.0.0.1。同一 canonical Home 只有一个写控制者，桌面/Web另一端只读。原有事务锁继续使用，不被长期运行权取代。
- 独立监督进程和稳定入口，关闭浏览器标签不停止实例。管理环境升级/恢复期间仍有维护页面；执行器和控制状态不位于被恢复替换的目录。
- 包含空间元数据/生命周期、插件搜索安装卸载启用、整 Home 快照创建预览恢复删除、配置备份恢复、运行时安装升级和失败回滚；包含管理工作台自身维护。
- 长任务持久化、刷新续看、幂等请求、可取消阶段明确；维护后不自动重启全部工作空间。损坏或身份不明只进入恢复模式，不猜测清锁，不接管外部实例。
- 浏览器 DTO 不含磁盘路径、命令、原始启动 token、Cookie、配置秘密；服务器解析业务标识。视图握手校验 source/origin/generation。
- 保留 doctor/独立恢复 CLI、旧快照格式与整 Home 语义；原生桌面行为回归。
- 基线 CLI 0.1.5-rc.1 / SDK 0.1.5-rc.2；真实 CLI 0.1.5-rc.2 仅在完整兼容验证后可允许写，不能假造版本或绕过门禁。
- 所有运行验收用新隔离 Home/空会话，不读取生产配置、不调用模型。完成后更新分发产物与空间栏介绍视频。窄范围本地提交，不推送/发版/改版本号。

## 批次与闸门

A：监督、身份/运行权、稳定入口、专用管理环境、轻量桥。先用真实 DSH 证明两工作空间无完整 Spaces 仍可嵌入、认证隔离和管理环境停止时救援入口可用。基础闸门失败则暂停依赖它的扩建，报告证据。

B：空间栏和完整使用闭环、元数据/生命周期、误装限制、双端运行权。

C：复用现有插件/快照/升级模块接入监督进程，完成自维护及中断恢复。

D：分发、回归、实际浏览器/桌面验收和新视频。

## 初始叶子所有权

- A0 Grok：scripts/verify-workbench-foundation.mjs、tasks/workbench-foundation-worker.md、.sandbox/workbench-foundation/**。真实架构试验；不得改产品源码或既有主题/录像 Home。
- A1 Grok：src/adapters/node/home-controller.ts、tests/home-controller.test.ts、tasks/workbench-controller-worker.md。独立管理身份、长期运行权模块与测试；不得改桌面/插件入口及公共 DTO。
- A2 Grok：src/adapters/node/workbench-jobs.ts、tests/workbench-jobs.test.ts、tasks/workbench-jobs-worker.md。持久化任务、幂等与取消；不启动DSH/HTTP。
- B-UI Grok：packages/plugin/src/workbench/**、tests/workbench-ui.test.tsx、tasks/workbench-ui-worker.md。基于固定合同独立制作工作台组件；不改入口，不启动浏览器；真实接线仍等待A闸门通过。
- A/B监督服务 Grok：src/adapters/node/workbench-{runtime,http,supervisor,views}.ts、packages/supervisor/src/**、tests/workbench-{runtime,http}.test.ts、tasks/workbench-supervisor-worker.md。只做正式运行服务和组合，不改旧模块/公共DTO/构建；真实DSH验收由主Agent串行运行。
- C维护 Grok：src/adapters/node/workbench-maintenance.ts、tests/workbench-maintenance.test.ts、tasks/workbench-maintenance-worker.md。消费固定Node ports复用旧事务，不自建监督进程。
- 插件角色/桥 Grok：packages/plugin/src/host/**、client/index.tsx与workbench-remote.ts、入口/typert/types、packages/view-bridge/src/**、tests/workbench-plugin.test.ts与spaces-host.test.ts、tasks/workbench-plugin-worker.md。不得改工作台UI、Node适配器或构建清单。
- doctor Grok：packages/doctor/src/**、packages/doctor/README.md、tests/spaces-doctor.test.ts与workbench-doctor.test.ts、tasks/workbench-doctor-worker.md。独立离线诊断/恢复，仍复用原事务。
- Codex：本记录、接口合同、根依赖与构建配置、Git、独立验收。后续叶子派发前补充所有权。

## 当前记录

- 实现前基线：180项桌面测试、89项插件测试、桌面TypeScript通过；日志 .sandbox/workbench-baseline-{desktop,spaces,types}.log。
- A0 task_5099138387 / sess_85bce9de05；A1 task_d74dc0f97e / sess_bf242b2bdb；A2 task_56b8a94682 / sess_eb1c507a1c。均请求Grok/high，实际模型待回执。
- 公共类型在 src/shared/workbench.ts，通信/拓扑见 tasks/workbench-contract.md。写接口根作者Codex。
- B-UI与基础后端独立制作，task与session见后续派工回执；不得把未接入组件当运行完成。
- B-UI task_ae8befe357 / sess_c800355aa4；监督 task_d01250167f / sess_51f4611809；维护 task_e7c4540010 / sess_143b1c3e59。
- A1审计修正通过主Agent24项测试与2个独立反例复验，commit 99ae600；session已关闭。A2审计修正task_27891e3718 / sess_eb1c507a1c进行中。
- A0 run.log已有双真实DSH iframe/草稿保持/Origin隔离/不暴露token/独立入口存活的实验PASS；实验管理服务是Node脚手架，不冒充正式管理profile验收，正式接线仍需重验。
- A0已交回并关闭session；Codex读回JSON及截图。A2一次修正完成，Codex追加损坏记录结算门禁并独立21 tests通过，session关闭。
- B-UI审计重试task_bdcec2fb00 / sess_c800355aa4；插件角色/桥task_518594be2a / sess_97b2c25108。均Grok/high。公共View新增entryOrigin，详合同。
- C维护审计重试task_fd98b15284 / sess_143b1c3e59已完成并关闭，Codex复验23项及原反例通过；监督审计重试task_aa911561e8 / sess_51f4611809进行中。
- 桌面审计重试task_c7435e298e / sess_ca0229c591；插件审计重试task_17d04eb914 / sess_97b2c25108进行中。后续这些session不再延长，进一步问题由Codex修正整合。
- B-UI session已关闭；Codex独立30项交互/DOM验证通过并补充测试fixture。正式验收脚本scripts/verify-workbench-product.mjs已准备，尚未执行。首轮build:spaces已成功，仍需所有最终源码稳定后重建验收。
- doctor task_f86e0dd9a6 / sess_64633c38fa。离线资源私有toolchain.json需根统一补runtimeRoot/snapshotRoot/toolchainRoot，供Desktop/Web/doctor同Home接续，不允许猜旧appuserdata。
- 根整合待重点核查：普通Desktop空间列表不得显示manager形成双层空间栏；监督启动/释放/故障保持入口；真实升级候选进程的跨崩溃身份记录（旧CoordinatedUpgrade只在内存track子进程）；Home资源指针跨端一致；独立CLI生产Home许可须明确产品授权传递且测试仍隔离。

## 证据入口

2026-09-12 根整合进展：正式 A 产品基础已通过，见 .sandbox/workbench-product/results.json 和 workbench-two-spaces.png / manager-stopped-rescue.png。实际打包监督程序创建专用 DSH 管理 profile，两个未安装完整 Spaces 的工作 profile 经左栏点击启动、授权 iframe 就绪；停止真实 manager 后稳定入口仍可查询。不是 A0 脚手架。根修正了双 shebang、页面脚本语法、Windows 含空格归档参数、协作停机、半完成管理安装续接、停止失败保留视图。

最新独立整合单测72项通过（.sandbox/workbench-integrated-root.log），此前三个TS配置均通过；之后的资源根同步与参数校验仍需最后复验。主题分发正在 scripts/verify-workbench-product.mjs --themes 下实际跑，竹青已安装和显示，未将未完成的全部主题矩阵记通过。

doctor 唯一审计重试 task_5bd2351c95 已交回并关闭session；根待复验26项。维护真实分发脚本叶子 task_c821afd32e / sess_f49f582cbb 已交回初稿 scripts/verify-workbench-maintenance-product.mjs，尚未真实运行；实际进程/浏览器与主题测试串行。

总目标仍未完成：维护完整读回及故障注入、rc2实际兼容、跨端资源接续/桌面分发回归、Catppuccin失败案例隔离、最终视频与最终产物回归均待完成。不要把当前基础通过当作完整交付。

后续进展（20:12）：本地提交 b9c6e8f 为离线doctor，5ad7355为工作台/监督/桌面运行权接线；没有推送或发版。root独立26项doctor、86项当前范围回归通过，三个TS配置日志为空（通过）。

正式主题测试：竹青与EternalNight实际安装、主题显示、草稿输入通过；XP 0.1.1原包仅在window.self===window.top绘制桌面，iframe会退化成聊天。原始失败已保留 .sandbox/workbench-product-themes/xp-original-failure.{json,png}。Grok XP叶子及唯一审计重试已结束/关闭；root 9项补丁测试通过。src/adapters/node/xp-compatibility.ts按固定原/新hash应用显式兼容，不假装原包兼容；root已接入XP安装预览与执行，尚待真实浏览器。tests/fixtures/xp-original含MIT许可原包测试fixture，不能改为修补版。

正式维护初次all运行：plugins分组真实通过（精确安装/读回、配置恢复、卸载、刷新同job、关浏览器服务继续）。snapshot.create真实成功；snapshot.restore查询ECONNRESET；runtime.install查询30秒超时。日志 .sandbox/workbench-maintenance-product-run.log 与 results.json。尚不能证明进程崩溃，测试失败清理前任务分别已进reinitialize及install。后续真实维护暂停到响应性修复，不靠加长超时标通过。

活动Grok叶子：
- task_51a84a571d / sess_c1bfe82bb3：维护响应性，拥有src/main/{snapshot-executor,snapshot-worker,coordinated-upgrade,runtime-store,maintenance-io-worker}.ts与专用测试；初始turn进行中。root已补core RestoreSession await completeRestore、Node/desktop传workerFile、isAuthorizedProductHome查询及toolchain finally异步删除；不要覆盖worker文件。
- task_c915c4e265 / sess_f49f582cbb：真实维护脚本唯一审计重试；增加稳定入口心跳/loop-lag及查询中断后收集最终任务结果，仍将入口失联记FAIL。只写scripts/verify-workbench-maintenance-product.mjs及任务记录。
- task_66b073c644 / sess_7cf3a935e2：真实双端运行权脚本初始turn，只写scripts/verify-workbench-dual-control.mjs及任务记录。未启动真实服务。

root仍需：候选升级子进程跨崩溃身份记录/启动意图（CoordinatedUpgrade目前只内存track）；运行权恢复/释放路径；rc2实际兼容；全分发桌面/浏览器/故障注入验收与视频。新完成子任务只算模块成果。

旧主题与分发：tasks/pluginization-themes-acceptance.md、tasks/pluginization-trial-acceptance.md。

### 最新续接（2026-09-12 20:54）

- 真正主题分发验收已通过 `.sandbox/workbench-product-themes/results.json`（Home `home-C4wR8E`）：竹青/EternalNight/显式适配 XP，真实草稿保持、误装完整 Spaces 仅 guide、Catppuccin 原始加载失败保留前一空间、停止 manager 独立入口继续。原始未适配 XP 失败文件仍保留。
- 真实整 Home 快照恢复通过 `.sandbox/workbench-maintenance-product/snapshot-success.json`，配置名称、两处测试数据、rc1 运行时读回，manager 重启而普通空间停止，3 秒入口心跳门槛通过。
- runtime.install 本身成功，但 `.sandbox/workbench-maintenance-runtime-retry.log` 中入口 4018ms 不可用，event-loop probe 4263.5ms；不记整个运行时阶段通过。Grok 唯一审计重试 `task_391d91f57b` / `sess_c1bfe82bb3` 定位剩余同步 IO；持有 main IO 文件，保留根新增候选进程日志。
- 根已补 `owned-process-record.ts` 与 CooperativeChildren 启动意图/PID、CoordinatedUpgrade candidate observer；独立 process-recovery 32项通过。RuntimeStore npm 子进程持久身份尚需闭合。
- Grok 恢复匹配叶子 `task_dad68e90b9` / `sess_a2cd345981` 持有 Node supervisor/maintenance/jobs 及各自测试，修复 plan.execute 与恢复事务的精确对应；不要并行覆盖这些文件。
- Grok rc2 脚本叶子 `task_0cbe0f4f13` / `sess_8d5a42d229` 仅写脚本和记录，禁止直接放宽产品门禁；未实际验证 rc2。
- 根新脚本 `scripts/verify-workbench-interactions.mjs` 只复用上述已验证隔离主题 Home，正在验证 XP 内层聊天及元数据/生命周期/刷新。初次被 DSH API 首次引导遮罩拦截，已改走正常“稍后配置”按钮，不修改产品绕过。
- 双端脚本 Grok 初稿 `task_66b073c644` / `sess_7cf3a935e2` 已交接，唯一审计重试仍可用；真实 Electron 尚未运行。IO 源码稳定后再构建分发。
- 尚未完整完成：运行时升级/真实故障注入与恢复、rc2、双端与分发桌面、全部最终回归和新录像。不要提前标完整交付。

### 最新续接（21:10）

- `.sandbox/workbench-interactions/results.json` 已通过：XP 实际内层聊天无递归桌面、草稿保留、快速点击最后选择、创建不打断、内置 code 图标、改名/排序/重启/停止/删除磁盘读回、刷新恢复选择。最早 emoji 测试输入不属支持图标；第二轮误点旧失败测试同名空间，已改唯一名字，两项为脚本修正。
- Windows `release/win-unpacked/DSH Spaces.exe` 本地构建打包通过（未发布）。`.sandbox/workbench-dual-control/results.json` 真实桌面只读状态、IPC拒写、Home哈希未变、web释放/desktop获取成功；随后发现产品bug：supervisor.finishRelinquish/dropWritable 未重置 sealing。必须在 release 完成后置 false，acquire 正常恢复，补双向移交测试。当前 supervisor 文件归 recovery Grok 叶子，root等交接后修复，勿并行覆盖。不要放宽脚本期待只读/忙碌的断言来掩盖该bug。
- mmx 已授权真实生成四段配音+字幕 `.sandbox/workbench-demo-audio`，总约77秒，脚本 `tasks/workbench-demo-narration.json`。voice `Chinese (Mandarin)_Gentleman`、speech-2.8-hd、speed1.05。不需要重新登录或重复付费生成。
- 录像脚本叶子 `task_de4452212f` / `sess_b12cad8991` 仅写 record-workbench-demo.mjs / assemble-workbench-demo.mjs / tasks/workbench-video-worker.md，禁止实际服务；root待最终UI稳定后串行录制。
- 其余Grok IO/rc2/recovery仍在运行；dual脚本初稿session保留一次审计重试，当前发现是产品问题无需改其拒写标准。
- 额外待闭合的进程身份：RuntimeStore.install 的 npm/ensureNode、插件BoundCli等短期维护子进程也需持久化启动意图，不能仅CoordinatedUpgrade candidate有日志。现有挂起job/plan可保守阻断写，但缺PID将妨碍独立恢复判断。IO文件交回后root统一接线，勿并行改toolchain/runtime-store。

### 最新续接（2026-09-12 22:03）

- 新本地提交 `c6f71b7`：XP 适配器/原始 MIT fixture/9项测试；`5911e60`：已删除空间的创建提示修正，root30项UI测试通过。HEAD为5911e60，未推送/发版。
- IO Grok唯一重试 `task_391d91f57b` 完成并关闭 sess_c1bfe82bb3；异步rename/retarget已接入，root39项相关测试通过。但真实安装仍曾7秒失联。逐调用探针最终确认 `supportsCliEntry existsSync` 1.7秒 + Windows `spawn` 6.9秒，而不是继续猜目录复制。证据 `.sandbox/workbench-maintenance-product/runtime-worker-first-supervisor.log`（该保存文件是Worker首轮升级日志；旧slow-sync精确原日志曾在runtime/supervisor.log，后被下一轮覆盖，`.sandbox/workbench-maintenance-runtime-trace.log`保留失败状态）。
- root把整段 RuntimeStore.install 移入现有 snapshot-worker 的runtimeInstall操作，仍调用同一RuntimeStore算法；Node/desktop构造均传 installWorker。Worker设置同工具根，记录所有npm/CLI启动身份，异常退出保持不确定性。真正runtime.install此后通过严格3秒心跳，安装目录读回正确；`.sandbox/workbench-runtime-worker-root.log`与`.sandbox/workbench-maintenance-product/runtime-worker-first-report.json`。完整runtime阶段仍失败：升级spaces-hub时pnpm失败，未冒充升级成功。
- root已补Coor暂存Home的hub/plugins归档复制（pnpm重解析file:../../hub/plugins需要），并保留更完整失败诊断；补测试39项通过。真实升级尚待重跑。Coor新增onProgress订阅，Workbench持久job记录实际升级阶段（原本一直prepare）。
- Recovery Grok唯一重试 `task_d3b699e9da` 完成并关闭sess_a2cd345981。root已复验75项整合通过：按planId/snapshotId精确结算，不相关/损坏记录保留，恢复失败不启动manager；release/sealing修正；bootstrap与runCommand观察子进程。原Coor journal新增可选planId（preparing/committing都写）。不得恢复粗匹配。
- root `owned-process-record.ts` 新增AsyncLocalStorage观察范围与spawnObserved，已接runProcess/spawnNode/spawnBoundCli；Desktop mutate/runMaintenance、Supervisor bootstrap/runCommand包装。CooperativeChildren与Coor已有显式记录时退出额外观察避免双记录。root22项CLI测试、19项desktop/child测试通过。
- 第二次实际双端失败因Desktop把自己刚启动的实例也当未知残留。root加真实ChildProcess对象对应检查：CooperativeChildren.ownsRecord、ownsObservedChild以及inspectControlResidue受控忽略callback。仅当前持权且本进程确实持有的活子进程可忽略；伪造PID/代次、已退出实例仍拒绝。root19项含新反例和Node类型检查通过。最新真实双端正在 `.sandbox/workbench-dual-owned-retry-root.log`，exec session50512（构建+pack+run），不要并行重启服务。
- root默认监督入口保存entry-port.json，干净冷启动复用origin；显式--port 0仍随机。23项Supervisor tests通过。
- rc2低层初跑真实CLI/两profile/轻桥注入/typedRPC通过，但错误要求guide-only profile存在旧spaces/overview而fail。Grok唯一重试 `task_9375bca97f`修脚本并补真正Chromium实验父页，session已关闭；新默认输出`.sandbox/workbench-rc2-retry`，仍需root串行执行。门禁仍rc1，rc2尚未支持。
- Video Grok `task_de4452212f`完成初稿，sess_b12cad8991仍保留一次审查重试。只新增record/assemble-workbench-demo.mjs和实际任务文件 tasks/workbench-demo-video-worker.md（与派工记录文件名略不同）；无成片，必须最后真实录制/合成。配音四章约77秒已生成，不再重复mmx。最终主题测试应新Home重跑以安装最新UI产物，录制脚本从最新主题results读取Home。
- 当前Grok活动：真实故障脚本 `task_61a65a84ff` / sess_a1c1c708b1，仅scripts/verify-workbench-crash.mjs、tests/fixtures/workbench-crash/{driver,snapshot-worker}.ts、任务文档，禁止实际服务，由root串行执行；只读外部手工实例发现调查 `task_0e9a5c080e` / sess_f04360b520，仅tasks/workbench-external-discovery.md。后者核实未装桥的外部DSH能否精确识别Home，当前仅控制记录可能不够，不能猜PID/全机DSH都算同Home。
- 尚须审计/交付：完整升级（候选准备与指针切换）；故障回滚/kill恢复 **已撤销**（2026-09-15）；rc2候选与完整产品验证；双端最终通过；manager插件自身版本/内容升级入口（当前主要是其runtime/整Home维护，不能自动当完整自升级，失败回滚已撤销）；外部手工实例识别；真实认证失败/超时/崩溃/滚动会话保持边界；所有最终单测/类型/构建/分发/主题；新视频和窄提交。不将未验证项写成完成。
真实 SDK：C:/Users/admin/AppData/Local/Temp/spaces-runtime-install-fIEaas/versions/0.1.5-rc.1/node_modules/@deepseek-ai。
Node：D:/Program Files/nodejs/node.exe。Playwright 包：C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright。
最新 Spaces tgz：.sandbox/pluginization-delivery/dsh-spaces-plugin-0.2.0.tgz。
旧截图和视频 Home 仅供只读参考；本轮建立独立 workbench 验收 Home。

## 2026-09-12 23:35 根审计续接

- 最新本地提交 6247b22：自有维护子进程持久身份、桌面在持权时识别自己的活实例、Windows 有限写入重试；170项桌面/底层独立回归通过，日志 `.sandbox/workbench-desktop-base-regression-root.log`。仍无推送/发版/版本变更。
- 真实双端运行权 `.sandbox/workbench-dual-control/results.json` 已于14:12Z通过，实际 win-unpacked exe。单独完整桌面 DSH 子 WebContents 回归仍待最终运行。
- `.sandbox/workbench-maintenance-network-acceptance` / `runtime/home-W8qWFB`：真实 runtime.install、runtime.upgrade 均在持久任务中成功，Home运行时指针已改为该隔离tools下的 rc1；但测试整体 FAIL，稳定入口4.011秒不可用（3秒门槛）。`.sandbox/workbench-runtime-network-root.log` 和 runtime/supervisor.log有同步lstat/realpath在轮询中的慢调用证据。根已改维护期间显示预先取得的空间元数据，状态/代次/任务进度仍实时，不把缓存用于写权限判断；真实重跑尚未做。一个临时目录交换的HTTP回归通过，日志 `.sandbox/workbench-maintenance-inventory-root.log`。
- 先前默认沙箱运行 `.sandbox/workbench-runtime-persist-retry-root.log` 因联网EACCES与测试子进程清理被拒失败。其 Home `home-nsm40Z` 留有preparing恢复证据，不能直接复用/清锁。root按私有记录、创建时间、原父进程和隔离tools命令核验后，仅清理自有超时进程332树；记录保留。当前真实测试需授权网络/测试进程权限，不可用默认受限运行误当产品失败。
- rc2低层真实Chromium重试通过：`.sandbox/workbench-rc2-retry/results.json`、`.sandbox/workbench-rc2-cookie-retry-root.log`，退出2是预期：fullProductValidated=false、正式写门禁rc1。已证明官方web、两个轻桥空间、误装fullSpaces guide-only、精确桥接握手；根看过双iframe截图（官方引导页面），不是完整工作台验收。前次Cookie同时传url/path是脚本错误，root已修。
- 恢复凭据叶初始 task_03af359b5b 24分钟只有读/推演，root已取消。唯一聚焦重试 task_51aee34b69 / sess_31ba7bcb2f 仅负责 shared/snapshots、snapshot-store、snapshot-executor、snapshot-store测试与taskdoc；上层归root。接口为RestoreRecoveryReceipt、optional UUID planId、restoreJournal/recoveryReceipt，receipt先落盘再删journal。
- 根正在整合CoordinatedUpgrade→Maintenance→Supervisor→doctor exact planId结算，回滚failed，未知旧任务不批量清除；修正候选子进程停止错误保留ProcessTerminationError。防止旧已完成receipt被后续runtime升级后误消费，JobStore新hasUnfinishedPlan、Coor recover接receiptPlanId显式选择。集成首轮75项73过、2项旧预期需改，修正后重跑审批曾因连接中断失败；`.sandbox/workbench-receipt-integration-root.log` 要确认最新日期/最终结果，不能把旧结果当最新。
- 全部录像脚本叶已完成并关闭 sess_b12cad8991；4段mmx实际音频仍在 `.sandbox/workbench-demo-audio`，不要再次生成。录像脚本已改为读取最终通过的theme Home，不再固定home-C4wR8E。实际新录像仍未运行。
- 自升级只读审计 task_fd23ec9e38已完成关闭。`tasks/workbench-self-update-audit.md` 确认manager已安装则bootstrap提前return，不更新新artifact；目前缺完整Spaces插件自身更新闭环。DSH runtime升级不等同该功能。审计建议中的“维护中关闭监督再冷启动”不满足稳定入口要求，root不采纳该步骤；需在旧监督持续服务下完成manager包维护，自身执行器只下一次冷启动更新。
- 文档Grok task_c8c4d1cae5 / sess_aa212772de：README、plugin/supervisor README、docs/workbench.md、taskdoc。异常浏览器脚本 task_25e27f4ea8 / sess_b379127f4e：新verify-workbench-browser-failures脚本及自有fixture/taskdoc；初始派工审批超时，原UUID重试成功，尚未真实运行。
- 外部从未登记DSH无法映射Home，见 `tasks/workbench-external-discovery.md`。已向用户异步询问是否授权扩DSH实例登记/维护协议，还是本批保留此项阻断并交其余证据；不是允许猜PID、扫token或停生产实例。尚待回复，独立工作继续。
- 总目标仍在施工：真实入口响应复验、rc2完整候选及rc1→rc2升级、manager包自身更新、外部实例边界、最终全部回归/打包/桌面/主题/异常切换/新视频和剩余窄提交。真实 restore/upgrade kill 恢复：**已撤销**（2026-09-15，改验失败可见且无抢救）。不得以已有局部PASS宣称完成。

## 本轮最终检查与审批阻碍（2026-09-13 00:00附近）

- 当前三个类型配置分别通过：`.sandbox/workbench-final-{node,spaces,web}-types.log`；插件/监督/doctor构建通过 `.sandbox/workbench-receipt-build-root.log`；Electron源码构建通过 `.sandbox/workbench-final-desktop-build.log`。`release/win-unpacked`尚未按最新恢复改动重新打包/重验，不能与out目录构建混为一谈。
- 根独立25项SnapshotStore通过 `.sandbox/workbench-restore-receipt-store-root.log`；51项Job/Maintenance数据测试通过 `.sandbox/workbench-receipt-data-tests-root.log`；11项不涉及真实长活子进程的CoordinatedUpgrade数据测试通过 `.sandbox/workbench-coordinated-data-root.log`（明确排除failure-before-commit/kill-failure两个进程用例）；doctor preparing遗留插件日志单项回归通过 `.sandbox/workbench-doctor-preparing-root.log`。不是全套回归通过。
- 根增加两项协调恢复反例：只消费传入exact receiptPlanId；旧已完成receipt不能将后续运行时选择改回去。SnapshotStore receipt与Coor/Maintenance/Supervisor/doctor接线已有代码，真实强杀/冷恢复仍未运行。
- 根修正文档PowerShell的保留变量 `$home` 为 `$workbenchHome`、CLI例子的缺失lib段与worker路径引用。根还让独立监督首次空Home启动先物化官方web（仅缺失时），避免以后升级缺少web；这一新增首次启动路径尚未实际验收。
- 自动审批连续报 `Automatic approval review failed: Error running remote compact task: stream disconnected before completion`，并明确拒绝动作。已核对临时目录证据重试，完整进程回归仍被拒。已向用户异步请求继续该组隔离回归的明确确认，未收到回复前不继续依赖它的实测。
- 管理包自更新模块派工 request_id `481aa38e-9331-40de-8d78-5a4fa3b79b69`（task_key workbench-package-upgrade）同样被审批拒绝，没有task/session，没有创建模块。准备的shared/workbench额外字段已撤掉，避免交付空接口。详细拟派工参数保存在本对话functions store的managerUpgradeDispatchArgs；后续获准再恢复合同/派工，不能当已施工。
- 两项既有Grok仍报告running：receipt重试 task_51aee34b69 / sess_31ba7bcb2f（仅5个存储层文件），browser-failures task_25e27f4ea8 / sess_b379127f4e（脚本尚未出现）。root尝试取消两项，取消本身也被同一自动审批拒绝，**没有确认停止**；续接先检查它们，禁止与其写入范围冲突。文档叶task_c8c4d1cae5已completed，end_session也未成功，session可能ready；文档稿已由root审查修正。
- 目前没有真实产品测试服务需要继续等待；rc2 session57132已完成预期blocked结果，runtime20125已完成FAIL入口心跳结果。保留所有失败Home和结果。后续先处理审批/外部实例协议选择，再恢复真实维护/打包/录像。未推送、未发布、未修改发布版本。

## 2026-09-13 11:00附近 根续接记录

- 用户回复“允许”后，授权已保留；最初仍被审批服务连接错误拒绝，稍后相同授权派工和进程回归恢复正常。不要再让用户重复同一许可。外部原生DSH登记/维护协议的范围选择仍待明确，不能把这次许可自动当作选择其一。
- 旧receipt Grok重试task_51aee34b69最终failed/Internal error，已用尽一次重试，root接管其实际文件；浏览器异常脚本task_25e27f4ea8 completed。二者与旧文档session均已end成功，无遗留作者。
- 完整相关恢复回归124/124 PASS：`.sandbox/workbench-receipt-integration-root.log`。真实运行时复验 `.sandbox/workbench-maintenance-network-acceptance/results.json` PASS：rc1安装/rc1同版本协调升级/manager重启/关闭浏览器后入口存活；升级heartbeat maxMs=5/maxGapMs=418，0失败。以前4秒失联FAIL已备份results-before-inventory-fix.json、supervisor-before-inventory-fix.log。实际rc1→rc2仍未做。
- 新管理包模块Grok初始task_1c7c130e1a、唯一审计重试task_f7fbdb9b56（sess_401af97725）completed，observed grok-4.6，session已end。src/adapters/node/workbench-package-upgrade.ts、tests/workbench-package-upgrade.test.ts、taskdoc。root接线shared/API/schema/typert/host/client/maintenance/supervisor/doctor。新增workbenchPackage查询与workbench.upgrade预览；服务端绑定摘要，客户端仅catalogId/version。模块回滚复用Coor.restore/recover，凭据outcome=succeeded/rolled-back/abandoned；当前监督不关闭，冷启动payload纳入内容读回。
- Grok前端task_9a10c37cab/sess_442f4578c3 completed并end，observed grok-4.6；实际改components/store/i18n/tests/workbench-ui.test.tsx。派工工具write_paths没有自动成为可见prompt，叶子误以为“5个文件”没列名，使用已有UI测试；root接受这4个无冲突文件并审查，后续派工务必在message内重复精确文件列表。root修复候选刷新只匹配实际升级jobId，不能被旧plan.execute终态触发。
- 根进一步修复包升级：嵌套settlement必须同plan/snapshot；成功或回滚必须有snapshot；abandoned不能有snapshot；开始写settlement后持久化失败不得另开回滚；活动marker错误保持job recovery-required；markPlan持久化失败保持恢复态。新增root反例。前后端/模块/维护99项曾通过（后面新增1条nested测试，最终全套需重跑）。doctor默认受限进程回归4项失败，按授权运行后12/12 PASS：`.sandbox/workbench-doctor-package-escalated-root.log`，不是靠改测试期待。
- 强制恢复实测原始输出分别保留：workbench-restore-crash-root是夹具ESM require构建失败（补生产同款banner）；workbench-restore-crash-retry-root触发kill成功但脚本调用不存在/jobs且没显式acquire；workbench-restore-crash-api-root显式acquire后发现真实产品死锁：旧事务锁挡ensureManager。root让既有身份只读加载，启动见事务锁进入恢复；显式resume核验并保留活/模糊进程，才unlockDead。7项聚焦回归PASS。
- 真实同一崩溃Home继续恢复PASS：`.sandbox/workbench-restore-crash-recovered-root/results.json`，原Home为workbench-restore-crash-api-root/restore-kill/home-IRdVDJ；通过最新packed supervisor recovery.resume，不用doctorfallback；after.hash=原changed.hash，改名/数据保留，exact原job f1715bcf-c562-44eb-8298-ea1c9aca6310按回滚failed，manager running/recoveryRequired=false。脚本新增--resume-from，验证原artifact hash、隔离Home及资源目录后复用原强杀证据，不重造成功数据。
- doctor新增管理包恢复；检查unfinishedPlanIds改为只读遍历，避免创建JobStore在运行时校验失败前改queued任务。源码类型已发现workbench/locked不在Supervisor错误枚举并改busy，最新最终类型仍需跑；最后正式build在`.sandbox/workbench-cold-lock-build-root.log`（之后还有小修）。
- 当前真实进程测试：`scripts/verify-workbench-crash.mjs --phase upgrade-throw --with-browser --output .sandbox/workbench-upgrade-rollback-root`，exec session19515，日志`.sandbox/workbench-upgrade-rollback-root.log`；串行等待，不另启DSH/Electron/浏览器测试。
- 管理包真实验收脚本叶task_9dfc50c798/sess_ade58be929 completed，observed grok-4.6，初稿20自检，无真实测试。仅scripts/verify-workbench-package-upgrade.mjs、tests/fixtures/workbench-package/driver.ts、taskdoc；唯一审计重试尚未用，session保留。已知待修：旧manager没有新更新UI，成功要走独立维护页；driver“首包已安装”目前只检查旧文件存在，必须记本次真实成功add及前后hash；UI请求需抓exact plan/job响应，不能随便新plan.execute即认通过。
- 独立维护页更新入口Grok正施工：task_c77e68a831/sess_c8bc9da82f，唯一持有src/adapters/node/workbench-http.ts的renderEntryPage段、新tests/workbench-entry-update.test.ts、新taskdoc。正常入口“维护”按钮+/?maintenance=1，保持manager iframe挂载；独立检查候选→预览→确认→持久job，旧manager/损坏manager也可更新。root暂停改该文件，等交接后审查并给上条验收叶一次聚焦重试。
- 浏览器异常脚本root修：Windows创建时间显式ISO UTC，清理/故障触发前重验完整PID+父PID+精确创建时间；清理失败记录fail；认证只401/403并要求正常cookie先成功；提前崩溃不冒充timeout；Home必须真实路径等于theme成功Home。16 selfchecks PASS，仍未实跑。
- 仍待：自更新真实成功安装及冷payload、rc2完整候选与rc1→rc2、外部实例协议选择、最终全套类型构建/打包/真实桌面/主题/异常切换/新版录像和窄提交。升级失败/kill最终闭环与自更新回滚：**已撤销**（2026-09-15，改验失败可见且无抢救）。最新HEAD仍6247b22，大量未提交成果保留，无推送/发版/版本变更；既有4段mmx配音继续复用，勿重复生成。
