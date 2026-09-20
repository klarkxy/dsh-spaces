# 合并执行与验收记录

2026-09-20 开始。计划：[spaces-merge-convergence.md](../docs/plans/spaces-merge-convergence.md)。活动状态只在 [todo.md](todo.md) 维护。

## 基线

- 分支 `codex/spaces-reconcile`，基于 `c22c47fd37629e3bb852f7702d68624d3a73453d`。
- 工作树 `.sandbox/worktrees/spaces-reconcile`；原主工作树 `main@1f339ac` 保留。
- 原始提交备份标签：`pre-reconcile-main-20260920`、`pre-reconcile-pluginization-20260920`。
- 原 stash 对象 `7ecafc6a8f5563130e4465b8b3f69c208235f1a5` 保留，未应用。
- `npm ci --no-audit --no-fund` 完成；Node/Web/Spaces 三组类型检查已通过。其余构建和测试进行中，日志在集成工作树 `.sandbox/merge-baseline/`。
- 基线测试去除脚本间重复文件，并以 `--test-concurrency=1` 串行运行；包括未接入默认入口的 `workbench-package-upgrade.test.ts`。尚未宣称整体通过。

## 首批 Grok 审计

| 分区 | 路径数 | Task ID | 写入范围 |
|---|---:|---|---|
| 后台与领域 | 68 | `task_f591f56977` | `tasks/merge-audit/runtime.json`、`.md` |
| 界面、分发与测试 | 125 | `task_584a9baf84` | `tasks/merge-audit/interfaces.json`、`.md` |
| 文档与历史 | 86 | `task_12665db697` | `tasks/merge-audit/evidence.json`、`.md` |

三个任务共用冻结的 main/old/imported 提交，各路径恰有一个审计所有者；产品源码只读。所有 Grok 调用均省略 model/effort 覆盖。主 Agent 负责核对报告完整性、缺失候选、真实 diff 与验收，不以 worker 完成状态代替审计结论。

## 验收限制

本文件尚未记录任何新产品能力通过。单测、真实 CLI、浏览器、Electron 和最终安装包证据分别登记；未跑即未跑。测试只用一次性 Home，不触碰真实 `~/.dsh`。

## A0/A1 验收

三个分区合计 279 行，逐行字段/引用/路径集合通过主 Agent 校验；另有 3 条 old→imported 差异不在 old→main 集合，托盘与进程测试已与旧分支字节相同，ControllerStatus 在旧分支和当前主线均不存在。合计 282 个并集路径无待归类项。

初判 242 已覆盖、33 被后续政策替代、4 遗漏。4 项均为文档/验收脚本：正常备份说明及演示源台词、失效的接管徽章等待、rc2 脚本的个人机器路径；Grok 修正后主 Agent 读回并做 JSON/语法检查。未把静态脚本检查声称为真实 UI 通过。总表：[acceptance.json](merge-audit/acceptance.json)。

完整基线 641 tests：638 pass、2 fail、1 skip。两处失败均为 Windows 测试移植问题；修正后主 Agent 独立复跑两文件，8/8 pass、0 skip（含先前失败的两项）。未无理由重跑其余 633 项。三组类型检查和两种构建均通过。可选官方 CLI 实测、真实浏览器与安装包启动仍未跑。

首次受限沙箱运行因 taskkill 被拒绝未正常结束，已核实测试主进程身份并清理整棵所属进程树。上述 641 项来自具备测试子进程管理权限的第二次运行，不能引用首次部分输出作为通过。

另发现主线 `withMaintenance` 在部分失败后仍调用 reinitializeManager；B2/B5 将删除该可达的失败重启/补装链，并加真实故障验证。历史“产品路径已符合”文字和当前绿测不能覆盖这个缺口。

## A2 历史接续

本地检查点：`515ad38`（Windows 测试移植）、`29e3eff`（语义审计、保留行为补丁和迁移合同）。合并提交 `d8a692d1fa8c91600782abaa15f96a08da75878e` 的父提交为 `29e3eff5e6ba540c97c5ac9ebe483e9d80feea77` 和 `51911e481961408ad77758b0123653c0fc1e2bdd`。merge 前后 tree 均为 `8b8c0294a9bae1dad8ca0a9b9797be3e52a1de37`，祖先检查通过。

这只完成历史接续，B1–B6 尚未验收。主工作树仍保留原 main，未推送。报告 Markdown 中的显式换行空格在后续文档清理时规范化，不影响 merge 的树等值证据。

## 补充 CLI 基线

2026-09-20：在独立临时工具目录安装官方 `@deepseek-ai/dsh@0.1.5-rc.2`（本次查询的 latest）和 `pnpm@10.29.2`，不修改全局安装或真实 Home。主 Agent 使用 `DSH_TEST_CLI_BIN` 执行 `tests/compatible-dsh-cli.test.ts`，3/3 pass、0 skip，包含此前跳过的真实 CLI 用例。只证明 CLI 兼容与 web 路径保护；不代表标准插件安装、真实双端或桌面安装包通过。

## B 阶段中间验收

- 协议合同：主 Agent 纠正了摘要忽略空间顺序的问题，并要求将含 `node:crypto` 的实现放回 Node 层；Grok 修正后主 Agent 独立复跑 11/11 pass。Host、Supervisor 和界面接线尚在进行，B1 未整体通过。
- 桌面连接器：初版遗漏了 handoff 等待期间 dispose 的晚到结果保护；修正后主 Agent 独立复跑 17/17 pass。只证明连接器编排，不等于 v2 实际认证或 Electron 已通过。
- 产品服务：主 Agent 独立复跑 77/77 pass；额外临时 Home 复现损坏设置回默认、损坏插件库变空列表、模板复制凭据三项缺口，已退回修正。尚未接入 Supervisor，不予整体验收。
- 运行锁交接：主 Agent 独立复跑 31/31 pass，包含真实子进程竞争；重要完整性审查进行中，正常升级启动器尚未接线，B5 未整体通过。

## B 阶段后续检查点

以下为本次主 Agent 独立验证，取代上节相应子项的中间状态；B1–B6 的整体验收仍待真实流程完成。

- 产品服务修正损坏设置、损坏插件库和模板凭据检查后，89 项通过。运行锁修正 Home 摘要和 epoch 绑定后，33 项通过；原子替换失败注入保留运行权原字节。
- 桌面壳 25 项通过，包含 CJS preload 的真实 Electron 小型探针、准备/启动去重与冻结目标的停止全部操作。共享工作台 53 项通过，其中 3 项为浏览器 DOM 夹具，不代表真实 DSH 双端流程。新增交接待确认显示检查 1 项通过。
- Node 运行时、任务及维护阶段检查 96 项通过；随后修正脱离队列的异步后代继承门禁问题，任务组 30 项通过。正常运行时安装与升级失败不回滚组 26 项通过。
- 28 个公共模块迁至 `src/adapters/node`，删除 4 个无消费者模块，更新 291 处引用。迁移后 Node/Web/Spaces 三组类型检查通过；默认回归 251 项全部通过、无跳过。
- 归档与冷启动接线 25 项通过：清单版本/额外字段和实际文件摘要在停机前验证；`--component-payload` 冷启动绑定同组 worker 与资源。它不代表旧 Supervisor 到新 Supervisor 的交接已验收。
- 真实官方 CLI 仍使用临时工具目录中的 rc.2。标准插件安装脚本和桌面双端脚本正在修正 v2 调用与终止断言；实际安装、完整双端、组件切换及最终打包启动尚未通过，不引用历史结果代替。

## 实际流程与最终审查检查点

2026-09-20。本节记录当前验证结果，B 阶段尚未整体完成。

| 检查 | 主 Agent 结果 | 证据 |
|---|---|---|
| 官方 CLI 空间隔离 | 通过；三个 profile 的真实会话及持久化隔离 | `.sandbox/isolation-live-primary.log` |
| 官方 CLI 生命周期 | 通过；单独重启 coding，其余两个空间会话保持 | `.sandbox/lifecycle-live-primary.log` |
| 空间回归 | 88/88，无跳过，含真实官方 CLI | `.sandbox/spaces-final-primary.log` |
| 模型配置与路由回归 | 72/72 | `.sandbox/llm-final-primary.log` |
| 模型多进程集成 | 5/5；本地测试端点，无真实模型调用 | `.sandbox/llm-integration-final-primary.log` |
| 浏览器 DOM 与更新夹具 | 7/7；不代表真实 DSH 双端 | `.sandbox/browser-fixtures-final-primary.log` |
| Supervisor 交接 | 16/16，含启动管理器失败时保留运行权、关闭 HTTP、拒绝成功回执 | `.sandbox/supervisor-final-primary.log` |
| 标准插件安装 | 普通 web 安装成功，首次初始化失败；不得认定通过 | `.sandbox/final-standard-install/results.json`、`.sandbox/standard-install-diagnostic/results.json` |
| 构建和本地 Windows 包 | 本轮曾构建成功；早于最终两项 P1 修复，须重新生成和验证 | `.sandbox/final-build.log`、`.sandbox/final-desktop-package.log` |

[重要集成审查](merge-final-integrated-review.md) 在捕获基线上发现两个 P1：管理器未就绪仍确认交接成功，以及下载正文停滞导致取消无效、占住写队列。前者修复后上述 16 项通过；后者的修复正在完成独立验收。标准插件安装的当前真实失败是 manager 首次插件安装退出 `4294963248`，监督进程仍可响应；另一次手动重试成功不是首次初始化通过证据。

组件更新和桌面运行前检查已通过，但完整组件更新、Electron 与浏览器双端、正常维护产品流程及最终打包位置启动尚未完成。四个旧恢复/接管验收脚本已明确退役，主 Agent 验证调用均非零退出且不执行旧流程；现行替代入口见 [退役记录](merge-b5-docs-legacy-cleanup.md)。

## 最终流程复验（更新于 2026-09-20）

以下结果取代上节同项的中间状态。尚未完成的项目仍单独列出。

| 项目 | 当前证据与结论 |
|---|---|
| 标准插件完整流程 | `.sandbox/standard-install-final6/results.json` 为 pass：普通 web 安装、显式初始化、空间创建/启动/视图握手、再次进入、关闭重开、服务关闭及卸载。关闭以精确 requestId/planId 的持久化任务、进程死亡和端口关闭为证，非 HTTP 成功；无强制清理、无遗留端口。安装本轮未触发重试，脚本已进一步改为单次安装。 |
| 运行时真实安装/升级 | `.sandbox/maintenance-final4-primary.log` 的 runtime 阶段完整通过；真实外置运行时、精确版本解析、requestId 去重/冲突、升级后管理器运行、服务 epoch 不变、显式关闭。该文件的插件与快照阶段失败不算通过。 |
| 插件真实安装/移除 | `.sandbox/maintenance-exit-probe3/results.json` 为 pass：实际安装和卸载主题，校验 manifest/lock/node_modules 与 web 路径，拒绝 config.restore，并完成服务关闭。测试带进程退出诊断记录；不是未加诊断的全新运行声明。 |
| 正常快照管理 | `.sandbox/snapshot-final5/results.json` 为 pass：创建、列出、拒绝恢复、删除、同 epoch 下成功后重启管理器及服务关闭。 |
| 缓存多版本与文件引用 | `.sandbox/cache-identity-final3-primary.log` 为 54/54；独立审查的实际 junction 误删复现转为通过，另验未知文件身份拒删、有效不同归档可删。见重要集成审查的 closure。 |
| 桌面首次目录准备 | `.sandbox/desktop-firstboot-final-primary.log` 为 29/29；只创建未配置时的默认 snapshots 目录，已记录路径缺失或不合法时拒绝，不替换为默认目录。 |
| 类型与构建 | `.sandbox/typecheck-final7-primary.log`、`typecheck-spaces-final7-primary.log` 和 `build-final7-primary.log` 均通过。 |
| 分发静态检查 | `.sandbox/secrets-final7-primary.log`、`llm-distribution-final7-primary.log`、`package-preflight-final7-primary.log` 通过；秘密/恢复产品扫描、LLM 打包、完整组件及不夹带嵌套 tarball 检查。 |
| 最终组件更新 | `.sandbox/component-update-final8/results.json` 为 pass：真实官方 CLI 安装、浏览器 Prepare/预览/确认、精确制品切换、旧授权拒绝、新管理器就绪和最终交接回执、无额外冷启动、受保护路径保持，以及持久化任务确认的服务关闭。版本源为本地 HTTP 测试仓库，未发布 npm。 |
| 最终 Windows 包 | `.sandbox/package-final7-primary.log` 通过；`.sandbox/desktop-final8/results.json` 为 pass，实际运行 win-unpacked 程序并确认 app.isPackaged。真实桌面/Chromium 同一活动任务、桌面退出后完成、显式服务关闭全部通过。未执行 NSIS 安装器、未验证安装登记或系统卸载。 |

真实流程发现并已修正的产品问题包括：状态轮询将初始化暂态错误永久锁定；自动端口可能选中浏览器禁止端口；首次桌面启动缺少默认快照目录；缓存按包别名误判其他版本占用，以及后续修正中漏判 junction 引用。管理器就绪后才能确认交接、下载正文取消/超时，以及对应失败保留运行权/不回退的两个 P1 也已闭环。

保留证据限制：最早两次标准安装中的 Windows EPERM 与一次插件流程 Supervisor exit 1 未找到可证实原因，后续分别完整通过，不能将它们归因于后来找到的其他问题。一次快照启动失败已独立证明是 Fetch 禁止端口。组件更新 final6 的 one-shot 回执检查和 final7 的过早文件存在性基线属于验收脚本问题，final8 已完整通过并记录匿名身份在更新前的官方启动阶段首次出现。桌面 final7 的重复按钮定位和 Playwright close 等待后台句柄问题经脚本修正后，final8 通过；桌面 PID 实际退出与后台任务继续均分别确认。所有验证均使用一次性 Home；无真实模型调用、无 npm 发布或远端推送。

### 计划矩阵对应证据

| ID | 验证边界 |
|---|---|
| V01 | Home 锁与真实子进程竞争、已接受运行权启动、插件 attach 与组件更新不额外冷启动；桌面同服务连接另见最终桌面流程。 |
| V02 / V06 | 任务 requestId/参数指纹和持久化回执回归已通过；desktop-final8 中桌面和浏览器观察同一 running job `6491ee30-af27-4df6-b205-88e49b85c08f`，Electron 进程退出后 Supervisor PID 不变，该任务完成且浏览器显示 succeeded。最后显式关闭服务。关闭服务失败保留运行权的回归已通过。 |
| V03 | 协议/端点/Host 转发与预览条件回归，桌面实测旧 revision 被拒绝且名称未改写。 |
| V04 / V05 / V07 | 正常升级/维护失败不重放、不回退，启动失败/残留锁/未知实例不抢占；39 项 Doctor、合作子进程、响应性和 XP 边界检查通过，未执行完整 XP 平台安装。 |
| V08 / V09 | Host/iframe/epoch/跨 Home 认证、凭据专用通道、LLM 来源与分享规则测试；LLM 72 项、集成 5 项通过，分发秘密扫描通过，无真实模型请求。 |
| V10 | 产品完整性 89 项、迁移后默认 251 项及后续相关回归覆盖模板/分享兼容、秘密拒绝、模型映射和批次部分失败；没有将这些单测称为每条模板/分享路径均完成真实双端点击。 |
| V11 | 标准插件完整 CLI+Chromium 流程通过；最终 Windows 打包目录真实流程单独登记。NSIS 仅生成及目录检查，不代表注册/卸载验收。 |
| V12 | Launcher/锁/制品单元及真实子进程竞争通过，最终组件更新 final8 完整通过；停机或新管理器启动失败不交出运行权、不自动回退。 |
| V13 | 正常快照与运行时安装真实流程通过；恢复命令明确拒绝，快照既有资产不因退休恢复入口而删除。 |
| V14 | A 路径审计和历史连接已通过；本地 main 已快进到源码提交 `fdb6feb`，已确认远端 main `c22c47f` 与旧分支 `51911e4` 均为祖先。 |

回归结果按执行批次保留，避免把重复测试相加成一个虚构总数：迁移后默认 251/251、产品完整性 89/89、空间 88/88、LLM 72/72、LLM 集成 5/5、故障边界 39/39；后续下载边界 62/62、CLI/下载相关 26/26、端口/Supervisor/交接 58/58、缓存/产品 54/54、桌面首次启动 29/29。工作台其余组初跑 347 项中 5 项缺少 launcher 测试资源，补齐后该文件 26/26；另 1 项文件 symlink 创建因当前 Windows 账户 EPERM 未运行，目录 junction 及相关拒绝路径已实际通过。wire-error 与组件等待 helper 共 11 项的批次也通过。日志均保留在集成工作树 `.sandbox/`。

最终 Windows 候选：`release/DSH Spaces Setup 0.3.0.exe`，96,821,542 bytes，SHA-256 `14607e80f235dd345072307227250d55e08a047430cb57a5d45fb1483a84fb66`；Authenticode 为 `NotSigned`。打包目录与源码构建清单 SHA-256 同为 `61be28e550ff8660e98efcdf695f66019b2c06546c773e7eb1ce8bcd5463ea94`，payload digest 为 `32566edf50b5904ffaa1ec377a7f36e1a1c8ecffae63e90e6e9f64b6e7cb35e1`。macOS、Linux、正式签名、公开分发、NSIS 安装登记/卸载均不在本次实际通过声明内。

### 本地合入

源码与验收脚本保存为 `fdb6feb5ac2658a86f2b747d100eb3672205b066`。主工作树从 `main@1f339ac` 快进，保留 `d8a692d` 历史连接和后续分层提交；收尾文档沿同一分支另存提交后继续快进，不 squash/rebase。合入前再次读取远端，两条待合分支仍分别是 `c22c47f` / `51911e4`。

原 stash `7ecafc6a8f5563130e4465b8b3f69c208235f1a5` 和两条 pre-reconcile 标签均验证未改变。主工作树中未跟踪的最初计划及 preparation JSON 已逐文件校验 SHA-256 后保留到 `.sandbox/pre-reconcile-root-artifacts-20260920/`；未覆盖原内容。原有未跟踪 `.pnpm-store/` 保留。没有推送、发布、删除旧分支或执行真实用户 Home 操作。

本次最终制品与运行证据保留在集成工作树 `.sandbox/worktrees/spaces-reconcile/` 内：`release/` 是上文哈希对应的 Windows 候选，`.sandbox/desktop-final8/`、`.sandbox/component-update-final8/`、`.sandbox/standard-install-final6/` 为完整真实流程证据。后续重新构建产生的新字节须另验，不能沿用这些摘要。
