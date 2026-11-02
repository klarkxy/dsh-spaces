# 插件 LLM 集成验证结果：认证、工具、持久化与 replay

> 历史导航：本文件是 2026-10-21 的历史集成验证记录，只证明当时范围。现行架构见 [architecture.md](../../docs/architecture.md)；故障政策见 [let it crash](../let-it-crash.md)。文中与现行架构冲突的桌面壳、应用内升级、恢复、交接或旧 LLM 方案内容，仅作历史参考，不是当前合同或验收门槛。

日期：2026-10-21。依据用户本轮授权继续下一阶段集成验证；官方 SDK 固定，不提交、推送或发布。

**最终结果：26 项具名断言通过，指定 Astra 独立复核 READY，仅限本轮隔离集成验证。** 这是在隔离进程中接通真实 SDK 消费者的集成原型，不是 Supervisor 正式产品集成或完整 P0 验收。前一阶段 [三个阻断原型](llm-plugin-prototype-results-20261021.md) 的结论与失败记录继续保留。

## 1. 证据与实际装配

原型目录：`.sandbox/construction-20261021/p0-plugin-integration-1/`。

- 当前完整案例：`run-2026-10-21T12-07-03-516Z/RESULT.json`，26/26，退出码 0。
- 网络与工具审计：同目录 `AUDIT.json`、`FINAL-MAIN-AUDIT.json`、`FINAL-a-AUDIT.json`、`FINAL-b-AUDIT.json`。
- 官方会话落盘与重建对照：`resume-comparison.json`；初轮官方 Agent 日志：`first-turns.json`。
- 故意拒绝与错误：`negative-a-events.json`、`forged-a-events.json`、`expected-500-events.json`、实际重新读取的 `persisted-500-suffix.json`；包含真实会话事件，进程日志也保留。
- 资源根：`H:/Code/dsh-spaces-checktmp/plugin-integration-1792584423531`。每次案例新建 Home，失败现场不覆盖。
- 源审计：原型目录 `SOURCE-AUDIT-accepted.json`。817 个 S0 产品文件（包含原已删除文件的删除状态）一致，HEAD 仍为 `26aab5d`。八个实际 SDK 模块入口前后摘要相同，非整个 SDK 依赖树审计；六份核心原型源码与最终案例副本相同。

主进程 PID 46424 使用原始官方 `LlmRuntime` 与原始 `dsh-llm-pi-ai`，供应商凭据由主进程现场生成，只授权访问本地合成供应商。子空间 A/B PID 53516/50140，分别使用独立实例 bearer、官方 Agent loop、active 官方 retry、官方 JSONL persistence、官方 LocalAttachmentStore、LocalFileSystem 子类与官方 `read` 工具。子类仅统计读取，不替换文件读取实现。A 正常关闭后以新进程 PID 40500 打开原目录。

插件 facade 使用公开 `agent/request` 的精确 config 对象关联会话，在 `llm/stream` 默认文件投影与 replay 过滤前委派。每个网络请求由 bearer 对应的服务端来源和实例身份授权，不采用请求自称的 source。主进程 prepare 冻结官方调用，stream 使用同一官方句柄。

所有依赖来自已有、匹配的 rc.2 隔离 SDK；没有编辑上游、node_modules、真实 Home 或官方安装包。没有安装新依赖。普通非管理员进程在既有授权的仓库外临时根执行；没有修改 ACL。

## 2. 已验证的行为

| 范围 | 实际验证与边界 |
|---|---|
| 认证传输 | 真实 loopback HTTP 和 NDJSON，主/子为不同 OS 进程。错误 bearer、错误 instance、跨来源 session、body 自称身份和浏览器 Origin 全部拒绝，供应商零调用；撤销实例后不能 prepare。 |
| 冻结句柄 | capability 绑定账户对象、实例、session 和冻结 config；跨来源/会话使用拒绝，config 不同则消耗并拒绝，成功或失败后都不能再次派发。每实例最多两个未使用句柄；显式取消释放。 |
| 文件来源与路径 | A/B 保存相同内容、相同文件名，得到相同内容 ID、不同真实路径。子空间在 file block 仍有类型时校验本会话授权、元数据、内容哈希和路径包含关系，再调用官方 `projectFilesToText`。供应商夹具从该官方投影提取路径并返回 `read` 工具调用；没有另塞路径提示。 |
| 真正工具执行 | 真实官方 Agent 调用官方 `read`，通过官方 `tools/pre-execute` 权限瀑布，再进入官方 LocalFileSystem 的实际读取。供应商的下一请求包含官方工具读取结果与原生签名。两空间并发执行互不串路径。 |
| 权限负例 | 跨空间路径、外部路径、越界目标和真实 Windows junction 逃逸在工具文件读取前拒绝；同内容 ID 不授权别的会话。真实 Agent 提交未授权及伪造 bytes 的附件在供应商调用前失败，事件留存。 |
| 原生多轮 replay | 使用合成 Anthropic SSE 的 thinking/signature/tool_use，原始官方 pi-ai adapter 产生真实版本化 replayState，官方 Agent 记录真实 provider/model。签名经过跨进程流、工具往返、第二用户轮和落盘重开后再次出现在供应商请求中。不是手写会话 replay envelope。 |
| 真实来源过滤 | 将真实历史 assistant 的来源改为异源，保持原 replayState 不变，再通过主空间未修改的 SDK 派发；供应商收到的历史不含该原生签名。 |
| 持久化 | 官方 JSONL 后端写入、flush、read；同 session 并发第二 write handle 抛 `SessionAlreadyOwnedError`。正常关闭释放所有者后，新 OS 进程调用官方 `agents.resume`；旧事件前缀逐字段相等，仅追加 SDK 正常 `session/end-seed`。 |
| 正常重开与任务边界 | 重开和 resume 本身没有供应商调用。明确追加新的用户输入后才发出下一请求，原生签名顺序与旧事件一致。未打开中断任务、未触发失败任务重放或恢复流程。插件来源策略和附件授权从独立文件重读，旧 WeakMap 不存在。 |
| 取消与单次错误 | 悬停流已有 reasoning delta 后，锁定非敏感 auditId 的 lease 与 stream-end 均为 disconnected，且对应供应商响应确实 close、未完成，不重新派发。真实子 Agent 的 500 新增 turn 2 只有一次请求，error/attempt 为 SERVER/500；从官方 persistence 重新 read 的失败后缀逐字段一致。没有重连或启动替代进程。 |
| 隔离与清理 | 受检子 Home 的 `profiles/web`、根 `sessions`、根 `storages` 均不存在。审计不含 transport bearer；供应商只收到主进程的合成 credential。全部四个自有进程最终正常退出，文件证据保留。 |

“文件内容不传给模型”只指附件投影本身不发送文件 body。模型明确要求读文件后，工具返回的内容会进入模型上下文，这次集成正面验证了这一流程。

## 3. 失败记录及处理

所有旧目录保留原始 `RESULT.json`、当时脚本快照、进程输出及可用审计。修改夹具后只在全新资源根验证，不修复或续跑失败环境。

| 时间目录后缀 | 原始结果 | 已确认的原因与修正 |
|---|---|---|
| `11-57-15-863Z` | 3 项后断言失败 | 夹具只查看最后一条 user，实际 SDK 另加 working-directory user context，因此没有发出工具调用。检查实际装配后的消息段，并采用官方 schema 的 `file_path` 参数。 |
| `11-58-10-461Z` | 3 项后断言失败 | 相邻文本被 adapter 拼接，夹具把文件说明拼进工具路径，权限层正确拒绝。先明确分隔，最终彻底改为从官方文件投影提取路径，删除独立路径提示。 |
| `11-58-36-956Z` | 11 项后断言失败 | 初始将重开后整段日志摘要等同于旧日志，发现差异；不能据此判断内容丢失。 |
| `11-59-07-169Z` | 11 项后断言失败 | 完整逐字段对照确定仅多了官方 `session/end-seed`。改为严格旧前缀相等，并且只允许这一个正常重建边界；没有放宽为任意追加。 |
| `11-59-24-414Z` | 23 项通过 | 初次接通全部四项；随后补强投影路径来源、junction、真实 Agent 拒绝及成功句柄重复派发，另建最终 26 项案例。 |
| `12-00-31-242Z` | 初次 26 项，Astra REVISE | 实际记录显示取消及 500 正确，但断言可能借用旧 lease 或旧 turn 假阳性；不能直接据此宣布全部验收通过。 |
| `12-05-05-440Z` | 26 项通过，Astra 有界 READY | 增加确切 lease 审计 ID、上游响应关闭屏障及本次失败后缀的持久化重读；附件 containment 已前移到读取之前。 |
| `12-06-25-788Z` | 10 项后 EPERM | 补充磁盘内容损坏注入时，官方只读附件拒绝覆盖。SDK 实现确有只读发布；未改变权限、未修改旧现场，也不声称已经到达哈希损坏读取分支。 |
| `12-07-03-516Z` | 最终 26 项通过，Astra READY | 已授权专属 ref 后仅改 bytes，确认真实元数据不匹配且零附件读/供应商调用；traversal 输入保留原始 `/../../`。没有再注入磁盘损坏，边界明确保留。 |

最初 `SOURCE-AUDIT.json` 把 S0 已删除的三项当作新增缺失，得到错误漂移报告；原文件保留。修正删除状态判据后的 `SOURCE-AUDIT-final.json` 为零漂移，未恢复这些历史删除文件。

## 4. 本轮不提供的结论

- 认证注册由受信任验收父进程发放，loopback 通道是本轮插件原型；尚未接入正式 Supervisor listener、宿主元数据/注册链和真实产品空间实例发放。因此不是 G1/P2 已通过。
- 供应商是本地 Anthropic 协议夹具，不是实际 Anthropic 账户；没有读取用户凭据或调用外部模型。签名是协议夹具生成的非秘密字符串，验证的是官方 adapter 的生成、传输、来源过滤与持久化链路，不是供应商密码学有效性。
- 本轮工具权限为插件会话附件 grant，覆盖真实官方 read 执行及路径校验；没有验证官方权限 UI/审批流程、写工具、bash、权限变更竞争或整个 OS sandbox。Windows junction 静态越界通过，不代表所有 TOCTOU 场景通过。
- 本轮跨进程附件链路为文件；图像读取的原型证据仍在前一阶段，尚未把图像请求级回读、真实 `read_image`、DeepSeek adapter 接入本轮网络/持久化链路。
- 本轮 facade 仅针对聊天 prepare/stream 验证；configure 回调明确拒绝。完整模型发现、metadata 查询、UI controls/default provenance、正式标题服务和完整 compaction commit 仍待。
- 测试只使用完整、正常关闭的会话。没有验证或实现中断会话恢复；SDK 自身的损坏修复和 interrupted-turn 分支没有在这轮运行。
- 限额只覆盖两个未使用 prepare 句柄。协议超时/过期回收、完整 JSON schema、在途流配额、有限缓冲和长期服务内存边界尚未完成，不冻结生产 capability 契约。
- 生产文件未改，因此没有把旧全量检查结果冒充本轮新通过。S1 普通终端完整结果与 Desktop 四项仍待；真实正式包、Web/Desktop UI 验收未做，P0/P1 门槛保持。

## 5. 独立复核

指定 `gpt-6-astra` 代理已独立只读审查源码副本、实际审计、会话事件与必要的落盘文件，未修改文件或启动测试。首轮 REVISE 的两处验证漏洞已修正并新建案例；其后 READY，再对专属 ref 元数据负例和原始 traversal 输入进行最终复核。

最终结论为：**READY，以 `run-2026-10-21T12-07-03-516Z` 为准，本轮 26 项有界集成验证可以接受。** 原始复核要点与范围记录于原型目录 `ASTRA-REVIEW.md`。READY 不扩展至正式 Supervisor、完整协议、TOCTOU、图像、DeepSeek、UI controls 或 P0/P1 产品验收。
