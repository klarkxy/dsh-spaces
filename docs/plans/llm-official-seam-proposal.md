# 主空间 LLM 继承：最小官方接口修订提案

版本：0.2  
日期：2026-10-21  
状态：用户授权的设计与验收要求；指定 Astra 独立复审 READY（仅 v0.2 需求与候选设计文档）。未批准修改上游、未实现 SDK 接口、未冻结 Spaces capability v1。S1/P0 仍未闭合，不能据此进入 P1。  
依据：[施工方案](construction-20261021.md)、[继承技术计划](llm-main-inheritance.md)、安装依赖公开声明与源码；故障政策以 [let it crash](../let-it-crash.md) 为准。

> **2026-10-21 用户边界纠正：我们只是插件，不修改官方 SDK。** 本文 v0.2 保留为历史候选与评审记录，不能继续作为要求上游实现或等待新增 SDK seam 的施工依据；Astra 的历史 READY 不覆盖这次方向修正。现有 SDK、node_modules 和官方安装包均不修改。重新从现有公开插件接口验证可行性，不把候选 `prepareModel` 等方法当成可调用 API，也不削减附件、默认值、单次调用和隔离要求来换取通过。

后续实证：[三个插件阻断原型结果](llm-plugin-prototype-results-20261021.md)。已通过有界核心验证及 Astra 只读复核，不再将本文新增 SDK 方法作为必要前提；完整集成、S1/P0 与契约尚未通过。

Codex 接手后的公开边界实验见 `.sandbox/construction-20261021/codex-takeover-2/RESULT.json`：官方 rc.2 `PreparedLlmCall.stream` 的 `llm/stream` waterfall 能在文件投影及 `forAdapter` 过滤前观察原始文件块与真实来源 replay，并公开短路默认 adapter 路径；普通 `next()` 路径仍投影文件、过滤异源 replay。该结果只证明中间件位置和原请求不变，不证明来源授权、图像隔离或调用准备已经通过。另一个真实官方 Agent loop 内存会话实验，已证明公开 `agent/request` 异步返回的 reasoning/maxTokens 在冻结前被接受，写入请求头并进入唯一一次派发，见 `codex-agent-request-1/RESULT.json`；尚未证明主空间远端交接或完整 provenance。本文把 pre-projection/replay 公共扩展列为必要前提的推论因此需要重新审查，不能直接视为 SDK 缺口。

## 1. 目标与已有证据

只解决一个接入问题：子空间通过现有主空间的官方 LLM 服务，使用其已配置的适配器及认证；模型准备、最终 controls 和请求附件必须属于同一调用。API Key 不交给 Spaces 的 Supervisor 或子空间，不另建配置解析器，不替换官方会话或工具循环。

证据锚点为本仓库 `node_modules` 中实际安装的包，版本须从各自 `package.json` 记录并与 `package-lock.json` 一起绑定。不是官网最新版或 master 的接口承诺。

| 事实 | 安装包证据 | 对设计的约束 |
|---|---|---|
| `PreparedLlmCall` 暴露冻结 config、retryPolicy 和单次 stream | `@deepseek-ai/dsh-llm/lib/types/index.d.ts:93` | 已准备调用不能随意更改 controls |
| `prepareCall(config, signal, configure)` 在 adapter 捕获后立即运行同步 configure 并冻结 | 同上 `:407`；`lib/index.js:2220–2258` | 不能在远端稍后收到 controls 时拿旧对象重新准备 |
| `PreparedAdapterCall` 绑定 metadata 与 dispatch，但没有公开当前代次检查 | 同上 `:118` | 私有 adapter 或原型 Map 身份不能作主空间 generation |
| 官方 pi-ai 插件在闭包内持有 profiles，并自行注册 adapter | `@deepseek-ai/dsh-llm-pi-ai/lib/index.js:2876,2904,2952` | 不深层导入 resolver、不取得私有 Map、不重建官方配置 |
| 官方图像 resolver 捕获插件 ctx，零参数取得 attachments | 同上 `:2908–2909`；`lib/types/adapter.d.ts:57` | 调用方 Cordis scope 不会自动改写这个闭包 |
| `GenerateOptions` 无请求级附件读取参数 | `@deepseek-ai/dsh-llm/lib/types/types.d.ts:506` | 不能传自造 attachmentAccess 并假定官方会使用 |
| `ImageAttachmentAccess.readonlyPath` 是工具执行世界路径 | `@deepseek-ai/dsh-llm/lib/types/content.d.ts:7` | 不能把它当作图像字节读取接口 |
| 文件按 handle 文本投影，文件 ID 为原始字节 SHA-256 | 同上 `:68–91`；`@deepseek-ai/dsh-attachment/lib/types/types.d.ts:30` | 不要求供应商收到文件全文；同一合法文件 ID 不可对应不同字节 |
| AttachmentStore 已有读取及确定性请求图像变体方法 | `@deepseek-ai/dsh-attachment/lib/types/index.d.ts:81,114,129` | 复用校验与转换规则，避免实现第二套图像编码器 |

原型 `.sandbox/construction-20261021/p0-llm-1/RESULT.json` 的 G2 PASS 仅代表自行构造 adapter 的机制实验。Astra 复核不接受其作为实际主空间门槛。图像碰撞实验说明所选夹具没有实现来源路由，不证明所有 Cordis scoped 服务方案都不可行；文件夹具缺少 fs 且使用非内容寻址 ID，不能据此认定文件隔离不可行。原始证据保留，不改写成成功。

## 2. 最小增量与非目标

推荐只扩展现有 `ctx.llm` 的准备调用及 adapter 扩展点，保留现有 provider 注册、官方凭据解析与请求实现。下文 TypeScript 是候选接口形状，不是已存在导出。

需要两个核心 seam，并闭合一条虚拟 adapter 的原始 replay 归属边界；不能先声明仅两个 seam 已足以覆盖整条继承路径：

1. **服务拥有的两阶段准备句柄**：先捕获实际 adapter/模型能力及代次，再在完整 controls 到达时校验并最终准备，不重新读取到另一个 adapter。
2. **每次调用的只读内容访问**：图像读取显式进入实际官方 adapter；文件选择子空间权威投影并附有界来源清单，避免第二个 runtime 重做或丢失验证。
3. **委派 route 的 replay 保真门**：子空间官方 runtime 必须在虚拟 adapter 前保留经明确注册和校验的真实目标归属；不能被当前 `forAdapter` 提前剥离，也不能广泛跳过所有 route 的 replay 安全检查。此公共扩展的形状尚待上游评审，未证明前是独立阻塞。

不在官方 SDK 增加 Spaces 身份、HTTP、bearer、跨空间 registry、持久任务、恢复流程或任意 Context 远程访问。SDK seam 只是进程内接口；Spaces 继续拥有认证、实例绑定、wire 校验、数据预算及外层终态。此次也不修改上游或 node_modules。

## 3. 两阶段准备：由实际官方服务持有快照

### 3.1 候选接口

```ts
// Proposed only; names require upstream review.
interface PreparedModelLease {
  readonly model: Readonly<LlmResolvedModelInfo>;
  readonly retryPolicy: ResolvedRetryPolicy;
  finalize(controls: Readonly<LlmCallControls>, signal?: AbortSignal): PreparedLlmCall;
  release(): void;
}

// ctx.llm: new additive method
prepareModel(
  target: { provider: string; model: string },
  signal?: AbortSignal,
): Promise<PreparedModelLease>;
```

`model` 为官方脱离原对象且冻结的完整必要 metadata，涵盖 context、模态、reasoning、默认 controls 及更新能力，不能只返回名字。Spaces 仅向子空间投影经 schema 验证的不含秘密部分。

不要求向调用方公开 numeric generation、profiles、endpoint、认证或 adapter 对象。代次可保存在官方句柄闭包里；Spaces 的随机 wire handle 是自己的内存索引，不是 SDK 私有代次或可跨进程序列化的对象。

### 3.2 官方 adapter 所需增量

当前 `LlmAdapter.prepareCall` 已可绑定 generation。新增两阶段能力必须能让实际已注册 adapter 表明：

- 返回的 metadata 与后续 stream 是同一 snapshot；
- 在 finalize 的同步临界区检查该 snapshot 及路由注册仍为当前；
- metadata 使用到的图像定价/请求 target 等同步查询也属于被捕获代次，不能另外查询当前 route 后混代；
- dispose、取消和一次性派发有界，不能偷偷另建 provider。

具体可采用新增 optional `prepareModel` 扩展方法或给准备对象增加受版本约束的 freshness/projection 方法，由上游确定唯一形式。关键是 runtime 经实际注册表取得此能力，不能让 Spaces 调用 `new PiAiAdapter` 后声称复用了主空间。

对未实现此 seam 的 adapter 明确返回 `UNSUPPORTED_DELEGATED_PREPARATION`（建议码）；不能以基础类恒为 true 的 freshness、第二次 resolve/prepare 或 metadata 比较代替代次证明。支持矩阵按 adapter 和版本登记。

### 3.3 时序及状态

1. Spaces 主空间执行器读取该宿主 `agentDefaultModel.currentSelection()`，得到本次目标及 reasoning 选择，交给官方 `prepareModel` 一次。
2. SDK 捕获注册、adapter snapshot 与模型 metadata。准备过程中 snapshot 改变时，本次失败，不自动再准备。
3. 主空间 prepare 回复在子空间调用准备冻结前，一起交付捕获的真实目标 metadata、主空间默认 selection（含 reasoning）与来源标记。子空间官方同步 configure 回调必须能区分用户/会话显式 controls、继承 selection 默认和 adapter 默认；当前接口若无法携带此 provenance，必须公开扩展 callback 输入，不得猜测“值相同即未指定”。推荐规则为子空间显式值优先，其次准备时捕获的主空间 selection，再由 adapter 补齐；最终优先级和映射需在 P0 正例冻结。若这条前置传递无法成立，G2 继续阻塞，不能靠事后 mismatch 拒绝声称零配置成功。
4. 子空间冻结并记录 controls 后，将已同意的 materialization 与默认 provenance 一起提交；主空间校验 handle 来源、实例、期限和消费状态，再调用 lease.finalize 对同一输入作能力验证与一致性核对。主空间不得在子空间已冻结后另行补入 reasoning 默认。其 PreparedLlmCall.config 必须等于两端此前同意的真实目标 controls；不同则供应商零调用、终止本次句柄。
5. finalize 在同一同步临界区核对 route/snapshot；变化则 `CONFIG_CHANGED`，供应商零调用。之后该调用进入已冻结状态；任何后续配置/默认变化只影响下一次新模型调用，不改已冻结的 dispatch。
6. 返回的 PreparedLlmCall 只接受与冻结 config 一致的请求并且只派发一次。消费 stream、取消或显式 release 都使 lease 不可再次使用。

状态为 `prepared → finalized → consumed → closed`，也可从 prepared/finalized 进入 released/expired/cancelled。finalize 失败、reuse、错误 controls 都使该 lease 终止，不能改 controls 再试。prepared 未消费时 release 只释放本次内存资源；重复 release 可幂等但不能复活句柄。

配置时点要明确：主空间默认选择在本次 prepareModel 时捕获；随后仅修改全局默认选择不重定向这个 lease。若该目标的实际 route/snapshot 在 finalize 前改变，拒绝；finalize 完成后则沿用捕获的 dispatch。不可把“下一调用跟随默认”误写成在途重新路由。

取消先于 prepare/finalize 时供应商零调用；流中取消沿官方 AbortSignal 终止本次调用。prepared/finalized 资源按 TTL 和实例 dispose 释放，不续租、不存盘、不跨重启重放。数值上限由 P0 量测后冻结，目前不以任意常量冒充已验证预算。

### 3.4 controls 一致性的额外门槛

主/子两端不得混淆“待远端补齐的 controls”和子空间已记录的最终 config。P0 必须通过真实官方 Agent 证明：一次性子空间 prepared metadata 与主空间 finalize 的 materialized controls 完全一致；否则在供应商 I/O 前失败。

必要请求指纹包括捕获目标、官方冻结的 controls、模型能力描述版本以及来源实例关联。wire 指纹只是完整性比对，不能取代官方代次校验；metadata 不变也不能证明 endpoint/认证绑定未变。两端的 temperature/maxTokens/reasoning/stop 的 omitted、null、0 不可混写；不支持选项明确拒绝而非静默丢弃。

## 4. 请求级内容访问：字节源与工具路径分开

### 4.1 候选接口

```ts
// In-process, proposed only. Never serialize these functions over HTTP.
interface RequestContentAccess {
  readonly images?: {
    readRequest(
      ref: ImageAttachmentRef,
      target: ImageRequestTarget,
      signal?: AbortSignal,
    ): Promise<RequestImageAttachment>;
    toolPath(ref: ImageAttachmentRef): ImageAttachmentAccess | undefined;
  };
  // Files on the Spaces path are projected and authorized in the child.
  // They are not re-read through the main host's attachment store.
}

// Add optional process-local context to the new prepared dispatch path.
interface PreparedDispatchContext {
  readonly contentAccess?: RequestContentAccess;
}
// Proposed overload for calls produced by prepareModel().finalize():
// prepared.stream(options, context?: PreparedDispatchContext)
```

不是把 AttachmentStore 的整个保存/写盘服务传给对方。`images.readRequest` 读取经授权且校验过的请求变体；toolPath 返回的是子空间工具能读取的执行世界路径，不能把主空间存储路径泄漏给模型或工具。普通本地调用不提供 context 时沿用原来逻辑；**声明为委派调用时，所有带图请求必须显式提供图像访问能力，文件则必须经过下述子空间投影与 manifest 检查，否则在 I/O 前拒绝，不读取主空间默认 store**。

后续接口实现必须有显式 delegated 标记或独立方法保证这条区分，不以“contentAccess 是 undefined”猜测它是本地调用。标记由受信任主空间执行器设定，不从模型请求原样透传。

### 4.2 贯穿实际官方调用路径

- **文件投影权威选在子空间**：现有子空间 runtime 已在 MainInheritanceAdapter 前把 file block 转为 handle 文本（`dsh-llm/lib/index.js:2335`）。保留该单次投影顺序，但必须在类型信息擦除前，按原 refs 逐项校验子空间授权、内容 ID 与 metadata，解析子空间 fs 工具路径，生成绑定本次调用的有限 manifest。缺路径或未授权引用应在投影前明确失败，不得悄悄生成一个无可用路径的 handle。manifest 包含引用、消息 occurrence 关联、投影文本摘要及来源调用标记，不包含文件正文或主机绝对路径；manifest 必须由可信子空间运行时 hook 产生，不能相信模型提交的普通 JSON。若现有公共 hook 无法在投影前完成校验与清单绑定，需官方新增 pre-projection/read-only hook，这也是 G3 阻塞，不以字符串扫描代替。主空间验证 payload 与 manifest 的关联及预算，禁止带原始 file block 重走本地 store；它不从文本猜原引用，也不再次投影。普通文本不得仅因长得像 handle 就被当作文件授权。
- 实际已注册 pi-ai adapter 在同一 prepared stream 内读取此调用的 images.readRequest、images.toolPath；不能继续只走 `resolveAttachments: () => capturedCtx.get('attachments')`。
- 第三方 adapter 未声明接受该内容访问扩展时，委派图像请求明确 unsupported；不能忽略新参数后碰巧读本地同 ID 对象。
- image target 的选择仍由被捕获 adapter 决定；变体读取复用官方 AttachmentStore.readImageRequest 的确定性转换与完整性规则。尚需明确：主空间发出的 target 与子空间生成变体如何绑定 variant identity，以及主空间如何验证元数据/字节长度/格式；未证明前不宣称 G3 通过。
- callbacks 不进入 LlmCallConfig、消息持久化、遥测、replay state 或 wire。传入对象采用本次作用域的不可变绑定，不能临时替换全局附件服务，也不能靠 AsyncLocalStorage 猜测来补一个未经公开契约支持的路径。

### 4.3 Spaces 的授权和传输责任

子空间在自身 attachment service 与工具世界中建立有限引用清单；根据请求中被允许出现的 refs 解析授权读取和工具路径。主空间只看到本次能力请求内的 opaque 引用及有界传输数据，不能要求任意本机路径、远程 URL 或未列出的附件。

具体图像变体传输方式（请求内数据或准备句柄下的受限读取方法）属于 Spaces LLM capability v1；待此 seam 可用并证明后再选定，不在官方 SDK 嵌入 Spaces HTTP 协议。若使用请求内数据，必须先验证所有预计 target/预算一致，再发供应商；若需要变体子请求，必须版本化和限制次数/总字节，不能在失败后自动重读。

各调用内容访问绑定来源 Home/space/epoch/generation、请求和实际目标实例。相同 attachment ID 不授予跨来源访问。两来源相同合法内容 ID 可以对应相同字节，但子空间工具路径和权限仍须隔离；不同字节必须产生不同内容 ID，伪造同 ID 配不同字节应拒绝，不能拿它作成功隔离案例。

文件原始字节留在来源空间，官方模型输入继续使用 file handle 文本；工具调用及其读取在子空间执行。验收要求 handle 指向正确的子空间执行路径，而不是供应商收到文件全文。不得以主空间路径替代，也不得主动把正文或根 store 复制过去。

请求结束、abort、consumer return、期限到期和目标实例退出撤销 callbacks 及其资源。未能停止的实际 handler 仍占执行配额直到结束；取消只表示停止请求/交付，不承诺撤销外部副作用。

### 4.4 子空间 runtime 的 replay 保真门

安装版 `dsh-llm` 的 `forAdapter`（`lib/index.js:2267`）在 dispatch 前，仅在历史 source.provider 当前归属同一个 adapter 时保留 replayState。子空间虚拟 `spaces-main/default` 与主空间真实 provider 通常并不注册到同一个子空间 adapter，因此即使主空间接口正确，历史 replay 仍可能在到达 MainInheritanceAdapter 前被剥离；两个核心 seam 本身不解决这一点。

需要一个由官方 runtime 控制的、显式 opt-in 的委派 replay 扩展：只对经注册确认的虚拟 route，依据本次捕获的真实目标及可验证的历史归属，将 opaque replay 交给获准的委派 adapter；最终仍由真实目标的官方 adapter 判断可用性。source.provider/model 不改写成虚拟 route，不把真实 provider 全部注册成虚拟 adapter 别名，不全局禁用 `forAdapter` 检查，不让未经授权的 adapter 读取其他 route 的 replay。历史来源无法证明时应保持官方明确的降级/拒绝语义，并在本功能验收记为不支持的边界，而不是宣称完整 replay 已满足。

公共接口形状、真实目标归属证明如何跨子空间持久历史绑定，以及默认 provider 改变后的官方兼容行为仍未确定。它们必须先经上游设计评审，再用真实两步官方 Agent 历史验证；未闭合时 C13/G4 是阻塞，不能只写一条“原样透传 replay”就放行。

## 5. 与现有 API 和失败政策的兼容

- 现有 prepareCall/stream 的本地语义保持；新增能力必须显式可检测，旧 adapter 不伪装支持。发布版本和 feature ID 由官方接口评审后定，不能只凭方法名存在判兼容。
- 新 lease 使用同一官方 llm/stream、provider attribution、认证和 chunk 投影规则；不是绕过 middleware 或注册第二套供应商。
- 子空间 `spaces-main/default` route 明确 zero retry。官方 prepared 对象保留真实路由 policy，但委派执行器不创建 Agent retry loop；有官方 retry 插件时仍以实际供应商计数证明端到端单次派发。
- 完整转发 block/tool/reasoning/usage/finish/replay；真实 provider/model replay 归属由官方路径解释，不能把内部身份全部改成虚拟 route。这里只扩展既有模型 replay state 的安全转交边界，不新增失败任务重放、断流续跑或恢复机制。
- inner finish 与外层 terminal 一致：error→failed、aborted→cancelled。EOF 无 terminal 失败，已有部分输出保留，不补造成功，不返回伪成功空流。
- 生命周期不自动启动主空间或 Supervisor、不重连、不切换备用模型、不重新 prepare，不因失败清除原证据。
- generation token 不导出为凭据；日志只允许请求关联、阶段、受限错误和脱敏分类。不记录 API Key、callbacks、附件字节、文件路径清单、prompt 或工具参数。

## 6. 验收矩阵：先证 SDK，再证实际主空间

下面每项是待执行要求；没有一项因文档存在即通过。

| ID | 场景与可观测结果 | 判定重点 |
|---|---|---|
| C01 | 已运行主空间的官方插件自行创建 adapter；Spaces 只调用公共 ctx.llm.prepareModel | 不访问私有 Map、不 new PiAiAdapter、不复制 resolver |
| C02 | prepare 后修改同 provider/model 的 endpoint 或能力，再 finalize | CONFIG_CHANGED，供应商 0 次，无第二 prepare |
| C03 | finalize 后修改配置；原流仍用旧 snapshot，下次调用用新值 | 冻结点真实，无混 endpoint/能力/controls |
| C04 | 只修改默认 selection | 在途目标不变；下一 prepare 使用新默认 |
| C05 | 子空间 omitted reasoning 成功继承主空间非标准默认（正例）、显式覆盖、adapter 默认，以及 omitted/0/非法 reasoning/stop | selection/provenance 在子空间冻结前可见；两端最终 config 一致，非法项 0 次 I/O |
| C06 | 同一个 lease 两次 finalize、stream/release/reuse、过期、dispose | 单次派发，资源释放，无复活/重放 |
| C07 | finalize 同步边界的注册替换/注销及 adapter settings 变化 | 不能只比较公开 metadata 判代次；stale 明确失败 |
| C08 | 两个来源并发相同 sessionId 和相同合法文件/图像内容 ID，不同工具路径和权限 | 路径/授权不串；禁止全局服务替换 |
| C09 | 两来源不同有效字节与合法不同内容 ID，以及伪造同 ID/元数据 | 正确读取；伪造在供应商 I/O 前拒绝 |
| C10 | 已列 refs 外的读取、默认主空间 store 存在同名对象、缺失 resolver | 拒绝，不 fallback 到主空间对象 |
| C11 | 图像 target、变体 ID、格式、尺寸、字节预算、offload 语义 | 使用捕获模型规则，不静默丢图/降文本 |
| C12 | 实际子空间 Agent → runtime 投影 → MainInheritanceAdapter payload，绑定原 refs/manifest，再由子空间工具实际读取 | 缺路径和未授权 refs 在投影前拒绝；主空间不二次投影；路径正确、字节不传供应商、内容 ID 完整性有效 |
| C13 | 真实两步 Agent 的 source/replayState 在子 runtime forAdapter 前后、虚拟 adapter payload 和主空间实际 adapter 的观察；默认 provider/model 改变，另含标题/压缩/工具/reasoning/usage | 原始归属保留、不跨无权 adapter 泄漏、不提前剥离；官方降级/拒绝有证；单次文本 harness 不替代 |
| C14 | abort/consumer return/断流/供应商 500，安装官方 retry 插件 | 保留部分流，每次显式调用最多 1 次供应商请求 |
| C15 | 主空间/子空间实例退出、旧 handle/旧 token/跨来源调用 | 不迁移、恢复或自动重连；权限与配额正确 |
| C16 | 真实官方 Desktop 与专用非 web 官方 Web 宿主、至少两个真实子空间 | 实际插件/服务/Agent/UI，真实身份，不冒称字面 web 路径实测 |
| C17 | protected-tree 前后、秘密/路径/正文扫描、正式包依赖和版本 | 不写 profiles/web/根 sessions/storages，无 Key 越界 |
| C18 | 旧 shared/local/无 policy/v1、旧 IPC、看板封存回归 | 旧行为保持，不自动迁移 |

SDK seam 实现后先用 public APIs 的契约测试证明 C01–C12，再按 Spaces P0 证明真实宿主、完整 HTTP、Agent/UI 和包路径。可并行准备测试设计，不得以单元通过替代 S1b 或 G1/G4。

测试全部使用本地受控 provider、合规隔离 Home 和已授权外部临时根；付费模型、真实 Home、上游仓库修改不在本轮授权内。错误轮留证不重放；修改夹具后新案例必须另开证据目录并说明变化原因，不自动重启原失败环境。

## 7. 交付、决策与重新准入

本提案交付的是历史接口需求、候选形状及验收门，不是 SDK 实现或 Spaces 生产类型。用户已明确排除修改官方 SDK；不再将“授权改上游”作为本任务下一步。后续只验证插件公开入口：冻结前的 `agent/request`、已存在的 `llm.prepareCall` 与投影前的 `llm/stream`，以及公开服务隔离机制。若某项仍不可实现，应给出具体版本、调用链和失败证据，明确产品影响，再讨论插件范围内的方案；不能修改 SDK、复制私有 resolver 或静默减少能力。

若后续官方公共接口审查证明已有等价能力，应优先使用并给出相同矩阵证据，而不是坚持新增方法。当前本提案只记录已安装版本未证明的边界，不断言所有官方版本都缺失。

重新进入 P1 的必要条件仍为：S1a 当前快照完整检查、S1b 四项官方 Desktop 实测、S2 摘要检查点、G1–G4 及 capability 契约全部闭合；本提案不豁免任何一项。正式路径、方法名、数值预算、协议错误码和版本在 P0 成功后由主代理唯一冻结，B/C 仅消费已落地共享类型。
