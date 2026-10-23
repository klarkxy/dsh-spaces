# 正式辅助调用接入与验证（2026-10-22）

后续收口：三项检查已于本轮修复并在普通权限下完整 15/15 通过，三份文件为基线既有删除的误报；指定 Astra 再复核 READY。见 [检查收口报告](verification-closeout-results-20261022.md)，下列 12/15 是原阶段历史结果，原失败保留。

状态：正式标题、手动及自动上下文压缩已接入，修复首轮 Astra 的 R1/R2 后，最终源码五组运行共 **42 项通过**。完整 15 项检查已执行，12 通过、3 项临时文件写入权限失败。指定 Astra 最终独立复核 **READY（仅本轮固定 SDK 阶段）**。仅本轮有界接入验证，不关闭 S1/P0、完整 P1、稳定 capability 契约或安装版 Desktop 门槛。

## 范围与实现

用户授权仅修改插件，并允许 Magpie 的 MiniMax Flash 实机测试。官方 SDK 固定为 `0.2.1-rc.2`，没有修改上游、SDK 或 node_modules 源码，没有提交、推送或发布。所有运行使用独立 Home，不读取真实 `~/.dsh`，不写 `profiles/web` 或 Home 根 `sessions` / `storages`。证据根为 `.sandbox/construction-20261021/plugin-auxiliary-1/`。

- 主请求经正式 `MainLlmFacade` 准备后，将实际 provider/model、可见 controls 与对应官方 request/header 序号写入 `plugin:dsh-spaces/llm-binding`。辅助路由继承该次绑定；之后修改主默认不会改写历史辅助目标。显式辅助模型与 controls 仍由官方执行器选择和准备。
- 标题通过独立 Service 身份包装实际 provider，传递真实 Session，并通过公开 isolate/get 保留注册方生命周期。手动 `/compact` 包装原官方 commands 注册，从实际 invocation.agent 传递来源。共享 preset revision 的引擎不能被当作某个 Agent。
- 自动压缩通过公开 preset 配置投影，装配插件 `SpacesGuardedCompaction` 子类。通过官方 Loader 导入原 BasicCompactionEngine，仅覆盖其公开 compactIfNeeded 边界；摘要选择、收敛、锁、工具配对、持久化和适配器仍由官方实现。没有修改或替换官方原型。
- 精确 Agent、注册 Session 对象与 AsyncLocalStorage 限制来源；仅传 sessionId 不足以授权。prepared stream 还必须匹配准备时的 sessionId。缺失／失配／未知版本的绑定先作为捕获状态保存，只在实际依赖隐式历史目标的路由、模型信息或准备边界拒绝，不提前阻断普通请求或明确辅助路由。
- 继承路径的 compactionRetries/maxOverflowRetries 为零，显式非零策略拒绝加载；summary-error 钩子阻断独立输入修补循环。自动失败捕获覆盖 compaction/start 前后的整个原生调用，保留原错误；外层 pre-step 重新抛出，阻止当前主请求和后续自动摘要。失败按 Session 记录为 `plugin:dsh-spaces/automatic-compaction-failure`，没有重置、修复或恢复入口，共享预设的其他 Agent 不受影响。无结束标记的压缩现场也拒绝继续。
- 未经保护的自定义全局自动引擎在此继承链中明确拒绝，要求使用受保护的正式预设装配。普通 Web 的全局 compaction-basic 本已关闭。非继承旧路径保持原分流。
- 官方摘要追加的纯用户指令没有 message.source；replay helper 保留这类输入，模型来源验证保持。只恢复成功回复的原生 replay，不重放中断任务。

固定 SDK 的普通 Web 辅助消费者为 session-title-llm、compaction-basic；未默认装配的 experimental-translator / experimental-auto-review 不按 sessionId 猜测放行。

## 最终源码运行证据

下列运行均在新 Home 完成，status=passed，sourceUnchanged、sdkUnchanged、processesExited、protectedAbsent 均为 true；索引为 `FIVE-RUNS-INDEX.json`。早期成功与失败记录都保留，最终结论绑定此表源码，而非首轮复核前版本。

| 验证 | RESULT 所在目录 | 结果 |
| --- | --- | --- |
| 自动摘要 500 | `run-2026-10-21T17-55-50-872Z` | 6 项；摘要供应商恰一次、零后续主请求、同会话不重复摘要、另一个 Agent 正常 |
| compaction/start 前原生策略错误 | `run-2026-10-21T17-59-17-256Z` | 6 项；原错误保留、零摘要／主请求、无伪造 start/end、同会话停止、其他 Agent 正常 |
| 正式 Supervisor／Web／普通创建、标题、手动压缩 | `run-2026-10-21T18-00-19-080Z` | 14 项；三轮 replay、默认变化、显式辅助模型及 controls、JSONL、压缩后续聊、取消和 500 单次派发 |
| 自动压力成功 | `run-2026-10-21T18-04-38-199Z` | 5 项；旧 A 摘要，新 B 完成下一主请求，保留回复的 replay 哈希一致；无失败记录 |
| Magpie 实机 | `run-2026-10-21T18-05-39-677Z` | 11 项；8 次实际请求全部 HTTP 200，正式安装产物摘要匹配 |

`WIRE-AND-FAILURE-revise.json` 独立核对摘要线上请求携带 `signature-1`、`signature-3`，手动取消／500 的官方 compaction/end 原文，以及两类自动失败的原始 turn/end。自动失败前尚未进入 step，不能用 step/end 判断失败。`PERSISTED-AUTOMATIC-FAILURES.json` 从两份失败 Home 的官方压缩 JSONL 独立读回失败记录和 turn 错误，值与运行时一致；恢复监听次数均为零。

自动压力夹具用 32k 合成模型、thresholdRatio=0.4：输入确实触发压力，原生摘要后容量收敛，再进入新主请求。原生选择只摘要用户节点并保留首个 assistant，所以自动案例检查后续主请求中保留的 replay；手动案例另证明摘要请求本身携带多轮 replay。

实机仅使用用户授权并由目录确认的 `minimax-code/MiniMax-M3.1-Flash`，两个主 provider ID 指向同一该模型，以验证来源绑定与默认切换。三个实机轮每轮 8 次，共 **24 次请求均 HTTP 200**；最终结论取上述最后一轮，另见 `MAGPIE-REVISE-AUDIT.json`。relay 只记录协议摘要，使用无敏感值的本地占位认证，不读取或落盘真实凭据，输入均为合成资料。

实机三轮原生 replay envelope 哈希一致，摘要包含前两次回复的 replay，压缩后可继续对话。本次网关没有返回签名 thinking block，因此实机不构成签名块保真证明；签名另由受控线上证据覆盖。low/high controls 在主服务可见，但在本轮 1024 上限下网关都呈现 1024 thinking budget，不宣称内部推理强度不同。官方 summary 可见记录仍可能是 spaces-main/default；实际目标由绑定记录与主 trace 对照证明，不改写原生记录。

## 兼容与契约边界

同 SDK 旧 header 无新绑定时，auto:false 的普通主请求可以完成准备并生成新绑定，明确辅助路由可运行；真正隐式辅助继承仍在派发前拒绝。失配、未知版本和伪造同 ID Session 的边界继续保留。auto:true 的官方引擎即使低压力也可能先查询历史模型容量；历史目标无法证明时仍拒绝，不以当前默认或最后成功 assistant 猜补，因此不宣称旧会话自动压缩兼容全部通过。Astra 的边界咨询见 `ASTRA-R2-BOUNDARY.md`，不是最终 READY。

两类插件记录采用 SDK 已导出的实验性 appendPluginRecord 接口，不是冻结的 released event schema。源码 caller gate 指向官方仓库 packages/experimental，此处使用现有外部导出；迁移语义仅 best effort。隐式绑定记录缺失或损坏时，依赖它的辅助继承拒绝执行。自动失败记录仍存在（包括损坏的记录），或原生未闭合／自动错误标记仍可识别时，会拒绝继续；若未来迁移将整条实验性失败记录丢失，尤其失败发生在 start 之前且没有原生标记，本实现不能保证识别旧失败。跨 SDK 的可用性及失败状态连续性均未证明，不能据此冻结稳定契约。

## 失败证据与修正

每次修正均换新 Home，没有清理、修复或重放旧失败现场。原细节另保存在 `REPORT-before-revise.md`。

1. 初始驱动重复变量、缺 TypeScript 加载参数、YAML flow-array 追加错误，均保留日志和 RESULT。
2. 早期全局引擎探针未符合正式 Web 的 disabled 全局项和共享 preset 语义；base-only 结果不冒充正式 Web 证据。`16-41-56-774Z`、`16-46-32-301Z` 的 EXACT_COMPACTION_SOURCE_REQUIRED 与零摘要调用原样保留。
3. 早期自动夹具未达阈值、或错误要求摘要必须含被原生保留的 assistant；另有取消验证器误以为命令返回对象，实际应抛原取消原因。均保留原失败，只修正验证器。
4. 两个旧 compose 探针 dispose 后未退出，四个核对归属的进程终止证据在 PROBE-TEARDOWN.json；不将其算正常释放。后续正式运行另外检查退出。首次 LLM 默认 TEMP 写入拒绝也保留。
5. **Astra 首轮 REVISE**（ASTRA-REVIEW-1.md）：R1 指出官方 pre-step 吞掉自动压缩错误，配置零重试仍可能继续主请求并重复摘要；R2 指出捕获绑定过早拒绝不依赖它的普通／显式路径。两项均在插件修复，并补官方 Session、精确 Agent、原错误、持久化、共享预设隔离及旧 header 用例。
6. 修复后 `17-45-41-655Z` 的大输入触发标题大小限制，验证器误等供应商标题；`17-52-27-173Z` 已真正阻断 500，但验证器错等 step/end；`17-57-08-079Z` 健康会话切换时提前填写旧输入框而超时。均保留截图／日志，修正夹具后另建 Home。
7. **撤回旧自动成功结论**：`18-01-25-665Z` 在新保护下正确抛出原生“压缩后仍超阈值”；旧阈值 4800 低于压缩后的上下文 8784。首轮复核前 5/5 只是旧路径吞错后的表面成功，不能作真正收敛证据。原失败保留；仅调整合成压力阈值，最终真正成功为 `18-04-38-199Z`。官方算法与失败处理未为通过夹具弱化。
8. 类型／测试夹具修正过程和两次完整检查均保留。失败的检查不能用实际打包安装成功代替，也不以删除断言处理。

## 完整检查与审计

最终序列为 FIVE-RUNS-INDEX.json（汇合 REVISE2/REVISE3 与自动 500 单独运行），完整检查见 checks-revise/result.json、SUMMARY.json。使用 Node 26.10.0、固定 rc.2 SDK、授权仓库外 H:/Code/dsh-spaces-checktmp；顺序执行、无重试。15 项检查全部尝试，12 通过、3 失败。

| 检查 | 结果 |
| --- | --- |
| 测试清单、三组类型检查、构建 | 全部通过 |
| 核心 | 268/268 |
| spaces | 148 通过，1 跳过 |
| LLM | 120/120 |
| blueprints | 94 + 239 通过，4 跳过 |
| browser | 13/13 |
| dashboard | 52 + 152 通过，1 跳过 |
| workbench 浏览器 | 12/12 |
| workbench | 547 通过，7 失败，2 跳过 |
| workbench recovery | 26 通过，5 失败 |
| 插件包预检 | 失败 |

三个失败检查均保留 esbuild 的 Access is denied：workbench/recovery 无法写外部 temp 的 snapshot-worker.mjs，包预检无法写 validator.mjs。与前阶段同类失败一致，但不把它们认定为通过。实际正式运行完成打包、安装和摘要核对，不能替代完整包预检。首轮检查 checks-final 及原日志仍保留。

**后续来源核对更正：** 原审计忽略 BASELINE.json 的 deleted:true，把三项既有删除误报为新增缺失。S0 在 2026-10-21 17:33（上海）已记录三项删除；本阶段起点实际为 836 条记录（833 个现存文件＋3 项既有删除）。12 个授权内既有文件变更，821 个现存文件摘要一致，3 项删除状态未变，新增本报告和 4 个源码文件；没有三处新增丢失。原错误审计和 Astra 原文保留，修正详见 [检查收口报告](verification-closeout-results-20261022.md) 及 AUDIT-revise-baseline-correction.json。HEAD 为 `26aab5dc095bd97f132f5748aa727b800bb42916`。五次运行的实现／测试／打包源码摘要与当前一致；运行后协调文档更新另计。原 SDK 关键文件及新增核对的 session/title/compaction/command/preset/cordis 入口摘要保持；不存在的 dsh-loader 包单列 unavailable，不能说核对成功。

PROCESS-AUDIT-revise-final.json 的普通进程只读核对未发现本阶段可识别残留；早期 CIM 沙箱拒绝另保留，不把空输出当作审计成功。

## 指定 Astra 独立复核

首轮 ASTRA-REVIEW-1.md 为 REVISE，R1/R2 修复后，指定 Astra 最终独立复核 ASTRA-REVIEW-2.md 为 **READY，仅限本轮固定 SDK 的正式辅助调用接入阶段**。Astra 直接读取五份 RESULT，独立完成 65 次实现／测试／打包源码摘要比较，核对真实供应商模型与状态、受控摘要签名、官方失败记录、持久化文件摘要和三项检查失败。没有再次发起供应商请求或修改产品。整套检查后 INSTALLED-POST-CHECK-AUDIT.json 另证明受控及 Magpie 两份正式安装入口仍与当前构建一致。

该结论不代表全仓绿、S1/P0、完整 P1、稳定 capability 契约、安装版 Desktop 或持续运行放行；原“三个范围外新增缺失”说法后续已更正为基线既有删除，见上；整个工作区仍未授权合并。官方 SDK 不变，未提交、推送或发布。
