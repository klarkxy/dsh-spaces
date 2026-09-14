# 历史代码恢复

## 目标与来源

用户于 2026-09-13 要求在 `C:\0 code\DSH Space` 恢复原 D 盘项目：Codex 编排、整合与验收，Grok 执行恢复；同时检查旧 Grok / Kimi 施工记录。

- 当前恢复分支：`codex/spaces-recovery`。
- 远端基础：`https://github.com/klarkxy/dsh-spaces.git`，`main=dfe9ae0ed760ee1e6fe9e9d9e5d057e9451981b7`。克隆成功，Git 完整性检查通过。
- 旧任务：`01a08ef8-bfce-7890-86e2-d3ef89edeb39`，“按方案推进插件化改造”。
- 原始需求报告：`6aa38ae2-c7fc-83ec-8054-15d81964ac72`，“评估插件化必要性”。全文已读取；更晚用户决定优先。
- 旧分支 `codex/spaces-pluginization`，最后核实本地提交 `6247b22` 未推送，后续仍有未提交改动；新克隆中不存在该对象。
- 恢复材料位于 `.sandbox/history-recovery/`，原文来源保留在 C 盘。本目录只保存所需源码证据与摘要，不保存认证信息。

恢复目标是尽可能还原故障前的实际代码和任务状态。历史尚未完成的验收仍标未完成，不将本次恢复自动包装为旧计划全部交付。

## 当前有效需求

原报告提出共享核心、Web 插件、薄桌面壳和 doctor CLI。后续已批准的工作台方案扩展并取代其早期 MVP 范围：

1. Windows 本机浏览器；独立监督进程和稳定入口，专用管理环境，普通工作空间不承载完整管理器。
2. 固定左侧空间栏，右侧独立空间视图；最后选择生效、失败保留当前空间、已访问视图保活。
3. 桌面和 Web 同一 Home 单一控制者，进程身份核验与事务锁分离。
4. 插件管理、快照与配置恢复、运行时安装升级、管理包自身维护；停机进度与带外恢复仍可用。
5. 恢复与维护保留原数据语义、凭据边界和未知状态；不自动接管未登记的外部 DSH。
6. `0.1.5-rc.1` 为原验收基线，`rc.2` 只有真实验证后才能声明支持。

完整历史需求见 `.sandbox/history-recovery/original-requirements-report.md` 与 `latest-workbench-plan.md`。其中旧路径、旧授权、旧测试状态只是证据，不证明本目录当前验证通过。

## 分批恢复与责任

| 批次 | 作者 | 写入范围 / 产物 | 门槛 |
| --- | --- | --- | --- |
| 原主任务材料提取 | Grok，`task_1aa1e5205d` / `sess_53221dd8c9` | `extract-history.py`、`extracted/`、提取报告 | 来源行号、时间、调用状态、完整性；抽样匹配原文 |
| 旧 Grok / Kimi 材料提取 | Grok，`task_f4cd9ae894` / `sess_e346b98d5f` | `extract-bridge.py`、`bridge-extracted/`、提取报告 | 按项目/时间筛选，保留成功状态与编辑语义 |
| Grok / Kimi 原生会话提取 | Grok，`task_4ba05fc15a` / `sess_d7cf071635` | `extract-native.py`、`native-extracted/`、提取报告 | 仅原项目目录，完整写入/快照优先，保留工具结果 |
| 暂存重放 | Grok，`task_f535098f0d` / `sess_f34392db71`，medium | `replay-history.py`、`staged/`、重放报告 | 单条失败不半写、重复去重、来源链、缺失和冲突 |
| Grok 前后完整快照 | Grok，`task_fc723167c9` / `sess_9763d1cfc8`，grok-4.6/medium | `extract-rewind.py`、`rewind-extracted/` | captured_at 顺序、原文哈希、补齐仅替换的文件 |
| 还原源码 | 后续明确派工；单一合并作者 | 已核实补丁、完整文件；冲突清单 | 时间顺序、基线匹配、禁止执行任意历史命令 |
| 独立验收 | Codex | 来源审计、实际差异、类型/构建/聚焦测试、运行验证 | 区分原文恢复、推断重建、未找回、历史未完成 |

主 Agent 独占 Git、共享接口决策与最终记录。子任务不修改 Git、不提交推送、不修改工具/provider/审批配置。当前没有推送、发布或付费生成媒体授权。

## 故障前已知未完成项

以 C 盘故障 checkpoint 为准：管理包实际升级/回滚/冷恢复、旧管理界面升级入口、运行时提交阶段故障注入、rc.2 完整兼容验证、最终桌面/浏览器回归和新录像仍有缺口。原盘忽略目录中的录像、配音和隔离 Home 不随 Git 取回。

## 当前验证状态

- 基础仓库克隆与 Git 对象完整性：通过。
- 原始需求和最新工作台方案：已读取并保存。
- 新目录源码恢复、依赖安装、类型检查、桌面及插件构建：通过，具体范围见文末最终验收记录。
- 真实 Web 工作台基础流程和开发版 Electron 流程：通过。安装器、完整主题/故障矩阵及故障前未完成项仍不视为交付。
- 本次执行派给 Grok，Codex 完成来源抽查、冲突审计、整合和独立验证；所有本次 Bridge 工作会话已结束。

## 2026-09-13 第一轮取证进展

- Bridge 叶子已生成提取器与清单；主 Agent 核对了三个原日志位置，路径标题一致。50 个相关 transcript 涉及 369 个源码路径；工具层没有完整 contents/diff 或结果字段，所以该组仅用于缺口与顺序索引，不作直接源码恢复依据。
- 主任务叶子初轮长时间停留在 schema 探索，未交付所属产物，已取消并在同一 session 唯一聚焦重试：`task_0b61f70018`，明确请求 `medium`，优先提取已知 FileChange 完整差异。
- Bridge 初轮在取消时已经写出产物，主 Agent 接手验证后结束其 session；没有继续扩大读取。回执显示两项初轮实际为 `grok-4.6 / xhigh`，首次请求未指定该强度。后续有界提取显式用 medium，避免继承过高默认。
- Bridge 的 `files_changed` 会混入其他作者并发编辑，不能据此归属产物；每项归属按派工路径和真实工具记录确认。
- 原生会话叶子初轮已得到 probe，未交完整提取器；同一 session 唯一聚焦重试 `task_d2ddde7d1c`，明确 medium，优先实际 write/search_replace 工具参数。
- 主会话候选首批已落盘：1,342 条，含 224 条补丁候选与 56 条完整文件候选，路径 144 个。322 条 FileChange 候选中包含历史主 Agent 的真实文件操作。主 Agent 逐字核对了早期 shared DTO、任务文档和后期 workbench 文档三处原始记录；1,312 条非空 body 的 SHA256 均一致，30 条空正文采用空 hash sentinel，不是内容损坏。
- 已安排独立暂存重放；产品根目录暂未应用恢复代码，依赖和运行验证尚未开始。
- 主会话最终提取为 1,379 条 / 146 路径，含 228 补丁候选、60 完整文件候选；过滤规则曾误排含 password/secret 的普通源码，Grok 修正后主 Agent 重新核对 1,349 条非空正文哈希和新增原文样本，均通过。
- 原生提取完成：3,707 条 / 307 路径；187 次整文件写入、1,025 次 old/new 替换、23 个完整快照；144 个路径有成功全文来源。主 Agent 核对 Kimi remote.ts 快照、Grok isolation.ts 写入、spaces-core.test.ts 替换与原始工具参数，均逐字一致；所有非空 content 哈希一致。两个提取 session 均已结束。
- 重要调度修正：两次同 session 仅传 effort=medium 被 Bridge 忽略，警告需要同时指定 modelId；实际仍为 grok-4.6/xhigh。没有把请求强度当实际生效。后续派工需同时指定已可用 model 与 effort。
- 原生提取报告指出尚未处理 rewind_points.jsonl；主 Agent 实际检查最新两份文件，确认 `file_snapshots`/`after_snapshots` 含 path/content/captured_at。新增独立叶子提取这类完整快照，用于减少不必要的片段重建。
- Rewind 首批：1,102 条快照记录 / 239 路径；时间窗内最新完整正文覆盖 165 路径，包括工作台前端全部 10 个文件。主 Agent 核对所有字符串 content 哈希，并逐字对齐 app.tsx、store.ts、workbench-package-upgrade.ts 三份原快照。空 content 保留为“不存在语义未确认”，不自动执行删除；早于任务的快照只作补充。
- 暂存重放因新增完整快照调整了一次，延续同 session：`task_eb8801ce76`，明确 `model=grok-4.6, effort=medium`。要求按 captured_at 合并快照并重放后续补丁，保留未解决冲突。初轮重放回执确认 fresh-session 的 medium 实际生效；需要同时带 model 的限制针对 live-session 改强度。
- 暂存初稿已生成 332 文件，但未接受。主 Agent 复现点文件路径丢失、../ 被错误去前缀、同秒时间字符串排序错误、510 条窗口前快照误应用、标准diff末尾换行被当空上下文、先写后验hash等问题。具体反例保存在 `.sandbox/history-recovery/replay-audit-feedback.md`。已交同一 Grok session 进行实际审查后的单次修正 `task_17db64700d`。
- 暂存相对导入检查只缺三类模块：node/home-controller、node/home-operation-lock、desktop/home-control。主 Agent 定位到 native/rewind 的 `any(p.startswith('home-') for p in parts)` 误排源码文件名。独立窄修复 `task_4e59eb9db4` / `sess_782030f8ad` 负责两个过滤器并写 `home-filter-fixed/` 新候选；不并发覆盖正在被读取的旧候选。
- Home过滤修复完成；主 Agent 核对新两组所有正文哈希，并检查staged归属标记/绝对路径后亲自复跑Grok重放器，使用home-filter-fixed输入：native 3,842、rewind 1,114。暂存337文件、23未决，缺失模块补齐。此后禁止再重跑整树覆盖正在解决冲突的文件。
- 剩余冲突逐文件恢复阶段，写入者已转交：Grok `task_aaf3b6d30e` / `sess_c8cc0ae834` 负责 staged/main index、home-guard、atomic、typert.host、workbench-maintenance、cooperative测试；Grok `task_714bd1390d` / `sess_a7906609a5` 负责 package.json、themes/crash脚本、spaces-lock测试。两者写resolutions/runtime或tooling保存最终副本、来源和哈希，均grok-4.6/medium。主Agent负责依赖和最终验证。
- 依赖：主 Agent 在当前根目录按远端基线锁执行 npm ci，418包安装完成，Electron 37.10.3存在。尚待最终恢复manifest核对。
- 保留下来的隔离DSH runtime现场核实：`C:/Users/admin/AppData/Local/Temp/spaces-runtime-install-fIEaas/versions/0.1.5-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js`存在，CLI package=0.1.5-rc.1；同目录SDK包均0.1.5-rc.2、cordis4.0.2、loader1.0.3、zod4.6.2。不是生产Home，不需原D盘。
- 主 Agent 在staged创建指向当前根node_modules的临时junction，仅供验收、不复制到交付根。默认沙箱拒绝构建目录写入，正常本地权限重试后 core-only build通过；共享核心7项契约测试通过；另25个非冲突.mjs脚本语法检查通过。尚未完成全量类型/构建/运行。
- 两个逐文件冲突叶子均完成，23项未决已有原文/行号定位或空操作证据。主 Agent 核对10文件副本哈希；package.json完整语义对象与历史C01066读取完全一致，固定SDK依赖/脚本恢复。C01231已核对为同call空操作，失败的第二段补丁没有误应用。
- 已将215个新增/更新文件合入当前根，336交付清单文件全部SHA匹配；无删除。`delivery-manifest.json`是精确清单。package-lock因原最终锁未找回，按恢复的准确依赖重新生成，保留baseline-package-lock.json。额外29包安装完成。
- 当前根已通过 npm run typecheck（node+web）、typecheck:spaces、build（Electron）、build:spaces（core/plugin/view-bridge/supervisor/doctor）。完整现有测试集正在串行执行，日志 `.sandbox/history-recovery/validation/tests.log`，exec session 需以工具最近回执为准。真实GUI尚待。

## 2026-09-13 最终恢复与验收

恢复代码已交付到当前目录。产品版本保持 0.2.0，分支 codex/spaces-recovery，HEAD 仍是远端基线；没有提交、推送或发布。本次恢复不是对旧施工计划全部功能的验收结论。

### 原文恢复与本次修正

- 初次交付合入 215 个新增/更新文件，无删除；336 项文件哈希核对通过，原始清单保留在 .sandbox/history-recovery/delivery-manifest.json。
- 最终依赖锁原文没有找回，package-lock.json 根据与历史完整读取一致的 package.json 重新生成。基线锁保留为 baseline-package-lock.json，不称为原锁逐字恢复。
- 两份 Web DOM 夹具从原 Grok 写入记录恢复，并仅执行历史中有证据的导入路径调整：tests/fixtures/workbench-ui/host.tsx、child.html。Codex 独立比对原始工具参数与最终全文。
- XP 原版夹具从固定发布包 dsh-client-ui-theme-xp@0.1.1 取回，仅提取 client.js/package.json/LICENSE，未执行安装脚本。client.js 的 SHA256 为 64f1f7e3555237c637112091647932e1418aca5f0d3ba399e261d94a33c83ee0，与历史预期完全一致。
- 三份测试作了明确的恢复后修正：维护响应测试的临时 ESM worker 加入与生产构建一致的 createRequire banner；Host API 严格清单补上实际存在的 workbenchPackage；工作任务投影测试补齐 entryOrigin，并增加非本机来源/含 token 来源拒绝用例。未修改产品保护逻辑，也未放宽性能门槛。详情在 resolutions/fixture-compatibility/ 和 resolutions/contract-tests/。
- 原始交付清单不覆盖上述后续修正；最终文件哈希与差别另存 final-delivery-manifest.json，保留来源恢复和验收修正的区分。

### 实际验证结果

| 验证 | 当前目录结果 | 证据 |
| --- | --- | --- |
| 类型检查 | node/web 与 Spaces 均通过 | npm run typecheck、npm run typecheck:spaces |
| 构建 | Electron、core/plugin/view-bridge/supervisor/doctor 均通过 | npm run build、npm run build:spaces |
| 首轮完整测试 | 503 项，486 通过、17 失败 | .sandbox/history-recovery/validation/tests.log |
| 失败文件修正后复验 | 涉及的全部 59 项通过，0 失败、0 跳过，退出码 0 | .sandbox/history-recovery/validation/failed-files-retest.log |
| 真实 Web 工作台基础流程 | 通过；打包插件及 supervisor、真实 DSH rc.1、隔离 Home，无模型调用 | .sandbox/history-recovery/runtime-product-retry/results.json |
| 真实 Electron 开发版 | 通过；窗口、空间打开/重启、名称修改读回、停止退出、自有端口关闭 | .sandbox/spaces-desktop-acceptance/results.json |
| 已跟踪差异空白检查 | 通过；仅有 Windows 换行提示 | git diff --check |

测试结论来自“完整首轮 + 所有失败文件复验”，没有声称又进行了一次全量 503 项全绿运行。失败项均落在已补齐夹具和已更新的三份测试中；其余产品源码保持通过类型/构建检查时的内容。

Web 验证确认独立管理器启动、固定空间栏、coding/notes 启动并嵌入真实 DSH、普通空间只带轻量桥，以及管理器停止后稳定救援页和 API 仍可用。截图中的嵌入空间有真实 DSH 首次引导框；没有测试模型对话或声称完整主题/维护矩阵通过。Electron 测试为 packaged: false，未重新制作或验证安装器。

截图：.sandbox/history-recovery/runtime-product-retry/workbench-two-spaces.png、manager-stopped-rescue.png、.sandbox/spaces-desktop-acceptance/coding.png。验证进程已结束，测试未使用原用户 Home。

### 保留的缺口与后续边界

1. 原 6247b22 Git 提交对象/完整提交图、旧录像与配音、原隔离 Home 没有恢复；恢复的是有日志和快照证据的源码与需求状态。
2. 故障前未完成的管理包实际升级/回滚/冷恢复、旧管理界面升级入口、运行时提交阶段故障注入、rc.2 完整兼容验证仍需另行推进。
3. 完整主题和浏览器失败场景、新演示录像、安装器验收仍未由本次基础运行验证覆盖。未登记外部 DSH 的发现与接管协议仍是未决事项。
