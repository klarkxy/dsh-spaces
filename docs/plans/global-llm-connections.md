# DSH Spaces 全局 LLM 连接库施工计划

版本：1.0
日期：2026-09-18
状态：P0–P6 已在仓库落地。本文件仍是验收契约。未跑平台与 A25 限制见 [acceptance](../compat/global-llm-acceptance.md)。
项目核对基线：`klarkxy/dsh-spaces@861cf4e9a2025da15fbc3bf0e3560f9817499a82`。
建议施工分支：`feat/global-llm-connections`。
建议入库路径：`docs/plans/global-llm-connections.md`；任务入口：`tasks/global-llm.md`。

## 0. 决策摘要

建设独立于 `web` 的 Spaces 全局 LLM 连接库。子 Space 可以复用 web profile 的组成，但继续拥有自己的配置、插件栈、会话与工作数据。web 与子 Space 都是共享 LLM 资源的消费者，不存在 web 配置自动成为所有 Space 配置的规则。

首版交付：配置一次连接；新建 Space 可默认引用；各 Space 独立选择默认模型；共享连接与本地连接并存；全局信息只有一份权威数据；凭据不复制到子 Space；桌面与 Web 共用业务逻辑；明确展示保存状态与实际生效状态。

首版的关键取舍：运行中的 Space 在用户明确重启后应用新的共享连接版本。不做配置热广播、不在进行中的请求里换端点或密钥、不建设 LLM 请求代理。重复启动操作不是重复填写配置；批量正常重启入口解决前者，共享资源库解决后者。

### 0.1 已固定的边界

1. 不共享整个 `settings.yaml`，不以符号链接把子 Space 指向 web，不把 web 的生效配置当公共配置。
2. 不 fork 官方模型请求实现；调用仍通过各 Space 内的官方 LLM 服务与适配器。
3. 不增加第二套会话层、代理服务、负载均衡、自动模型切换或失败重试策略。
4. 共享连接的协议、地址、凭据、模型目录作为一个整体管理；子 Space 不逐字段覆盖它们。
5. 全局模型中心拥有共享连接写权；Space 内只选择引用、模型和本地连接。
6. 不自动收编已有连接、合并同名供应商、删除原配置或清理旧凭据。
7. 不承诺插件组合全部可用，不绕过当前 CLI 版本门禁，不引入故障恢复功能。

### 0.2 核验范围与限制

本计划核对了项目默认分支、启动器片段、任务持久化结构、插件包定义，以及上游 settings / credentials 的服务契约和文件实现。项目基线的依赖包含 `0.1.5-rc.2`，但本次没有运行该版本的多进程集成测试。[S1][S2][S3]

本次读到的上游服务源码来自其当前默认分支，不等于已验证 npm 发布的 `0.1.5-rc.2` 具有完全相同的导出和行为。因此 P0 必须用项目锁定的实际包验证接入原型；不得照搬 master 上的新 API 并宣称兼容旧包。[S4][S5]

当前 `ProcessManager` 的一个启动路径仍传入公共 `DSH_HOME`；这不足以单独证明实际 settings 路径相同，也不足以证明已经独立。本计划以用户明确的“Space 配置独立”为目标，P0 记录所有真实生效路径，不再从 README 或单个存储根推断全局作用域。[S2]

## 1. 首版范围与非目标

### 1.1 必须交付

| 能力 | 首版要求 |
|---|---|
| 全局连接 CRUD | 创建、编辑显示名/协议/地址/模型目录，引用检查后停用或删除 |
| 认证 | 显式 API Key；`none` 认证仅对固定版本原型验证通过的协议开放，不能填假 Key 绕过 |
| 协议 | 对官方 `llm-pi-ai` 中经 P0 验证的 Chat Completions、Responses、Anthropic Messages 建立明确支持矩阵 |
| 模型目录 | 手工录入、显式拉取、搜索和选取；发现结果不直接覆盖现有目录 |
| 默认模型 | 全局默认、Space 明确默认、会话明确选择三级区分 |
| Space 绑定 | 全部共享连接 / 指定连接 / 不使用；本地连接不受此开关影响 |
| 凭据 | 独立全局凭据存储、只写管理接口、Host 侧解析、不落入 Space 配置和任务日志 |
| 兼容 | 本地原有连接继续工作；缺适配器明确报错，不自动装插件 |
| 生效状态 | 目标版本、当前运行版本、待重启、失败原因；不显示虚假的“全部生效” |
| 导入与导出 | 仅显式接管单个连接；分享包不含 Key，也不含本机可复用秘密引用 |
| 双端 | Web 与桌面走相同核心、权限、写入和错误语义 |

首版优先把共享连接编译为官方 `llm-pi-ai` 可表达的命名路由。其他第三方适配器、官方专用适配器的专有功能、OAuth、云供应商 ambient credential chain 不自动转换。原来的本地用法保留。将来增加后端必须是明确的编译适配器，不是让首版接受任意插件对象。

特别是原生 `deepseek-official` 等旧路由，不静默改名或替换为新的通用协议路由。用户显式创建一个新的共享连接，是新增接入；不等于原生适配器的所有专有能力已经等价迁移。

### 1.2 本轮明确不做

云同步、多用户权限系统、租户隔离、OS 级密钥沙箱、计费/额度池、代理中转、全局并发调度、自动测速、后台周期探测、自动拉模型、自动修复、旧配置恢复、连接失败后降级、运行中全局热更新、任意版本兼容。

“只在某 Space 显示某连接”是产品选择策略，不是同 OS 用户之间的秘密隔离。上游本地凭据文档也明确说明，同用户的 agent 工具进程可以读取该用户文件。[S6]

## 2. 作用域与资源归属

“全局”限定为一个 Spaces 控制 Home，不是整台机器，也不是所有 DSH 安装。

| 数据 | 唯一权威位置 | 消费者 | 写入者 |
|---|---|---|---|
| 连接元信息、模型目录、全局默认 | 全局 catalog | 已接入的各 Space | 当前持有 Home 写权的控制端 |
| 全局凭据 | 全局独立 credential store | Space Host 侧受管凭据解析器 | 全局凭据 API |
| Space 绑定策略 | 该 Space 的 policy 文件 | 该 Space 的启动接入层 | 授权的管理操作 |
| Space 默认模型 | 该 Space 原有 settings 的 `agent-default-model` 用户层 | 该 Space | Space 设置接口 |
| 本地连接及本地凭据 | 该 Space 原有配置与凭据位置 | 该 Space | 原有本地接口 |
| 会话模型 | 原有会话模型选择与日志 | 原有 agent / session 层 | 会话操作 |
| 生效版本状态 | 内存运行状态及脱敏实例记录 | 管理 UI | 启动器/运行实例上报 |

全局连接不是 web 的子资源。web 默认保持未接入，除非用户显式开启。Space 默认接入全局连接：没有 policy 文件的 Space 视为 `mode=all`，启动时自动补装 bridge；只有显式选择“不使用”才写入 `none`。新建 Space 的向导预选“使用全局连接”，取消勾选即写入显式 `none`。

（2026-11 修订：原设计为“现有 Space 默认保持原行为、旧 Space 缺插件不自动补装”，实测导致全局设置对多数 Space 不生效、官方客户端反复弹 API Key  onboarding，故改为默认接入。）

“使用全部连接”意味着后来创建的共享连接也将在该 Space 下次启动时可见。界面必须写清楚这一点。选择“指定连接”则严格按 ID 列表，不自动扩张。

## 3. 目标架构

```text
Spaces 全局模型中心（Web / 桌面）
          |
          | 脱敏查询、管理命令、独立只写凭据请求
          v
现有 HomeController / Supervisor
  ├─ GlobalLlmService
  ├─ LlmCatalogStore
  ├─ GlobalCredentialStore
  └─ SpaceLlmPolicyStore
          |
          | 启动时读取受管配置快照
          v
每个已接入的 Space
  ├─ @dsh-spaces/llm-bridge
  │    ├─ 带受管 base 层的 settings provider
  │    ├─ 共享引用与本地引用分流的 credentials provider
  │    └─ 脱敏来源/版本状态
  ├─ 原有官方 llm-pi-ai 适配器（仍仅一套相应 namespace 注册）
  ├─ 原有其他本地适配器
  └─ 原有 ctx.llm → 模型端点
```

`llm-bridge` 不是第二个管理器，也不是 HTTP 请求代理。它不启动 Spaces 控制进程，不安装/卸载插件，不操作其他 Space，不把整个全局模型中心装进每个子 Space。

保留 `@dsh-spaces/view-bridge` 的轻量视图职责，新增独立 `@dsh-spaces/llm-bridge` 包，不把凭据和模型逻辑塞进 iframe 握手包。[S7]

## 4. 数据模型

以下类型是本功能拟新增的契约，不是已存在的上游 API。

```ts
type ConnectionId = string; // Host 生成 UUID；不以显示名为主键

type SharedModelRef = {
  connectionId: ConnectionId;
  modelId: string;
};

type SharedAuth =
  | { kind: "api-key"; credentialRecordId: string }
  | { kind: "none" };

interface SharedConnection {
  id: ConnectionId;
  revision: number;
  displayName: string;
  enabled: boolean;
  backend: "llm-pi-ai";
  // 由锁定版本的官方 schema 校验；没有秘密值。
  // api/baseURL/models 等只在这里保存一次，不再维护第二份通用同义字段。
  providerConfig: Record<string, unknown>;
  auth: SharedAuth;
  createdAt: string;
  updatedAt: string;
}

interface GlobalLlmCatalog {
  schemaVersion: 1;
  revision: number;
  connections: Record<ConnectionId, SharedConnection>;
  defaultModel: SharedModelRef | null;
  retiredConnectionIds: ConnectionId[];
}

type SharedSelection =
  | { mode: "none" }
  | { mode: "all" }
  | { mode: "selected"; connectionIds: ConnectionId[] };

interface SpaceLlmPolicy {
  schemaVersion: 1;
  revision: number;
  shared: SharedSelection;
}
```

### 4.1 约束

- `connectionId` 永久稳定且不复用；显示名允许重复，不负责路由身份。
- `providerConfig` 必须通过固定版本的官方 schema 与服务性校验。不是任意 JSON 透传通道。`apiKeyEnv`、秘密值、路由 ID 与凭据 record ID 不允许由这个对象覆盖，均由编译器按受管身份注入。
- 私密 header、URL userinfo、URL 中的 Key 不允许进入 metadata。首版不开放任意认证 header 编辑。
- UI 不显示但官方 schema 已认可的高级非秘密字段，编辑时保留；未识别字段不能靠“保留”绕过验证。
- model ID 保持上游精确值，可包含协议允许的斜杠等字符，不擅自规范化为显示名。
- 两个连接下相同 model ID 是不同目标，以 `(connectionId, modelId)` 区分。
- 全局默认必须指向启用且目录中存在的模型；不能引用某 Space 的本地连接。
- 未知 `schemaVersion` 拒绝读取，不尝试按旧版或空配置继续。

### 4.2 路由与凭据引用

拟定生成规则：

```text
routeId       = spaces-llm-<uuid去掉连字符后的小写十六进制>
credentialRef = SPACES_LLM_<UUID大写十六进制>_R<凭据版本>_API_KEY
recordKey     = spaces-llm/conn-<uuid十六进制>-rev-<凭据版本>
```

前缀专属于此功能。本地用户层及 composition 中占用该保留前缀的配置导致明确冲突，不能根据名字猜测它是“以前生成的配置”后覆盖。

路由 ID 不随显示名、端点或凭据轮换变化；凭据 record 版本不可原地覆盖。修改地址和认证时，创建新的完整连接版本，避免旧端点读到新 Key。

### 4.3 建议落盘结构

```text
<SpacesControlHome>/
  .dsh-spaces-control/
    llm/
      catalog.json
      credentials.yaml

<Space自己的数据根>/
  llm-policy.json
  settings.yaml         # 仅为示意；已有明确独立路径时保留原路径
  <原有其他数据>
```

`resolveSpaceConfigPaths(spaceId)` 必须由 Host 用已登记 Space 解析。前端不能传绝对路径，禁止 `../`、符号链接逃逸、任意 Home 覆盖。

不新增每 Space 的 `providers.json`、全局 Key 副本或“同步后的完整 settings.yaml”。运行时共享 base 只存在于内存；为启动接入生成的 overlay 只能含插件身份、非秘密路径/配置引用，不能含 Key。

## 5. 官方接入实现

### 5.1 Settings：共享连接进入 base，不进入本地 user 文件

建议新增 `SpacesFileSettingsProvider`，在锁定版本允许的公开/受保护扩展点上复用官方 `FileSettingsProvider`。本次上游源码可见 `SettingsProvider.register`、`load/persist/publish` 等服务契约，以及 `FileSettingsProvider` 的文件锁、原子写和 YAML 保留实现；具体发布包行为由 P0 证明。[S4][S5]

核心策略：

1. 保留该 Space 自己的 settings 文件路径。
2. 在 `llm-pi-ai` namespace 注册时，把该 Space 引用的共享路由投影进 registrant 的 `base.providers`。
3. 原有本地 provider 继续处于原有 composition / user 层，非冲突键并存。
4. 本地 user 层禁止出现 `spaces-llm-*` 共享路由。API 写入与文件外部修改都要验证。
5. 对 `agent-default-model` 的 composition base，仅在有适用全局默认时注入它；原有本地用户层仍可明确覆盖。
6. 其他 namespace 完全透传原逻辑，不深合并整个 web 或全局 settings 文档。
7. 同一 Space 根上下文只注册一个 `settings` 服务和一个对应的 `llm-pi-ai` namespace。不能再挂第二个 pi-ai 实例靠碰巧覆盖。

这保留了上游“默认值 → composition base → 本地 user”的解析形状，也避免写回时把共享数据复制到本地。

实现必须有契约测试，不依赖 monkey patch、私有字段、读取 node_modules 未导出文件或覆盖客户端 DOM。若固定版本不支持所需扩展，P0 判为接入阻塞，不悄悄改成复制配置/全局共用文件。需要提交最小的公开扩展接口变更并重新通过版本矩阵，不能把未验证原型当发布实现。

### 5.2 写入与文件编辑的防越界

受管键保护必须覆盖 `update`、`replace`、`mutate`、SDK 调用、官方设置页面以及外部文件 reload，不只是全局 UI。

- 修改受管 provider：`LLM_SHARED_CONNECTION_READ_ONLY`。
- 删除整个本地 `llm-pi-ai` 用户层：只重置本地覆盖；不删除注入在 base 的共享连接。
- 使用手工文件编辑伪造受管 provider：显示 `LLM_MANAGED_ROUTE_CONFLICT`，对应共享路径不得转而采用本地值。
- 健康的其他 Space 不受影响；不能通过返回空 namespace 掩盖错误。
- `describe` 的共享来源展示由 bridge 的额外脱敏接口提供，不篡改官方 descriptor 的秘密/权限契约。

对于运行中外部坏配置，上游有其既有的拒绝/保留行为。本功能不能把它包装成恢复，也不能把坏配置宣称已生效。涉及保留前缀劫持时，需要在对应请求边界拒绝新的受管调用，不能只在 UI 放警告。由 bridge 维护受管配置有效性状态，并使用固定版本已经验证的官方请求/流调用扩展点安装拒绝守卫；它只能拒绝，不改模型、不改消息、不代替请求重试。非受管本地请求保持原行为。

### 5.3 Credentials：只解析共享引用，不共享整个凭据环境

新增 `SpacesCredentialsProvider`，实现官方 credential service 的相同接口：

- 受管 `SPACES_LLM_*` 引用：检查当前 Space 已加载的共享快照映射，通过全局 store 的明确 record 读取。
- 非受管引用、普通 OAuth record：委托该 Space 原有官方本地 provider，保持已有来源优先级。
- 受管引用的 `describe`：返回是否配置、来源 `spaces-global`、`writable:false`。
- 子 Space 的 `set/unset` 或 record 写操作不能修改全局记录。
- 普通全局 record 枚举不泄漏不相关的记录；用户侧接口只返回被授权使用的元信息。
- 不能对受管引用执行全局环境变量兜底。缺失引用明确失败，防止同名环境变量抢占。

全局 store 使用独立文件路径的官方 credential provider；需要实例化多个底层 provider 时，放到独立 Cordis 作用域，外层只有一个对消费者可见的 credentials 服务。不启动第二个完整 Harness 来管理密钥。

官方 credential service 区分 reference 与 `<scope>/<id>` record，提供 `readRecord/modifyRecord` 等操作；record 不走普通环境变量优先级，适合绑定确定的共享凭据版本。[S8]

### 5.4 默认模型唯一存储规则

```text
已有会话明确模型
    > 该 Space 的 agent-default-model 本地 user 设置
    > 该 Space 引用且可用的全局默认
    > 原 composition 默认（只在全局默认未设置且本地未设置时）
```

显式配置的目标失效时必须报错，不得把上述优先级当“失败后换模型”规则。

全局默认不在当前 Space 绑定范围内：返回明确诊断，要求选择 Space 默认；不私自改绑定范围或选择其他模型。缺适配器同理。

“继承全局”通过移除本地显式默认实现；不要在 policy 文件再存一份默认。对 provider/model 作为一个选择整体修改，拒绝只改半个目标造成意外混配。已有会话不批量重写历史，也不自动切换。

## 6. 生效、版本与请求一致性

### 6.1 首版：启动快照

每个接入 Space 启动时读取 catalog 和本地 policy，完成 schema/引用/凭据存在性/适配器能力校验，然后冻结一份配置快照。启动报告包含：catalog revision、policy revision、每条 connection revision、适配器实际版本、错误/警告。不得把完整配置或凭据放进报告。

运行中保存全局配置只变更目标状态；UI 显示 `pending-restart`。停止的 Space 下次启动直接读取最新版本。首版不自动重启、不热切换、不调用故障恢复路径。

用户选择“应用到所选 Space”时，其语义是正常的显式重启计划：只接受当前没有活动请求且可安全停止的 Space，活跃状态未知时拒绝，不擅自中断。再次启动前仍执行通常的隔离和版本检查。

批量执行遵守仓库现行政策：A 成功保留；B 失败则整批停止；C 标记未执行。不继续、不重试、不撤销 A。[S9]

### 6.2 密钥轮换

Key 更新生成新的 credential record，catalog 原子提交到新 record 的引用。旧快照继续持有旧 record 引用，不允许旧端点与新 Key 混用。

旧凭据不自动清理。删除旧凭据是独立的明确管理操作，必须能证明没有运行实例使用；存在未知/未登记读取者时拒绝清理或明确不能完成核验，不宣称已撤销。保留旧 record 仅为活动请求一致性，不提供选择旧版本运行的产品入口。

停止/禁用某连接在首版是配置变更，不是即时供应商凭据撤销。页面必须显示仍使用旧快照的实例。需要阻止它继续请求时，由用户显式停止对应 Space；不能把 pending 状态称为已经阻断。

### 6.3 管理器退出

全局管理页关闭、管理 profile 退出，不应使已运行 Space 的正常 LLM 请求被迫经一个不存在的代理。已运行实例使用既有快照和受管本地凭据 store。Supervisor 不可用时管理写入失败，不偷偷产生第二个写控制者。

## 7. 全局写入、凭据与并发

### 7.1 单写者

全局 catalog、policy 管理和凭据写操作，都检查当前 Home 控制权。复用现有锁协议，不单独启动第二套全局租约系统。只读控制端不能靠直接调用新路由绕过检查。

写操作在 Home 写权之下串行执行，在临近提交时重新校验 epoch/ownership 与目标 revision。使用持久化 revision 加 `expectedRevision` 做 CAS，不依赖浏览器本地 revision 或仅进程内计数器。

引用检查与 catalog/Space policy 修改必须经过同一个受控串行边界，避免“刚检查没有引用，另一个请求马上绑定后又删除”的竞态。

### 7.2 含 Key 的新增/修改流程

```text
校验权限、版本、连接 schema、引用关系
    → 有新 Key 时写全新 immutable credential record
    → 校验已写 record 可读且只包含本次记录
    → 原子提交 catalog（唯一发布点）
    → 返回 catalog revision 和脱敏结果
```

存 Key 失败不发布连接；catalog 提交失败不改变原 catalog，可能留一个未引用 record，必须如实记录。只允许清理本次能证明归属、尚未发布的临时资源，不添加跨重启修补器。

提交成功但响应丢失：返回结果可能未知。允许用不含 Key 的 operation ID 查询是否已经提交，不自动重发写请求。operation ID 的幂等记录不得包含秘密、秘密 hash 或可供离线比对的秘密派生值。不能因为命令 JSON 相同而认为 Key 相同。

### 7.3 不能复用原任务存储承载 Key

基线 `WorkbenchJobStore` 的 `StoredJob` 存在 `command` 和 `commandCanonical`，因此含 Key 的请求不得直接成为 `WorkbenchCommand`。[S3]

凭据走独立、认证的只写请求；请求体只在处理生命周期内存在，不写到 job、request log、错误对象、浏览器存储、URL、命令行或子进程环境。后台任务只接受已存在的 opaque credential record ID。安装/重启等不含 Key 的操作继续使用原任务系统。

### 7.4 存储权限

使用官方 credential 文件格式和原子写工具，不自创加密协议。POSIX 验证 owner-only 文件/目录权限；Windows 验证 ACL，不能只调用 chmod 后就宣称完成隔离。不得把“按用户文件权限保护”写成“恶意插件看不到密钥”。

## 8. 管理 API 契约

下列均为拟新增业务 API，命名可在施工中按仓库类型风格调整，但权限、输入和响应语义不能省略。

| 方法 | 输入概要 | 输出概要 | 要点 |
|---|---|---|---|
| `llm.describe` | 无或分页参数 | 脱敏 catalog、能力矩阵、revision | 无秘密；不能返回完整 credential records |
| `llm.previewChange` | 非秘密连接草稿、expectedRevision | 校验结果、受影响 Space、待重启信息 | 不写入、不联网探测 |
| `llm.saveConnection` | 非秘密草稿、expectedRevision、可选 credentialRecordId | 已提交 connection/catalog revision | 不接受 Key 字段 |
| `llm.saveConnectionWithCredential` | 草稿、新 Key、expectedRevision、operationId | 同上脱敏结果 | 独立只写传输，不经持久化任务队列 |
| `llm.setDefault` | modelRef 或 null、expectedRevision | catalog revision | 引用必须有效 |
| `llm.previewDelete` | connectionId | 本地默认/绑定/运行实例引用 | 历史会话单独标注，不能误删历史 |
| `llm.deleteConnection` | connectionId、expectedRevision | 脱敏删除结果/冲突 | 不强制解除所有绑定 |
| `llm.discoverModels` | 已保存连接 ID 或短期草稿 | 有界候选目录 | 用户显式发起；结果不保存 |
| `llm.testConnection` | 连接 ID、模型 ID、明确授权 | 本次测试结果 | 显示可能产生费用，不带聊天上下文 |
| `llm.spacePolicy` | Space ID | policy、来源、当前/目标版本 | 路径由 Host 解析 |
| `llm.updateSpacePolicy` | Space ID、policy、expectedRevision | policy revision | 验证引用；不改其他 Space |
| `llm.applyPlan` | 明确的 Space ID 集合及观测版本 | 正常批量重启计划/job | 活跃或未知状态拒绝；失败停止整批 |
| `llm.operationStatus` | operationId | committed / not-found / unknown | 不重放写入 |

已有 `WorkbenchManagerHost` / supervisor HTTP / 桌面适配层负责接线；新增 service 不扩大为任意文件写入或任意 URL 请求服务。

### 8.1 错误码最小集合

`LLM_REVISION_CONFLICT`、`LLM_WRITE_OWNER_REQUIRED`、`LLM_CONFIG_INVALID`、`LLM_UNSUPPORTED_RUNTIME`、`LLM_UNSUPPORTED_PROTOCOL`、`LLM_ADAPTER_MISSING`、`LLM_MODEL_NOT_FOUND`、`LLM_CONNECTION_IN_USE`、`LLM_SHARED_CONNECTION_READ_ONLY`、`LLM_MANAGED_ROUTE_CONFLICT`、`LLM_CREDENTIAL_MISSING`、`LLM_CREDENTIAL_WRITE_FAILED`、`LLM_DISCOVERY_FAILED`、`LLM_SPACE_BUSY`、`LLM_APPLY_FAILED`、`LLM_RESULT_UNKNOWN`。

错误包含 stage、相关 Space/connection ID、已知原因或“未知”，不含秘密和模型对话。错误卡只展示详情与脱敏日志；正常配置/启停入口不变成修复向导。

## 9. 界面施工

### 9.1 全局模型中心

入口：工作台设置 → 模型与连接。桌面对应同名入口。

连接列表展示：显示名、协议、脱敏端点、模型数量、认证状态、被多少 Space 使用、已保存 revision、哪些 Space 待重启。认证状态不能仅因为存在一个 ref 就显示为已配置。

新建连接按四步组织：选择经过验证的协议；输入地址与认证；手工填写或显式获取模型；选择是否设为全局默认并保存。缺少 Key 可以保存草稿但不得发布为可用连接；草稿不装入正式 catalog，取消时不生成运行路由。

“获取模型”和“测试请求”分开：前者成功只代表目录查询成功，后者才是本次生成测试，不承诺之后始终可用。

共享连接编辑前展示影响范围。停用/删除先展示绑定、Space 默认、运行快照引用；需要解除引用时返回正常设置修改，不提供“强制删除并自动改成另一个模型”。

### 9.2 Space 设置

展示“共享连接：全部 / 指定 / 不使用”；“默认模型：继承全局 / 选择模型”；本地与共享模型分组；已生效与待重启状态分离。

共享连接只读，提供“在全局模型中心管理”；本地连接维持官方编辑能力。全局连接失败不自动回退到同名本地连接。

不能只用 CSS 隐藏官方按钮。Host settings/credentials 层必须拒绝越界写入。可以复用官方可公开导出的 UI 组件和扩展槽，但不依赖内部 React 文件路径，不修改官方 DOM 结构来抢控件。

### 9.3 上线时的说明文案

- “连接配置由 Spaces 共享，当前空间的其他设置不会与 web 同步。”
- “已保存。2 个运行中空间仍使用旧配置，重启后生效。”
- “这是全局共享连接。当前空间可以选择模型，连接信息需在全局设置修改。”
- “当前空间未加载所需适配器。连接已配置，但在此空间不可用。”
- “模型目录查询成功，不代表已完成生成请求测试。”

## 10. 导入、接管、分享与删除

### 10.1 初次启用

已有 web 不自动接入；已有 Space 在下次启动时按默认 `mode=all` 接入（见第 2 节 2026-11 修订）。用户在全局中心创建第一条连接后，接入的 Space 重启即可见。每个目标的变更预览包含：要安装/启用的 bridge、settings provider 接入、credential provider 接入、是否已有独立配置路径、是否缺官方适配器，以及会影响的默认模型。

新建 Space 的默认模板可以包含 bridge 和已声明的官方适配器，必须作为正常创建计划呈现。旧 Space 缺 bridge 时在下次启动由启动器补装。

### 10.2 本地连接提升为共享

读取原 Host 的脱敏配置，选定一个供应商路由，生成新 connection ID 并保留原本地路由。凭据只有在用户明确授权、来源可读取且支持复制时才由 Host 直接写入全局 store；环境/授权记录不自动复制，必要时重新输入。OAuth 不在首版接管范围。

先发布新的共享连接，再显式修改所选 Space 的引用或默认。原连接是否删除是单独操作。这个流程是用户要求的“发布共享资源”，不是持续双向同步，也不是整个 settings 迁移。

### 10.3 分享 Space

分享包排除全局 Key、本地 Key、credential record、绝对路径、启动 token 和完整全局 catalog。全局 connection ID 仅在本 Home 有意义，不作为接收端可直接使用的引用。可以附无秘密的连接需求清单，导入后由接收端映射到自己的连接；未映射时明确不可用。

### 10.4 删除连接与历史

绑定、当前默认或活跃快照仍引用时拒绝删除；`mode=all` 的消费者也计入引用影响。提供先从正常设置中排除/解绑，再删除的明确操作顺序。

历史会话不自动重写。删除后保留最小不可复用 ID 墓碑，不保留秘密。继续历史会话时若原 route 不存在，应明确失败或要求用户做新的模型选择，不能把显示名相同的新连接当旧连接。

## 11. 具体代码落点

表中的新增文件均为拟新增，现有接线文件须在 P0 按真实调用链确认。

| 位置 | 动作 | 职责 |
|---|---|---|
| `src/core/domain/llm-connections.ts` | 新增 | ID、revision、schema、引用与冲突规则 |
| `src/core/domain/llm-resolution.ts` | 新增 | 绑定选择、默认模型与 route/ref 编译纯函数 |
| `src/core/ports/llm-store.ts` | 新增 | catalog/policy/credential store 端口 |
| `src/core/application/global-llm-service.ts` | 新增 | 修改预览、CAS、引用检查、原子发布协调 |
| `src/adapters/node/llm-catalog-store.ts` | 新增 | JSON 持久化、路径约束、原子提交 |
| `src/adapters/node/llm-credential-store.ts` | 新增 | 复用官方 credential backend，隔离 secret 请求 |
| `src/adapters/node/llm-policy-store.ts` | 新增 | 每 Space policy 的独立存储 |
| `src/adapters/node/workbench-supervisor.ts` | 修改接线 | 服务生命周期、Home 写权、启动上下文 |
| `src/adapters/node/workbench-http.ts` | 修改接线 | 业务 API、认证、独立凭据端点 |
| `src/adapters/node/workbench-jobs.ts` | 最小修改 | 仅支持无秘密的应用计划，防止 command 意外带 Key |
| `src/main/process-manager.ts` 与实际启动入口 | 修改接线 | 启动时选择空间配置路径、加载 snapshot、上报 revision |
| `packages/llm-bridge/` | 新增包 | settings base 投影、credential 分流、请求拒绝守卫、来源状态接口 |
| `packages/view-bridge/` | 不扩张职责 | 继续只处理视图桥接 |
| `packages/plugin/src/host/workbench-manager.ts` | 修改 | 脱敏远程业务方法，不持久化秘密 payload |
| `packages/plugin/src/host/workbench-schemas.ts` | 修改 | DTO 与错误契约 |
| `packages/plugin/src/typert.*` | 按生成流程更新 | Host/Client 契约，不手写失配代码 |
| `packages/plugin/src/workbench/llm/` | 新增 | 列表、编辑器、目录选择、影响预览、Space 绑定 |
| `packages/plugin/src/workbench/components.tsx` | 最小接线 | 页面路由入口，避免继续堆大文件 |
| `src/renderer/`、`src/preload/`、桌面适配层 | 修改 | 复用同一应用服务和 DTO，补 IPC allowlist |
| `scripts/build-spaces.mjs` 与 pack/install 校验脚本 | 修改 | 新包打包、安装、版本和写入范围验证 |
| `src/main/space-share.ts` / 相关导出路径 | 修改 | 排除秘密与本机绑定，输出可映射需求 |
| `docs/workbench.md`、`README.md`、任务账本 | 修改 | 明确全局/Space/web 区别与冷应用语义 |

不增加 Electron 专用的另一套连接规则。不在 UI 中解析 YAML。不把模型逻辑挂到历史 restore/doctor/snapshot 模块。`packages/core` 的导出须同步更新，但不顺手重构全部仓库目录。

## 12. 分阶段施工与完成标准

每阶段都要提交代码、测试和对应证据；“文件存在”“类型通过”“能打开页面”不能替代运行验收。

### P0：核对路径与证明官方接入

任务：记录真实启动链，固定 CLI 与插件版本，验证独立 settings 路径、扩展 provider 的导出、共存路由、默认模型注入、受管凭据解析、keyless 是否支持、local API 写保护。

最小场景：隔离 Home 中启动 web、Space A、Space B；设置不同主题/本地默认；只增加一条共享 mock 连接；A/B 引用同一连接但默认模型不同；web 未接入。

输出：`docs/compat/global-llm-matrix.md`、配置来源表、固定版本契约测试、最小端到端原型。新能力以 `0.1.5-rc.2` 为必测首发目标；`rc.1` 未通过本功能矩阵时，仅拒绝启用共享 LLM，不能顺便破坏原有未接入 Space 的运行能力，也不能声称本功能兼容 `rc.1`。若当前代码尚未实现独立 settings 路径，先做最小路径隔离补齐，不能把共享 settings 当解决方案。

完成标准：A 修改非 LLM 设置不影响 B/web；一个共享路由在 A/B 可调用；原本地路由不变；直接编辑受管路由被拒绝；Key 不进入子 Space 文件；实际发布包而非 master 原型通过。未通过时禁止进入“UI 已完成”的阶段。

### P1：领域模型、存储与引用规则

新增 catalog、policy、纯解析函数、稳定 route/ref 编译、schema、CAS、路径权限和原子发布。测试重名、同 model ID、未知 schema、并发 revision、删除引用、`mode=all` 动态影响、显式坏默认不兜底。

完成标准：全局连接及 Space policy 单独持久化；没有第二份 provider 原件；失败提交不损坏旧 catalog；持有旧 revision 的写请求被拒绝。

### P2：官方接入与凭据闭环

实现并打包 `llm-bridge`；只替换接入 Space 的服务 provider 接线，不替换官方模型适配器。接入本地 settings 的 base 注入、受管写保护、凭据分流、默认模型规则与快照固定。

完成标准：真实 A/B mock 流式调用走官方 adapter；本地/全局同名模型不会误路由；全局缺凭据不走环境兜底；Shared Key 不被官方 UI 读出/修改；任何单 Space 失败不拖垮其他 Space。

### P3：管理 API、安全与应用计划

接入 Supervisor/HomeController、写权校验、脱敏 DTO、secret 独立端点、operation 状态查询、revision 冲突与无秘密重启计划。复用现有认证，不给子 iframe 发全局控制 bearer。

完成标准：只读端直接请求写入仍被拒绝；Key 不进入 StoredJob；提交后响应丢失不重发；批量失败停止；busy Space 不被强制结束；管理 UI 退出不影响现有直连请求。

### P4：双端 UI

实现全局连接列表/编辑/发现/测试、引用预览、Space 绑定、默认选择、共享来源与 pending 状态。复用当前 UI 与国际化体系，不更换框架。

完成标准：无需进入任何 Space 就能建连接；新建两个 Space 不再重复填 Key；A 设默认不影响 B；官方本地管理仍可用；全局/本地控制来源明确；无前端隐藏代替后端权限。

### P5：显式接管、分享与包装

实现单连接提升、凭据授权复制边界、分享包去秘密/去本机引用、删除阻塞、旧 Space 不自动接入、web 显式接入。打包新 bridge，并接入标准插件安装与桌面分发校验。

完成标准：旧连接原样保留；导出包秘密扫描为零；在新 Home 导入后要求映射而不是误用原 ID；缺适配器不静默安装；卸载/退出共享接入不删用户全局资源。

### P6：回归、发布门禁与文档收尾

执行 unit、双进程/三进程、browser、打包安装和故障注入矩阵。更新示例、schema 文档、作用域说明、版本矩阵和任务账本。清理仅本功能引入的临时双写、临时 fallback 和试验分支。

完成标准：第 13 节强制项全绿；所有残留限制在发布说明中明示；未跑平台不写成已支持验证；不为该功能顺手升级 DSH 或恢复历史恢复能力。

### 12.1 依赖与并行

```text
P0 → P1 → P2 → P3 → P4 → P5 → P6
```

P0 完成后，UI 可按冻结 DTO 使用 mock 并行，但真实联调依赖 P3。测试负责人可同时准备网络 mock、三空间与泄密扫描。`workbench-supervisor.ts`、共享 DTO 和 build 脚本指定一个集成负责人，避免多条施工线冲突。

### 12.2 建议 PR 切分

1. `test: pin global llm compatibility and config scopes`
2. `feat: add shared llm catalog and space policies`
3. `feat: bridge shared llm settings and credentials`
4. `feat: expose secure global llm management APIs`
5. `feat: add global model center and space selection`
6. `feat: add explicit connection adoption and safe export`
7. `test: enforce global llm release gates`

首个 PR 是“真实接入原型和隔离证据”，不是一个空模型中心页面。

## 13. 强制验收矩阵

| ID | 场景 | 必须结果 |
|---|---|---|
| A01 | web 未接入，A/B 接入 | web 的 settings/凭据/模型选择不被自动改写 |
| A02 | A 改主题、插件参数、工作数据 | B 与 web 不变 |
| A03 | 一次创建连接，新建 A/B | 不再重复索要同一个 Key |
| A04 | A/B 选不同默认模型 | 两者互不覆盖 |
| A05 | 修改全局默认 | 未重启实例 pending；重启后仅新会话默认变化 |
| A06 | 已有会话运行中改全局端点和 Key | 当前请求不混用新旧配置，不自动切换模型 |
| A07 | 本地与全局有相同显示名/model ID | 按来源和稳定 ID 区分，不猜测映射 |
| A08 | 缺 pi-ai 或协议不支持 | 明确不可用，不自动装包或换实现 |
| A09 | 共享 ref 缺失，同时存在同名环境变量 | 不环境兜底，明确缺凭据 |
| A10 | 官方 UI / API 编辑共享 route | Host 拒绝，catalog 不变 |
| A11 | 手工本地配置劫持保留前缀 | 明确冲突，不发送到伪造端点 |
| A12 | 全局 catalog 双标签并发编辑 | 一个成功，旧 revision 冲突，不丢写 |
| A13 | 只读桌面端直接调用新 API | 拒绝写入 |
| A14 | 凭据写成功但 catalog 提交失败 | 原 catalog 不变；未引用秘密有真实记录，不恢复/重放 |
| A15 | catalog 已提交但响应丢失 | 可查 operation 状态，不自动重新提交 |
| A16 | 轮换 Key 后部分实例没重启 | 明确旧 revision；旧端点不会读取新 Key |
| A17 | 删除被绑定/default/运行实例引用的连接 | 拒绝并准确列出引用，`all` 模式不能漏 |
| A18 | 删后同名创建新连接 | 新 ID；旧会话不自动改指向 |
| A19 | 关闭管理页面或管理 profile | 已运行 Space 正常直连；无新控制进程自动出现 |
| A20 | 批量应用 A 成功、B 失败、C 等待 | A 保留，B 失败，C 未执行；整批停止 |
| A21 | 活跃会话或状态未知时应用 | 不强制停止、不自动排队续跑 |
| A22 | 导出与跨 Home 导入 | 无秘密、绝对路径和本机有效凭据引用；显式映射 |
| A23 | 日志/job/IPC/浏览器存储扫描 | 无真实 Key、认证 header、credential payload |
| A24 | 目录查询返回超大响应/循环分页/重定向 | 有界终止，不向其他 origin 转发凭据 |
| A25 | Keyless 本地连接 | 仅在固定版本能力测试通过时展示，不放假 Key |
| A26 | 非 LLM namespace round-trip | 值、未知插件 section、未触及 YAML 注释不丢失 |
| A27 | 旧 bridge/schema 或未来版本 | 明确不兼容，不当空配置起进程 |
| A28 | 插件包/桌面安装包实际安装 | 新包可解析，单实例服务与版本门禁通过 |
| A29 | 全局 Key POSIX/Windows 权限 | 按平台验证，不能只证明 chmod 调用了 |
| A30 | 任意错误路径 | 没有自动重试、回滚、重装、换模型、恢复向导 |

A01-A24、A26-A30 是首版完成门槛。A25 是 `none` 认证开放门槛，未通过时产品能力矩阵标记不支持，不阻断已验证 API Key 接入，但不能把 keyless 列为已交付。

### 13.1 测试文件建议

`tests/llm-domain.test.ts`、`tests/llm-store.test.ts`、`tests/llm-default-resolution.test.ts`、`tests/llm-settings-bridge.test.ts`、`tests/llm-credentials.test.ts`、`tests/llm-api-auth.test.ts`、`tests/llm-concurrency.test.ts`、`tests/llm-secret-leaks.test.ts`、`tests/llm-multi-space.test.ts`、`tests/llm-ui-dom.test.ts`、`tests/llm-packaging.test.ts`。

网络测试使用本地 mock server，精确断言请求 protocol、路径、model ID、授权 header、流式终止和调用次数；默认不使用真实付费 Key，也不发送用户聊天。

### 13.2 验证命令

基线现有命令：[S1]

```sh
npm run typecheck
npm run typecheck:spaces
npm test
npm run test:spaces
npm run test:workbench
npm run test:workbench:browser
npm run build:spaces
npm run validate:isolation
npm run validate:plugin-write-scope
npm run pack:plugin
npm run validate:plugin-install
```

拟新增命令，必须先添加 script 实现，不能把下列名字当作当前已存在：

```sh
npm run test:llm
npm run test:llm:integration
npm run test:llm:browser
npm run validate:llm:secrets
npm run validate:llm:distribution
```

所有涉及 Home 的验证都使用一次性临时目录或 `.sandbox`。禁止用生产 `~/.dsh`、用户真实聊天或真实 Key 做自动测试。

## 14. 模型发现与网络安全细则

模型发现通过官方 adapter 的公开能力调用；对未支持协议返回明确错误，不自己猜路径。已保存连接的凭据在 Host 内解析，浏览器不先读取 Key 再带回来。

首版建议总请求期限 15 秒、响应 2 MiB、候选模型上限 1000，测试覆盖超限结果；具体阈值集中常量定义。超限必须标示截断或失败，不把部分结果称为全部模型。无后台重试。

允许显式配置 localhost/局域网端点以支持本地模型，但普通子 iframe 无权发任意 discovery 请求。端点变更预览标明目标 origin；禁止 URL userinfo 与秘密查询串。模型发现默认不跟随跨 origin redirect；生成适配器的 redirect 行为也必须在兼容矩阵中验证，不能只保护 discovery。

连通性测试的最小提示、输出 token 上限、预算提示与用户确认固定；不拿聊天记录当测试数据。不定期发送“健康探测”来消耗 Key。

## 15. 发布和后续边界

首版按固定 schema 与新包版本发布，新增/既有 Space 的接入行为分开说明。旧版本看到不认识的共享 schema 应拒绝该能力，不自动清空配置。安装升级是普通操作，失败后保留现场，不构建回滚链。

全局资源退出使用时，停用各 Space 引用即可；默认不删除全局 catalog、凭据或用户本地连接。卸载桥接包时必须通过正常插件管理移除接入配置，不把模块找不到包装成自动卸载修复。

第二阶段才考虑热更新：复用同一权威 catalog、connection revision、凭据版本与生效状态，按每 Space ACK 发布；必须证明在途请求快照稳定、失败不回滚、缺失 ACK 不报全局成功。不得为热更新新建第二份 registry 或消息中转平台。

## 16. 交付定义

可交付不是“多了一个设置页面”，而是同时满足：

- 连接只配置一次，多 Space 可复用。
- web 与子 Space 的非共享配置保持独立。
- 全局与本地连接有稳定身份、来源、写权限和清楚的默认解析。
- 秘密不进入本地副本、任务记录、导出与浏览器读接口。
- 保存、待应用、已生效和失败是不同状态。
- 双端、打包安装、实际官方版本和故障矩阵都有证据。
- 没有新增双向配置同步、LLM 请求代理或恢复系统。

## 附录 A：给施工代理的执行约束

先读本计划和现行 `docs/let-it-crash.md`，再执行 P0。不得根据 README 的共享措辞推翻用户明确要求的 Space 配置独立。不得把本计划的拟新增类名当作现有 SDK 导出。每个 PR 必须写明：修改文件、验证命令、实际版本、通过/失败证据、未完成项。

禁止以全局共享完整 settings、复制 Key、复制完整 provider 到每个 Space、fork 官方 adapter、加 fallback、直接注入 iframe DOM 等方式让演示暂时变绿。

首个真实联调要使用两个独立 Space 和一个未接入的 web，不接受单进程内三个对象代替多进程验收。不要提交用户秘密或生成的临时 Home。

## 附录 B：核对依据

所有标记均表示核对源码或文档，不表示本次执行了运行测试。

- [S1] `klarkxy/dsh-spaces@861cf4e9a2025da15fbc3bf0e3560f9817499a82/package.json`：当前构建/测试命令和固定 DSH 客户端依赖。
- [S2] 同提交 `src/main/process-manager.ts`，本次读取 1-245、405-575 行：启动参数与公共 DSH_HOME 传递；不由此单独推定 settings 最终位置。
- [S3] 同提交 `src/adapters/node/workbench-jobs.ts`，1-200 行：`StoredJob.command`、`commandCanonical` 及任务存储。
- [S4] `deepseek-ai/deepseek-harness` 当前默认分支 `packages/settings/settings/src/index.ts`，blob `232364b4e877cac1363414df835c37b425a5bfdf`：namespace、base/user、SettingsProvider 服务接口。
- [S5] 同上游 `packages/settings/settings-file/src/index.ts`，blob `6a281479a192db758f3e068ade81ab1a007f3be2`：FileSettingsProvider、load/persist、文件锁和原子写。
- [S6] 同上游 `packages/credentials/credentials-local/README.md`，blob `94d06bc48ec92630bfdd885353592a34f80dc249`：独立 path、环境优先级、record 与同用户秘密边界。
- [S7] 项目基线 `packages/view-bridge/package.json`：轻量视图 bridge 定位与依赖。
- [S8] 上游 `packages/credentials/credentials/src/index.ts`，blob `f63ee08cd141587e0604486b422136a150c8244c`：reference/record 语法与解析接口。
- [S9] 项目基线 `docs/let-it-crash.md`：禁止自动/手动恢复、批量失败停止、单写者、原子写与错误脱敏。
- [S10] 上游 `packages/llm/llm-pi-ai/README.md`：多协议路由、settings 接入和按操作解析。仅作设计参考；发布包支持以 P0 固定版本测试为准。
