# DSH Spaces 能力委派通道与主空间 LLM 继承施工计划

版本：0.2  
日期：2026-10-21  
状态：候选施工计划；已扩展为“通用能力委派通道＋首个 LLM 继承消费者”。空间间调用、消息和 `ctx.web` 等未来消费者只设计接入边界，本轮不施工。P0 核心原型及分阶段集成已有实证，完整门槛与运行验收尚未闭合。  
核对基线：`26aab5d` 加当前工作树改动  
计划路径：`docs/plans/llm-main-inheritance.md`

2026-10-22 检查收口后续：三份所谓新增缺失已证实是 S0 既有删除被审计误读；三处临时编译由持有目录的 Node 写入，完整检查 15/15 全通过。指定 Astra 最终独立复核 READY（仅本轮检查收口），详见 [检查收口报告](verification-closeout-results-20261022.md)。不倒改下列历史失败，不改 SDK，不关闭 Desktop／契约及完整阶段门槛。

2026-10-22 正式辅助调用追加进展：标题、/compact 与受保护的官方自动压缩子类已接通精确 Session／Agent；Astra 首轮 R1/R2 修复后，五组最终运行 42 项通过、LLM 120/120、MiniMax 最终 8 次请求均 200。自动失败原错落盘且同会话停止，旧绑定缺失仅在真实依赖时拒绝；auto:true 的未知历史容量仍关闭。15 项检查 12 通过、3 项 temp 写入失败；Astra 最终独立复核 READY（仅本轮固定 SDK 有界阶段）。实验性记录与实机签名边界见 [辅助调用结果](llm-auxiliary-results-20261022.md)，不冻结契约或放行完整阶段。

当前执行边界（2026-10-21 用户纠正）：Spaces 只是插件，官方 SDK 为固定外部依赖，不修改 SDK、node_modules 或官方安装包。下文尚未由 P0 证明的两阶段方案为候选，不得以新增官方接口作为施工前提。现有公开插件入口重新核实，见 §10.3 末的接手记录。

后续三个阻断原型已实际执行，详见 [插件原型结果](llm-plugin-prototype-results-20261021.md)。采用官方 prepareCall 的冻结语义；子空间通过禁用旧服务条目、插入插件子类条目的公开静态组合挂载，不能用 patch 的 name 字段改名。聊天解析当前默认，辅助调用保留已选真实目标；继承路径独立零重试；原官方适配器使用命名附件/fs 作用域。三个核心方向成立，但完整服务契约、真实授权/传输与宿主产品验收尚未通过，本轮未进入 P1 或冻结 capability。

按用户追加授权，跨进程认证传输、真实 read 权限、官方持久化新进程重开和多轮原生签名 replay 已集成验证，最终 26 项通过，Astra 独立复核 READY（仅本轮隔离集成），见 [集成结果](llm-plugin-integration-results-20261021.md)。它使用父进程可信发放的原型身份，不能替代正式 Supervisor 注册与宿主来源证明；图像网络链路、完整发现/controls、正式包与 UI 仍待。SDK 固定，契约和 P1 不因此提前放行。

更新：正式 Supervisor 注册/认证、图像与 DeepSeek 的追加阶段已完成 31 项隔离集成，取消及终结竞争经过三轮 Astra 指出并修复，最终 Astra 独立复核 READY（仅本轮有界集成），见 [最新结果](llm-supervisor-images-deepseek-results-20261021.md)。上段“仍待”为前一阶段边界；正式包/UI、Files 失败政策、完整契约和 S1/P0 门槛继续保留。

## 1. 背景与现状

### 1.1 用户目标与本轮边界

用户在官方 Desktop 主空间配置一次模型供应商和 API Key，新建子空间即可调用，不需要再次创建共享连接、导入配置、填写凭据或选择绑定。

这条调用链同时要为以后需要的能力留下明确扩展点：

- 空间之间的能力调用。
- 空间之间收发消息。
- 主空间 `ctx.web` 相关能力。
- 其他经过明确授权、具有可序列化契约的 `ctx.*` 服务能力。

采用两层设计：

1. **通用能力委派通道**：负责身份、权限、寻址、发现、版本协商、调用、流、取消、资源限制、活动记账和错误投影。
2. **LLM 继承能力**：负责当前主空间默认模型、官方模型调用准备、附件、StreamChunk 与子空间 Agent 集成。

**本轮唯一建设的产品能力是 LLM 继承。** 通道的通用部分随这一消费者实现并测试；未来消息、空间间调用及 web 能力不注册为可用能力，不添加页面，不迁移现有总线。

不建设通用远程对象代理、任意属性调用、消息队列、持久化事件平台、自动重连或作业恢复系统。

### 1.2 当前 LLM 实现与目标的差距

现有共享连接库使用独立 catalog 和凭据存储。bridge 在启动时读取冻结快照，把共享 provider 和默认模型投影到子空间配置；供应商请求仍在子空间执行。

这不能直接满足“使用主空间已经配置好的 LLM”。

证据：

- `src/core/domain/llm-resolution.ts:60`、`:91`、`:107`：快照、provider 与默认模型合并。
- `src/adapters/node/llm-snapshot.ts:51`：启动快照。
- `packages/llm-bridge/src/plugin.ts:141`：配置投影和显式默认值优先。
- `src/shared/llm-api.ts:22`：现有 API 是连接管理，没有推理流接口。

旧计划明确排除主空间生效配置共享和请求代理。本计划改变这项产品边界，需要同步更新有效需求和旧计划状态；保留旧实现的兼容契约，不能继续用旧非目标否决新需求。

证据：`docs/plans/global-llm-connections.md:12`、`:18`、`:289`；`REQUIREMENTS.md:62`。

### 1.3 已有空间消息能力

仓库已经实现：

- Host 内服务 `ctx.spaceMessages`。
- `request(target, operation, params)`。
- 目标按来源空间精确白名单注册 handler。
- 权限过滤后的静态能力查询。
- Supervisor 绑定实际子进程身份并路由。
- 有界内存请求、超时与断开错误。

现有通道不提供流式响应或取消执行保证。超时只表示等待结束，不能证明目标未执行或副作用已撤销。

证据：

- `packages/view-bridge/src/message-service.ts:4`。
- `packages/view-bridge/src/message-bus.ts:27`、`:37`、`:89`。
- `src/adapters/node/message-bus/router.ts:7`、`:42`。
- `src/shared/space-message-bus.ts:1`。
- `docs/message-bus/phase-one.md:39`、`:64`。
- `docs/message-bus/static-capabilities.md:15`。

新通道继承这些安全原则，但不在本轮替换已有 IPC 实现。未来适配不能把旧 handler 宣称为支持强取消或持久化投递。

### 1.4 接入证据与需要修正的假设

| 事项 | 已核对事实 | 设计影响 |
|---|---|---|
| LLM 流 | waterfall 允许短路返回 chunks | 可用于路由，但不是完整模型适配 |
| Agent 调用准备 | 官方 prepareCall 会取得 adapter、能力并冻结配置 | 虚拟模型需要真正注册 adapter |
| 当前主空间默认 | `agentDefaultModel.currentSelection()` 读取运行中配置 | 使用服务，不重新猜测配置文件 |
| 独立 PiAiAdapter | 公开构造器需要 resolved profiles 和 auth | 不等价于完整主空间配置解析 |
| profile 读取工具 | 实际读取 `cordis.patch.yml` 的 config 行 | 不能当成完整有效配置读取器 |
| Supervisor | 管理服务不持有主空间 `ctx.llm` | 它是路由和授权中心，不是现成推理宿主 |
| Desktop 网络承载 | 官方 Electron 采用 file/IPC | 不能依赖主空间一定挂 `webServer` |
| 活动状态 | 现有 activity 包装流并支持 idle reservation | LLM Apply 继续使用该准入 |

证据：

- `node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts:33`、`:92`、`:130`。
- `node_modules/@deepseek-ai/dsh-agent-default-model/lib/index.js:38`。
- `node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/types/adapter.d.ts:34`。
- `node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:2876`、`:2968`。
- `src/adapters/node/profile-settings.ts:28`、`:63`。
- `src/adapters/node/workbench-supervisor.ts:327`。
- `node_modules/@deepseek-ai/dsh-host-webserver/lib/types/index.d.ts:1`。
- `packages/llm-bridge/src/activity.ts:167`、`:252`。

## 2. 决策摘要

| 决策 | 本计划建议 |
|---|---|
| 文档定位 | 保留 `llm-main-inheritance.md`，增加通用通道章节 |
| 通道身份 | Home 内的能力委派，不是 LLM 专用代理 |
| 通道传输 | 认证 HTTP POST；调用返回统一 NDJSON 帧 |
| Supervisor | 验证身份、能力权限、目标实例并中转 |
| 主空间执行器 | 用户原先配置模型的已运行官方宿主内插件组件（Web 或 Desktop） |
| 主空间 listener | 插件持有的私有 loopback listener，不依赖 `ctx.webServer` |
| 首个能力 | `spaces.llm.inherit` v1 |
| 新空间默认 | 跟随主空间当前默认模型 |
| 显式配置 | 会话、本地和已有 shared 策略保持优先及原有失败语义 |
| 共享连接库 | 本轮共存；保留旧绑定正常管理入口 |
| 旧空间迁移 | 不自动改写；新空间明确记录新策略 |
| 未来消费者 | 定义契约及权限边界，本轮不实现 |
| 失败 | 不重试、不恢复、不自动重连、不切换执行器 |
| 生命周期 | 主空间 host 退出，继承能力不可用 |

主空间是同一 Home 中用户最初配置模型并加载 Spaces 插件的官方宿主进程：Web 通常为 `web` profile，官方 Desktop 为 `desktop` profile；不是 `spaces-hub` 管理 profile。后者继续承载工作台管理 UI。验收专用非 web profile 只替代测试宿主的位置，仍运行官方 host、实际插件和公开服务，配置测试宿主自己的 mock provider；不复制用户配置、不把管理器当作主空间、不宣称已运行受保护 web 目录。身份和正式验收边界见 [施工方案 P0](construction-20261021.md#4-p0-四道技术门)。

## 3. 通用能力委派通道

### 3.1 架构和责任

```text
子空间中的显式服务适配器
    ↓ CapabilityClient
Supervisor 能力网关
    ├─ 来源身份与 token scope
    ├─ 目标实例绑定与策略检查
    ├─ 权限过滤后的发现
    ├─ 流转发、取消、资源限制、活动记账
    ↓
目标 host 的 CapabilityExecutor
    ↓ 显式注册的能力 handler
目标进程中的官方 ctx 服务
```

首个目标是主空间 host。未来同一协议允许目标是一个已注册、已运行的子空间或 Supervisor 自身，但本轮没有消费者的目标类型返回不支持，不实施空壳业务。

通道不解释 LLM provider、模型、聊天或工具；这些属于 LLM capability。

原有 `dsh-spaces:llm-activity` 保持状态通道，不承载正文。原有 `dsh-spaces:bus:1` 保持现有 IPC 契约。

### 3.2 为什么选择 HTTP NDJSON

| 维度 | HTTP POST＋NDJSON | 父子 IPC 分块 |
|---|---|---|
| 流读取 | 原生 response stream | 需要额外分块和复用协议 |
| 背压 | 支持 `write()`/`drain`，仍需限制队列 | 需实现 credit/window |
| 取消 | AbortController 与连接关闭可贯通 | 需自定义 cancel/ack |
| 来源身份 | 需要受限令牌 | 继承描述符天然绑定子进程 |
| 主空间接入 | 独立 host 可使用同一协议 | 主空间不是 Supervisor 子进程 |
| 攻击面 | 新增本地路由与认证责任 | 网络面较小 |
| 既有消息总线 | 不必迁移 | 现有实现适合有界单结果请求 |

选择 HTTP 的主要理由是流式调用和非子进程主空间的统一接入。不是因为现有 IPC 不能做消息。

Supervisor 复用现有 loopback listener；主空间插件启动一个自身持有的 loopback listener，生命周期跟随插件。两端都只开放同一能力协议的明确路由，不开放任意 HTTP 代理。

证据：`src/adapters/node/workbench-http.ts:165`；`src/adapters/node/message-bus/router.ts:12`；`node_modules/@deepseek-ai/dsh-host-webserver/lib/types/index.d.ts:1`。

### 3.3 通用命名与模块边界

建议使用：

```text
/api/spaces-capabilities/v1/discover
/api/spaces-capabilities/v1/invoke
/api/spaces-capabilities/v1/cancel
```

主空间私有 listener 使用相同协议 namespace。内部 host 注册入口属于控制面，独立鉴权，不作为子空间可调用 capability。

以下是建议新增位置，不代表文件已经存在：

| 层 | 建议位置 | 职责 |
|---|---|---|
| 通用 wire 契约 | `src/shared/capability-channel.ts` | 信封、帧、版本、错误和严格 JSON 校验 |
| 通用服务端 | `src/adapters/node/capability-channel/` | 认证、授权、注册、路由、流与取消 |
| Supervisor 集成 | `src/adapters/node/supervisor/capabilities.ts` | Home/进程代次及生命周期接线 |
| 主空间集成 | `packages/plugin/src/host/capabilities/` | listener、执行器与 capability 注册 |
| 客户端核心 | `src/shared/node/capability-client.ts` | 通用 HTTP 客户端和流解析 |
| LLM 契约 | 独立 `llm-inheritance` 模块 | 模型准备、附件、LLM 载荷 |
| LLM 消费者 | `packages/llm-bridge/src/` | 官方 adapter/service 接入 |

通用层不得导入 llm-bridge，也不得依赖 `StreamChunk`、`LlmConfigError` 或 LLM policy。LLM 模块依赖通用层，方向不能倒置。

本轮不为通用通道新增独立发行包；通过现有 Supervisor/plugin/bridge 构建交付，包边界有实际需求后再拆。

### 3.4 信封与寻址

建议固定以下形状；最终字段及大小限制在 P0 冻结：

```ts
type CapabilityTarget =
  | { kind: "main" }
  | { kind: "supervisor" }
  | { kind: "space"; spaceId: string };

interface CapabilityCall {
  protocolVersion: 1;
  requestId: string;
  target: CapabilityTarget;
  capability: string;
  capabilityVersion: number;
  method: string;
  payload: JsonValue;
  timeoutMs?: number;
}
```

规则：

- 来源身份不由信封提供；从认证会话获得。
- `main`、`supervisor` 是逻辑目标，不等于空间显示名。
- `spaceId` 必须是已注册空间，禁止路径、URL、扫描或收养外来 profile。
- Supervisor 选择目标实际运行实例，并将请求固定到该实例。
- 对外 requestId 和内部路由 ID 分离，回复只接受被绑定目标实例。
- 超时是服务端限制以内的请求预算，不扩大能力权限。
- payload 和结果通过严格 JSON 边界；`AbortSignal`、函数、服务对象和 Node request/response 不跨进程。
- 不允许 `{ service: "ctx", path: ["任意属性"], args: ... }` 之类反射调用。
- 通用限制可参数化，不能直接把旧 IPC 的 64 KiB 限制用于带附件的 LLM；旧总线限制仍保持不变。

已有总线的来源绑定、独立路由 ID 和 JSON 校验原则可复用；旧 wire schema 不直接兼容新信封。

证据：`src/adapters/node/message-bus/router.ts:7`、`:42`；`src/shared/space-message-bus.ts:36`。

### 3.5 令牌、scope 与授权

使用每次启动生成的 opaque bearer，服务端保存授权会话。无需为本机增加 JWT 或独立签名基础设施。

授权会话至少绑定：

```ts
interface CapabilityGrant {
  homeId: string;
  serviceEpoch: string;
  subject: {
    kind: "space" | "main-host";
    spaceId?: string;
    generation?: number;
    launchNonce: string;
  };
  scopes: Array<{
    target: CapabilityTarget;
    capability: string;
    capabilityVersion: number;
    methods: string[];
  }>;
}
```

本轮新空间继承策略只授予 `main + spaces.llm.inherit/v1` 的必要方法；不给 `ctx.*`、任意目标或未来能力的通配权限。

授权是以下条件的交集：

1. 来源启动身份有效。
2. token scope 允许该目标、能力、版本与方法。
3. Supervisor 当前策略允许。
4. 目标当前注册且对来源允许调用。
5. 实际资源访问通过 capability 自身校验。

**发现不是授权。** 每次调用重新检查；准备句柄消费和取消也核对所属来源、目标实例及权限。未来撤销 scope 可在服务端立即拒绝新调用，无需改变认证协议。

安全要求：

- 令牌经启动环境注入，bridge 读取后尽早移除相关环境变量，避免后续工具子进程继承。
- 不进入快照、任务、浏览器、命令行、URL、共享包或日志。
- 子空间令牌不能访问管理 API、注册执行器或代表其他空间。
- Supervisor→执行器采用独立的实例级认证；只有可信 Supervisor 能附加来源身份。执行器不相信普通请求自称的 source。
- 主空间注册通过已经认证的 host/Supervisor 建立阶段完成，绑定 Home、实际官方宿主 profile 身份、loader 根、实例 nonce 和精确 loopback endpoint；默认 Web/官方 Desktop 与专用验收宿主采用同一来源验证边界，不只按 profile 名授权。
- 不允许未经认证者提交任意目标 URL；禁止重定向。
- 多个主空间实例存在时拒绝歧义，不以最后注册者覆盖。
- 进程退出、插件卸载、generation/epoch 失效后撤销对应会话。
- HTTP 检查 Host、方法、Content-Type 和 body limit；Cookie 不是能力授权，浏览器 Origin、预检和跨域访问不获准。
- 信任边界是 host 进程，不宣称隔离同进程插件或同 OS 用户。

主空间身份注册、私有 listener 和权限存储在本轮 P0 验证；不把已有 handoff route 当作完整实现。

### 3.6 能力注册、发现与版本协商

执行器只接受插件显式注册的能力描述：

```ts
interface CapabilityDescriptor {
  id: string;
  version: number;
  methods: Array<{
    name: string;
    resultMode: "unary" | "stream";
    cancellation: "cooperative" | "unsupported";
    effects: "read" | "external" | "mutation";
  }>;
}
```

注册同时提供输入/输出校验器、handler、授权检查、资源限制和 disposer。描述只包含受限静态数据，不携带可执行 schema、凭据或服务对象。

发现操作：

- 指定一个目标，返回当前来源获准看到的能力。
- 不扫描全部空间，不返回未授权能力名或目标白名单。
- 返回支持的协议版本、能力版本、方法和必要资源限制。
- 本轮通道只有 v1，LLM capability 只有 v1。
- 调用明确携带版本，不兼容立即返回错误。
- 发现结果过期时，调用按当前注册状态拒绝；不能自动改用其他版本或目标。
- 不做后台刷新、失败后的重新协商或自动重连。

通用 registry 是当前进程内的注册表，不是跨 Home 服务发现平台。卸载能力同步撤销其描述和新调用准入。

这延续现有静态 capability 查询的隐私和权限原则。

证据：`docs/message-bus/static-capabilities.md:15`；`packages/view-bridge/src/message-bus.ts:76`。

### 3.7 通用流帧与终态

`invoke` 对 unary 和 stream 都使用同一种 NDJSON 帧结构。建议帧类型：

- `accepted`：已完成准入并绑定目标；不代表业务成功。
- `data`：递增 seq 和 capability 定义的数据。
- `terminal`：唯一终态，状态为 succeeded、failed 或 cancelled，并携带受限结果或错误。

规则：

- 正常调用恰有一个 terminal；terminal 后禁止再发数据。
- EOF 无 terminal 是传输失败，不是成功。
- accepted 不意味着事务提交，也不意味着一定已调用供应商。
- unary 方法只允许契约规定的结果数量；stream 方法允许多个 data。
- 业务错误、取消、协议错误和连接断开分别表示。
- 代理在已发送 header 后不能改发普通 JSON 错误页。
- requestId 只做关联及活动请求冲突检测，不承诺持久化 exactly-once 或去重重放。
- 本轮每次显式调用最多派发一次；连接断开不自动重发。
- 序列号用于同一流的完整性验证，不用于续流。

LLM 的 `StreamChunk.finish` 是能力数据语义；外层 terminal 是调用终态。映射必须保持一致：供应商 error/aborted finish 对应外层 failed/cancelled，不能在收到错误 finish 后给出 succeeded。外层失败而没有 LLM finish 时，由 LLM adapter 映射为官方失败终态，避免生成两个终态。

### 3.8 取消、副作用与资源上限

取消通过两种机制统一进入服务端 AbortController：

- 活动 HTTP 调用断开或客户端 AbortSignal。
- `/cancel` 对同一来源所属 requestId 发出取消请求。

`cancel` 不拥有额外能力，也不能取消别人的请求。取消确认只表明请求被接受处理，不表明副作用已经撤销。

能力 handler 必须声明取消语义。对于不能中止的 handler：

- 停止向客户端交付不等于停止执行。
- 实际 handler 未结束前继续占用执行并发配额。
- 客户端结果可标记取消请求已发出、结果未知。
- 不释放配额后允许无限启动新的挂起工作。
- 不执行补偿、撤销或恢复。

设置每来源、每目标及全局的并发数、请求字节数、帧大小、队列字节数、准备句柄数和时间预算。超限立即拒绝或终止本次调用，不增加排队重试。

采用 `write()`/`drain` 和按需读取；供应商 SDK 可能自行缓冲，达到内存上限时真实失败，不宣称不可证明的端到端背压。

原总线已经区分超时与真实取消，本计划继续保留此边界。

证据：`packages/view-bridge/src/message-bus.ts:89`；`docs/message-bus/phase-one.md:55`。

### 3.9 通用活动记账与 LLM Apply 解耦

通用层维护当前调用的：

- 来源、目标实际实例。
- capability/method。
- 活动阶段和资源占用。
- cancel/dispose 状态。

不记录正文，不保存可重放任务。

能力注册声明所需的生命周期准入类别，由本地适配器接入对应服务；调用者不能在 payload 中选择“免活动统计”。

LLM 接线：

- 子空间官方 activity wrapper 继续包住完整流消费。
- 模型调用经继承 adapter 转发，仍被算作 LLM busy。
- 原 `llm.apply` 的 idle reservation 和 unknown 拒绝不变。
- 如准备阶段需要持有可影响 Apply 的资源，明确接入现有准入并测试竞态。
- 通用调用计数不能代替原有 Agent/maintenance busy 判定。

未来消息、web 能力不自动算作 LLM busy。它们应在各自实现时选择生命周期准入规则，避免任何背景通知都阻止模型 Apply。

证据：`packages/llm-bridge/src/activity.ts:51`、`:167`、`:252`；`src/adapters/node/supervisor/llm.ts:131`。

### 3.10 通用错误与隐私

通道级错误类别建议包括：

```text
invalid-input
unauthorized
target-unavailable
capability-unavailable
version-unsupported
overloaded
deadline-exceeded
cancelled
disconnected
protocol-error
execution-failed
```

错误结构分离：

- 通道 code。
- 来源阶段。
- capability 的可选 domainCode。
- 脱敏 message。
- 结果是否已确认，或是否无法判断执行副作用。

LLM 的 AUTH、RATE_LIMIT、主空间默认缺失等放在 domainCode，不把通道错误全部命名为 `LLM_*`。

已知事实如实报告；不知道目标是否执行时明确结果未知。不能把所有失败压成“未执行”。

日志只保留身份代次、requestId、能力名、方法、阶段和脱敏分类。不默认记录 payload、结果、聊天、工具参数、认证头、附件或 replay state。发现描述也属于受限数据。

故障政策：`docs/let-it-crash.md:5`、`:66`、`:74`。

## 4. 首个能力：主空间 LLM 继承

### 4.1 执行位置

调用链：

```text
子空间官方 Agent
 → MainInheritanceAdapter
 → capability: spaces.llm.inherit/v1
 → Supervisor
 → 主空间 CapabilityExecutor
 → 主空间 agentDefaultModel / ctx.llm
 → 已配置的官方适配器
 → 供应商
```

Key 留在主空间凭据服务和适配器内。Supervisor 经过请求正文，但不取得供应商 Key。

不在 Supervisor 重建官方配置，不加载第二套主空间 Agent/session/storage，不在主空间创建子空间会话。

`GlobalLlmHost` 继续处理共享连接管理。`attachOfficialLlm()` 只作为服务/守卫接入参考，不等于完整 pi-ai 初始化。

证据：`src/adapters/node/llm-host.ts:10`；`packages/llm-bridge/src/official-host.ts:14`。

### 4.2 为什么不直接读配置再驱动 PiAiAdapter

现有读取器只提取 profile patch；接管工具会删去认证相关字段，凭据复制还是特定格式提取。公开 PiAiAdapter 构造器要求 resolved profiles、auth 和附件服务；完整 profile resolver 没有从实际入口导出。

因此不能把这些辅助方法拼接后宣称与主空间有效配置等价。

证据：`src/adapters/node/profile-settings.ts:63`；`src/adapters/node/llm-space-settings.ts:113`、`:162`、`:184`；`node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/types/adapter.d.ts:34`；`lib/index.js:2968`。

不得通过每次执行 `dsh --profile web --dump-config` 读取配置；仓库已注明它可能 materialize 主空间文件。

证据：`src/adapters/node/workbench-supervisor.ts:1120`。

### 4.3 LLM capability 方法

拟定能力内方法：

| 方法 | 作用 |
|---|---|
| `describeDefault` | 当前默认模型及必要脱敏能力 |
| `prepare` | 绑定本次目标、能力代次与一次性调用句柄 |
| `stream` | 消费句柄并执行一次官方调用 |
| `release` | 释放本次未消费句柄 |

取消属于通用通道，不再创建 `llm.cancel`。LLM 的 prepare/release 只是该能力方法，不能让所有未来 capability 被迫实现两阶段调用。

句柄仅在内存中，绑定来源启动身份、目标实例、能力版本与调用；超时、取消、消费和实例退出后失效，不持久化、不跨重启重放。

### 4.4 默认模型与显式配置

新空间无显式模型选择时，使用虚拟路由：

```text
provider = spaces-main
model = default
```

“当前默认”定义为**本次模型调用准备时**主空间服务返回的 selection。

- 后续调用看到后来保存的新默认。
- 在途调用不改目标。
- 一个 Agent turn 的多个模型步骤可以在下一步骤跟随新默认。
- 会话、空间本地显式选择及既有共享绑定保留原语义。
- 显式目标失效时失败，不尝试继承路线。
- 首版不按名字选择主空间任意其他 provider/model。

UI 展示“跟随主空间默认模型”及实际目标，不把虚拟路由当成需要填写 Key 的 provider。

### 4.5 官方 adapter 和调用准备

子空间注册独立 `MainInheritanceAdapter`，不能伪造一个带假 endpoint/key 的 pi-ai provider。

至少覆盖：

- providerInfo/listModels。
- resolveModel 的 context、输出能力、reasoning、模态及动态更新能力。
- prepareCall 的目标和代次绑定。
- stream 转发。
- 官方会调用的图像请求能力接口。

保留 `llm/stream` 守卫和 activity wrapper。实际执行推荐由 adapter 的 stream 完成，以利用 prepared-call 闭包；仅靠 waterfall 短路不能覆盖官方 Agent 的提前模型准备。

官方 `LlmRuntime.prepareCall()` 冻结完整 controls；adapter 的 prepareCall 参数未必含全部最终 controls。因此 P0 必须证明以下流程：

1. 远端 prepare 绑定真实目标和能力代次。
2. 完整请求到达后通过官方服务准备调用。
3. 发出供应商请求前确认与先前目标、能力代次一致。
4. 不可安全保持一致时返回 `CONFIG_CHANGED`，本次不发供应商请求、不重新准备。
5. 已进入官方 prepared stream 后沿用冻结配置。

若公开 API 无法证明该边界，由父代理决定官方扩展接口；不使用私有字段或复制内部实现。

证据：`node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts:92`、`:180`；`lib/index.js:2220`。

新 route ID 需要单独纳入受管冲突检测；不能假设旧 UUID route 正则已经覆盖它，也不能破坏旧 route 的解析。

证据：`src/core/domain/llm-connections.ts:168`；`packages/llm-bridge/src/settings-provider.ts:38`。

### 4.6 流、重试与错误

完整传输官方 StreamChunk，包括 block、工具、reasoning、usage、finish 和 opaque replay state。

- 不修改被冻结的原请求；创建 wire 投影。
- 保留部分输出，断流不补造成功。
- consumer return、取消、目标退出必须释放本次流及句柄。
- 继承 adapter 明确返回零自动重试策略，不能返回 undefined 继承官方默认。
- 有官方 retry 插件时仍验证本路径只发起一次供应商调用。
- Spaces 不新增 retry、模型 fallback 或备用执行器；第三方插件自行行为按项目原边界说明。

证据：`node_modules/@deepseek-ai/dsh-llm/lib/types/retry-policy.d.ts:19`；`docs/let-it-crash.md:86`。

LLM 特有失败包括默认缺失、配置变化、附件不可访问、主空间目标不兼容等，通过 capability domainCode 投影。实际供应商错误保留分类并脱敏。

### 4.7 附件、工具和会话隔离

子空间执行工具并持久化会话；主空间只执行 LLM 调用。

附件不能直接把子空间 reference 丢给主空间默认 attachment store。请求级附件桥接必须：

- 在子空间原有授权范围内解析引用。
- 使用受限数据和 opaque ID，不允许任意主机路径读取。
- 主空间按请求隔离附件读取能力，不替换全局服务造成并发串用。
- 不写主空间默认 sessions/storages。
- 对 sessionId、附件 ID 和句柄按来源实例隔离。
- 不支持的模态明确拒绝，不静默丢图。
- replay 保留官方可解释的真实 provider/model 信息，验证默认改变后的行为。

附件若需要独立传输方法，放在 LLM capability 的受限方法内；只有将来第二个消费者证明确需复用时，再抽通用附件能力。

证据：`node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts:61`、`:79`、`:407`；`node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/types/adapter.d.ts:57`。

### 4.8 生命周期与 Apply

主空间 host 退出后，LLM 继承失败；Supervisor 不读配置继续代跑，不自动启动主空间。

这意味着新能力依赖主空间服务存活，与旧共享连接的子空间直连特性不同。官方窗口是否关闭服务由实际生命周期决定，不用窗口显示状态推断。

模型默认更新影响后续调用，不需要对子空间 Apply。子空间策略变更仍按照现有正常显式应用语义处理，不能运行中偷偷更换 route。

原 `llm.apply` 对 busy、unknown 和 idle reservation 的规则保持。新的通道或主空间注册只能由正常生命周期建立，不能失败后自动复活或将旧调用迁到新实例。

证据：`src/adapters/node/supervisor/llm.ts:131`、`:264`；`docs/let-it-crash.md:9`。

## 5. 未来消费者设计——本轮不施工

### 5.1 空间间调用

未来调用沿用：

```text
space A → Supervisor → space B 的 CapabilityExecutor
```

寻址使用 `target: {kind:"space", spaceId:"..."}`，Supervisor 固定到 B 当前实际实例。不能根据显示名、端口或调用者提交的 URL 路由。

授权必须同时满足：

- A 的 token scope 明确允许 B 的某能力/方法。
- Supervisor 策略允许这次方向的调用。
- B 的目标策略允许 A。
- B handler 自身资源授权通过。

默认拒绝。现有 `allowedSpaces` 可以作为未来兼容映射的目标授权来源，但不能由“发现了 operation”推导许可。

现有 IPC 总线保持：

- 不在本轮改 `ctx.spaceMessages`。
- 未来可将一个显式 operation 注册为新 capability handler，或提供明确兼容 facade。
- 不把所有旧 operation 自动公开。
- 不双投递同一请求。
- 旧 handler 不支持取消时，描述必须标记 unsupported。
- 避免 A→B→A 形成无界调用链；未来消费者实现时应沿用可信调用关联并限制委派深度，不能转发来源 bearer。

### 5.2 空间消息收发

未来消息可使用显式的 `send` 方法及目标 handler；如需要实时接收，可通过受权的流式 `subscribe` 方法表达。

权限必须区分：

- 向目标发送。
- 从指定来源/主题接收。
- 订阅哪些事件。
- 消息是否能触发 Agent 或工具执行。

允许收消息不等于允许触发目标 Agent 执行，也不等于读取目标会话。

首个未来版本应明确在线、内存语义：

- 目标离线即失败。
- ack 必须区分 handler 接受和业务完成。
- 丢失响应时结果未知。
- 不默认广播，不持久化收件箱，不跨重启 replay，不自动重新订阅。
- 慢消费者受通用背压和资源限制，不无限缓存。
- 需要持久消息或 exactly-once 时另立产品契约，不能声称现有通道已保证。

本轮不建设收件箱、消息 UI、订阅 handler 或 HTTP→IPC 迁移。

### 5.3 `ctx.web` 转发

`ctx.web` 在这里是用户提出的未来能力类别，不假定它与当前官方 `ctx.webServer` 是同一服务，也不预先确定其方法。

只读包源码检索未发现 `ctx.web` 的实际使用；`package-lock.json` 中匹配的 web/browser 相关包只有 `dsh-host-webserver`。因此 `ctx.web` 指向的官方服务、版本和可用 hook 都属于未验证项，不按 fetch 或浏览器代理预定义。

已核对当前包公开的是 `webServer` 路由服务；Desktop 的实际宿主能力还需按官方版本查明。

证据：`node_modules/@deepseek-ai/dsh-host-webserver/lib/types/index.d.ts:16`。

未来接入应定义具体 capability，逐方法授权；具体方法集待源码核对 `ctx.web` 的真实服务后再定，不由本节预设。授权按 capability 粒度发放，不按“web 能力”整体授予：

- 只注册有限方法，不暴露任意 `ctx.web.*` 反射。
- 明确目标对象、URL/origin、操作类型和数据访问范围（若该服务涉及）。
- 不同操作类型（导航、脚本执行、页面读取、路由注册、外部请求等，若存在）不能共用一个宽泛“web access”scope。
- 不序列化 Context、函数、DOM、IncomingMessage、ServerResponse 或浏览器认证 Cookie。
- 服务不可用或方法不兼容时，返回 capability unavailable/version unsupported。
- 需要事件通知时使用同一 stream framing 与取消语义，不另造认证通道。
- route 注册等长生命周期资源若有真实需求，要定义 handle/dispose；不能把断开解释为已撤销副作用。

本轮主空间私有 listener 只用于能力通道，**不构成已实现 `ctx.web` 转发**。

### 5.4 其他 `ctx.*` 能力

每个服务必须有独立命名、方法 schema、权限与生命周期说明。一个 capability 不能携带另一个 capability 的 bearer，也不能无限传递执行权。

纯查询、外部调用和管理写入分别处理。未来若有 mutation 能力，必须接入现有 Home 单写者、revision/CAS 和原子写边界，不能因为已有通道就绕过管理准入。

## 6. 新增能力接入指南

新增消费者按以下接缝接入，不修改通道鉴权或帧协议：

1. **命名与 schema**  
   定义独立 capability ID、整数版本、固定方法和输入/输出类型。使用通用 `CapabilityCall`，业务结构放 payload，不新增专用 transport URL。

2. **目标注册**  
   在目标 host 的 `CapabilityRegistry` 注册 descriptor、schema、handler、授权检查、资源限制与 disposer。服务缺失就不宣称能力可用。

3. **授权 scope**  
   在 Supervisor 的可信启动/授权流程生成精确 target/capability/version/method scope。目标端加入来源策略。不能用 discovery 自动授予权限。

4. **子空间服务接入**  
   使用 `CapabilityClient` 包装为一个明确的 Cordis service 或公开扩展点。LLM 通过 adapter 和 `llm/stream` 相关生命周期；其他服务选择它自己的公开 hook，不能假设所有 `ctx.*` 都有 waterfall。

5. **结果与取消**  
   unary/stream 都使用 accepted/data/terminal。handler 接受通用 cancellation context，并如实声明是否可中止；长生命周期资源实现所属能力的显式 release/dispose。

6. **活动与写入准入**  
   选择本地服务对应的活动类别。LLM 接 LlmActivity；其他能力不复用 LLM busy。写操作接现有单写者边界。

7. **测试与发现**  
   测授权过滤、过期发现、旧实例、取消、丢响应、超限、脱敏、资源释放和业务副作用边界。未实现能力不能出现在生产 discovery 中。

8. **文档和打包**  
   更新能力说明、支持版本和测试清单，验证正式包包含 handler 及依赖。通道协议不变时不升协议主版本；能力 schema 不兼容变化升能力版本。

通用通道用测试专用 unary/stream handler 验证没有绑定 LLM；这些夹具不打包、不注册为产品能力。

## 7. 兼容、迁移与界面

### 7.1 共享连接库的去向

本轮推荐共存：

- 新建空间默认继承主空间。
- 旧共享连接仍有正常管理、解绑和 Apply 入口。
- catalog 管理退到高级区域，不作为零配置路径前置步骤。
- 不删除 catalog、凭据、测试或旧绑定。
- 将来如果决定封存，单独规定旧用户管理路径。

看板单开关封存可作参考，但它不证明可以无代价隐藏仍被空间依赖的连接管理。

证据：`packages/plugin/src/workbench/dashboard-sealed.ts:1`；`packages/plugin/src/workbench/llm/space-binding.tsx:60`。

### 7.2 新旧策略

引入明确的新策略版本，区分主空间继承与旧 shared 策略：

1. v1 policy 和无文件旧空间继续按旧语义读取，不写盘。
2. 新建无显式配置的空间记录 v2 main-inherit。
3. 旧空间显式选择继承后，才按 Home 写权、revision CAS 和原子写提交。
4. 未知 schema 拒绝。
5. 本地/会话显式模型保持优先；失效不转继承。
6. 损坏旧 catalog/policy 不被当成“没有配置”而自动启用继承。

不能直接改变 `emptyPolicy()` 的缺省含义，否则会迁移无文件旧空间。

证据：`src/core/domain/llm-connections.ts:233`；`src/adapters/node/llm-policy-store.ts:42`。

### 7.3 创建、模板、蓝图与分享

所有创建入口统一规则：

- 无显式 LLM 配置的新空间默认继承。
- 模板/导入的显式绑定、默认和必需连接引用保留。
- `useSharedLlm` 旧字段保持明确兼容解析，不悄悄改义。
- 主空间未配置模型不阻止空间定义创建；需要模型时显示真实失败。
- 分享不包含 token、实例、句柄、凭据或其派生值。
- 能力 scope 由接收方本地策略生成，不能随模板导入任意授权。

证据：`src/adapters/node/workbench-supervisor.ts:1396`、`:1424`。

### 7.4 UI 与可访问性

- 创建页说明“使用主空间模型，无需再次配置”。
- 空间详情显示模型来源：主空间、本地、共享连接。
- 主空间模式显示当前真实目标和下一次模型调用生效的粒度。
- 区分目标策略与运行策略。
- 旧连接放高级区域，不删正常管理能力。
- 官方聊天模型列表识别虚拟路由，不反复要求 API Key onboarding。
- 错误使用原位置 alert，键盘、标签、禁用状态和焦点可用。
- 本轮不增加通用权限控制台或未来能力开关。

证据：`packages/plugin/src/workbench/llm/space-binding.tsx:97`；`src/shared/llm-api.ts:142`。

## 8. 分阶段施工

### P0：通道契约与关键原型

产出：

- 固定通用信封、scope、帧、错误、发现与取消契约。
- 固定 LLM capability schema 和策略兼容表。
- 证明主空间 host 的私有 listener、认证注册及 lifecycle 在官方 Desktop/Web 可行。
- 证明官方 currentSelection、adapter、prepareCall、最终 controls 和配置代次边界。
- 证明请求级附件访问和虚拟模型 UI 可用性。
- 核对关键官方包版本和公开导出，不使用私有 API。

验证：

- 通道测试夹具覆盖 unary/stream，证明不是 LLM 专用传输。
- mock provider 验证文本、工具、取消、默认切换和配置变化拒绝。
- 验证附件最小链路及无主空间 session/storage 写入。
- 不为准备夹具写 `profiles/web/`；使用注入主空间身份的测试 host 或已有隔离环境。
- P0 未闭合项记为阻塞；文字原型通过不代表全部能力通过。

### P1：共享契约与策略兼容

产出：

- 通用 wire 校验器、错误结构、scope 授权模型。
- 能力注册/发现最小核心。
- LLM v1/v2 策略及新建缺省。
- reserved route 分类和冲突检测。

验证：

- v1 all/selected/none、无文件旧策略、未知 schema、revision 竞态。
- 非 JSON、路径/URL 注入、未授权目标/方法、发现过滤。
- 新 scope 不允许管理 API、未来能力或任意 `ctx.*`。
- 旧消息总线契约不变。

### P2：通用运行通道与主空间执行器

产出：

- Supervisor capability 网关。
- 主空间插件私有 listener、认证注册和执行器。
- 代次绑定令牌、调用路由、背压、取消和活动计数。
- LLM handler 与内存准备句柄。

验证：

- 双段真实 HTTP。
- 旧 token/epoch/generation、跨空间 handle、伪造来源、浏览器 Cookie/Origin。
- 慢消费者、帧截断、EOF、超限、目标退出和 caller 退出。
- 挂起执行不因客户端超时无限释放配额。
- 无自动重连、请求重发、正文或秘密日志。
- 未实现能力不被发现或调用。

### P3：子空间 LLM 与官方 Agent 集成

产出：

- MainInheritanceAdapter、默认投影和能力映射。
- activity/冲突守卫接线。
- 请求级附件与 replay 兼容。
- 启动环境和 bridge 版本兼容。

验证：

- 官方 Agent 首次调用、工具后续轮次、标题/压缩辅助调用。
- 文本/图像/文件、多空间并发及身份隔离。
- busy/unknown Apply 拒绝，idle 后正常显式 Apply。
- 显式 local/shared 维持原直连路径。
- 默认变化与最终 controls 一致性。
- 正式构建产物包含全部服务端依赖。

### P4：创建和界面集成

产出：

- 新建默认继承。
- 详情模型来源和高级共享连接入口。
- 模板、蓝图、分享及旧 API 兼容。
- 现行需求、旧计划状态、通道接入指南和任务说明。

验证：

- DOM 零配置创建→官方聊天可用，不再重复 onboarding。
- 主空间默认更新后的来源展示和下一次请求。
- 旧空间无自动写入。
- 键盘和错误可见性。
- 看板仍封存，消息总线保持原入口。
- 不出现未实现的 web/消息能力菜单。

### P5：真实进程与全量验收

环境使用隔离 Home、真实 Supervisor、至少两个真实子空间、主空间官方测试 host 和本地 mock provider。

验收：

1. 主空间已有配置和唯一 marker key。
2. 新空间无本地 Key、无共享连接，直接成功调用。
3. provider 收到主空间 Key；子空间、Supervisor 诊断和持久化产物不含该 Key。
4. 默认变更影响下一次请求；在途流不混配。
5. 工具、附件、取消、故障和 Apply 按契约。
6. 两空间并发身份、会话和附件不串。
7. 既有 shared/local 与消息总线回归通过。
8. 包分发、官方 Desktop 与 Web 分别验收。

未来消费者不加入这些阶段的施工清单。通用骨架用夹具证明扩展点，不搭建真实未来业务来凑验收。

## 9. 验收与测试策略

### 9.1 覆盖矩阵

| 层级 | 必须验证 |
|---|---|
| 通用单元 | 信封、scope、发现过滤、版本、帧顺序、终态、脱敏 |
| 策略单元 | 新旧缺省、显式优先、CAS、受管冲突 |
| 官方运行时 | adapter、prepareCall、能力、默认变化、controls、replay |
| HTTP | 双段认证、取消、背压、EOF、坏帧、超限、旧实例 |
| 活动与生命周期 | LLM busy/idle、挂起执行计数、插件卸载、服务退出 |
| 浏览器 DOM | 零配置、官方模型列表、来源、错误、键盘操作 |
| 真实多进程 | 两空间并发、单次供应商调用、退出撤销、附件隔离 |
| 兼容 | shared/local、模板/分享、已有 IPC 总线 |
| 分发 | Supervisor/plugin/bridge 依赖与协议版本 |
| 隐私与写入 | sacred trees 不变、Key/token 不泄漏、正文不落管理日志 |

测试专用通用 handler 证明：

- 新能力可以只注册 descriptor、scope 和 handler。
- 不修改认证及 transport 即可处理 unary 和 stream。
- 能力错误独立于 LLM。
- 不存在生产环境 echo、任意执行或调试能力。

### 9.2 完整项目门

```text
npm run check:test-lists
npm run typecheck
npm run typecheck:spaces
npm run typecheck:tests
npm run build
npm test
npm run test:spaces
npm run test:workbench
npm run test:workbench:recovery
npm run test:llm
npm run test:blueprints
npm run test:browser
npm run test:dashboard
npm run test:workbench:browser
npm run test:llm:browser
npm run test:llm:integration
npm run check:plugin-package
```

新测试进入正式清单；`check:all` 没包含的专项额外运行。

环境：

- 支持 Node 24.21+ 的 24.x 和 Node 26。
- Dashboard 使用 `DSH_DASHBOARD_SDK_ROOT` 指向匹配 CI 的官方 SDK 安装。
- 浏览器 DOM 使用 Playwright Chromium。
- Windows rename 检查使用已有、可写的仓库外临时目录。
- 不将临时根改成 `.sandbox/tmp` 绕过限制。
- 通过既有 `check:all --temp-root` 等合规入口执行，不自行选择未授权外部输出目录。
- 已知 `test:workbench`、`test:workbench:recovery`、`check:plugin-package` 在会话沙箱受 esbuild 外部临时目录写入限制。遇到同类限制保留失败并记未验证，交授权普通进程运行；不降低断言、不加重试。

证据：`AGENTS.md:25`；`tasks/todo.md:9`；`package.json:74`。

### 9.3 最终验收标准

- [ ] 新空间零额外模型配置即可使用主空间已配置 LLM。
- [ ] 每次调用按定义跟随当前默认，在途目标和能力一致。
- [ ] 显式本地、会话及共享绑定不被改写。
- [ ] 通道身份、scope、寻址、发现和版本不依赖 LLM。
- [ ] 未授权能力、目标、方法和旧启动令牌无法调用。
- [ ] Key 留在主空间，token 不进入浏览器或持久化。
- [ ] 工具、附件、StreamChunk 和 replay 完整。
- [ ] 取消及结果未知语义真实，无请求重试、fallback 或恢复。
- [ ] 通用活动记账不替代或污染 LLM Apply。
- [ ] 现有 IPC 消息能力保持兼容。
- [ ] 未来能力只有设计和接入指南，没有隐式开放。
- [ ] 全量、专项、分发、官方 Desktop/Web 的验证状态分别可追溯。
- [ ] 不修改真实 Home、sacred trees 或来源不明的既有改动。

## 10. 风险、取舍与未决问题

### 10.1 架构取舍

**主空间生命周期依赖。** 直接复用主空间有效服务最忠实于零配置目标，但它退出后继承不可用。若要求主空间关闭仍可推理，应另行规划独立执行器与完整配置解析；不添加文件解析备用路径。

**新增私有 listener。** Desktop 不保证存在 webServer，所以需要插件持有独立 loopback listener。它增加本地攻击面和生命周期工作量，但避免把协议绑定到某个 UI host transport。必须认证、限流、绑定实例并正确 dispose。

**共享连接库共存。** 保留旧用户管理能力；新用户无需经过 catalog。整体封存属于后续独立产品决定。

**两种通道暂时并存。** 旧 IPC 总线已经服务现有消息调用，本轮 HTTP 面向主空间与流式能力。并存是有意的兼容边界，不能通过顺手迁移扩大施工。

### 10.2 防止过度设计与过拟合

| 问题 | 本轮处理 |
|---|---|
| `/spaces-llm/` 专用端点 | 改为 `/spaces-capabilities/v1/` |
| LLM-only token | 改为精确 capability/method/target scopes |
| 所有错误都是 `LLM_*` | 通道错误与 domainCode 分离 |
| 所有活动都算 LLM busy | 通用计数与本地领域准入分离 |
| 所有能力必须 prepare/stream/release | 这些仅为 LLM 方法 |
| 把 `ctx` 整体远程暴露 | 只允许显式注册的命名能力 |
| 未来全部能力自动授权 | 本轮只发放 LLM scope |
| 建设持久消息平台 | 本轮不做 |
| 为未来能力重写现有 IPC | 本轮不做 |
| 依赖 `ctx.webServer` 承载协议 | 使用独立私有 listener |
| 为证明通用性搭建未来产品 | 只用测试夹具 |

### 10.3 P0 必须解决的技术问题

- 官方 Desktop 主空间服务上下文、插件加载顺序及身份注册。
- prepared-call 与最终 controls 的一致性。
- 请求级附件访问及并发隔离。
- 虚拟 route 的官方 UI/Agent/replay 兼容。
- 官方服务与插件是否产生未预期日志、重试或持久化。
- 多主空间实例歧义处理。

这些是需要验证的问题，不代表已经判定不可实现。

2026-10-21 P0 局部原型后的决议：当前不冻结 LLM capability v1，P1 不放行。`p0-llm-1/RESULT.json` 的 G2 PASS 只覆盖自行构造 adapter 的机制实验；指定 Astra 复核确认主空间实际 adapter 的 profiles Map 在官方插件闭包中，不能把原型持有的 Map 当作主空间公开 generation。G3 两请求同引用读到 A 的现象只证明当前夹具未实现路由；公开代码另证明官方图像 resolver 捕获插件 ctx，且 GenerateOptions 无请求级图像字节读取参数。Cordis scoped service 仍有独立语义，文件 handle 投影尚未正确验证，不能把它们一并判为不可行。原始实验保留于 `.sandbox/construction-20261021/p0-llm-1/`，不重写成正式通过。

后续曾形成 [最小官方接口修订提案 v0.2](llm-official-seam-proposal.md)，并经 Astra 文档复审；这是历史候选，不是已实现契约。用户随后明确：我们只是插件，不可能修改官方 SDK。上游改动方向撤销，不再等待新增官方方法，也不把文档 READY 当成可行性通过。不可暴露私有 adapter/resolver 或凭据，不全局替换 attachment store，不静默丢图，不在失败后重新 prepare。

Codex 接手重新核对的插件边界：

- 官方 rc.2 的公开 `agent/request` waterfall 在随后 `llm.prepareCall` 与请求头记录前返回配置，允许异步处理。真实官方 Agent loop 的内存会话实验已证明：异步返回的 reasoning/maxTokens 写入请求头并进入唯一一次冻结派发，见 `.sandbox/construction-20261021/codex-agent-request-1/RESULT.json`。可研究在此提交子空间显式 controls，并在官方冻结前带回主空间已准备配置；跨进程主空间交接、默认 provenance、辅助调用、句柄关联与并发仍须证明，不能靠 signal/sessionId 猜关联。
- 官方 `llm/stream` waterfall 在 `adapterStream` 的文件投影和 `forAdapter` 之前。新局部原型在公开 `LlmRuntime` 与自定义测试 adapter 上证明：prepared-call 中间件看到完整 file block 与真实 replay source，可短路默认 adapter；调用 `next()` 的对照仍投影/过滤。请求保持冻结且未变，供应商调用零次。证据：`.sandbox/construction-20261021/codex-takeover-2/RESULT.json`。这使“必须新增 pre-projection/replay hook”的推论不成立为已证阻塞；真实来源授权与主空间最终官方 adapter 的过滤仍需保持。
- 官方 pi-ai 的图像读取仍捕获自己的 attachments 服务，不能仅在调用方使用 `ctx.isolate` 就宣称 resolver 已改变。静态公开服务组合能否在不替换运行中全局服务、不复制私有配置的条件下解决它，尚未证明。
- 原型不是正式通道、真实 Agent 或官方 host 验收。第一次局部运行因清理误用 `root.dispose` 失败，保留于 `codex-takeover-1/FAILURE.json`；更正为公开 `root.fiber.dispose` 后的新独立目录完成。旧失败现场、P0 状态及 C01–C18 要求不被覆盖。

后续先以插件方案重新逐项映射验收要求；旧两阶段候选中的代次与冻结时点不能未经说明搬成插件承诺，也不能未经决策删除。G1–G4、S1 和契约均未闭合，P1 仍不放行。

后续用户授权的真实 Supervisor 注册/来源 IPC、图像请求级回读与 DeepSeek Messages/Files 集成已完成 31 项隔离验证，见 [结果与剩余边界](llm-supervisor-images-deepseek-results-20261021.md)。Astra 三轮发现取消及异步终结缺口，已补上准备前登记与 requestId 远端取消、独立清理索引和终结屏障、等待后来源复查及失败状态保留、图像超时匹配 IPC cancel；最终新 Home 通过，Astra 独立复核 READY（仅该轮有界集成）。用户又授权主服务/facade 接入正式插件，模型发现、默认值、controls 与普通创建真实 Agent/UI 的本轮实施见 [正式插件报告](llm-formal-plugin-agent-ui-results-20261021.md)，不继承前轮 READY。官方 SDK 未改；Files 失败政策、完整契约和 S1/P0 门槛未闭合，不能按历史候选接口施工。

### 10.4 工作树、失败与回滚边界

工作树存在大量既有改动。施工先确认归属，不 stash、不清理、不覆盖来源不明的文件，不提交、推送或发布。

本功能不提供自动或手动恢复、回滚、修复、备用路径、自动重启或断流续跑。失败保留现场，释放本次句柄和未发布资源；不能把取消等同于撤销副作用。

源码完成、文档完成、mock 真实进程通过和官方 Desktop 实测分别验收。未验证项明确保留，不能借通道设计完成宣称所有未来能力已可用。

故障政策唯一权威：`docs/let-it-crash.md:5`、`:17`、`:70`。
