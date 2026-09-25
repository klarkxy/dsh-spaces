# 看板接口合同 v1

状态：待实现。本文的 HTTP 路径、包名和服务均为新增设计，不是现有可调用 API。字段全集见 [contracts.ts](contracts.ts)，样例见 [examples.ts](examples.ts)。

## 1. 通用规则

协议标识 `dsh-dashboard`，HTTP 前缀中的 v1 与响应 `protocolVersion: 1` 对应。请求和响应为 UTF-8 `application/json`，响应禁止浏览器/代理持久缓存（`Cache-Control: no-store`）。未知操作、未知字段、重复 JSON 键、无效 UTF-8、非有限数值、版本不匹配均拒绝；不能把多余字段当插件扩展执行。

所有 ID 最长 128 字符且非空，不得含控制字符；它们是 opaque 数据。标题非空且最长 200 字符、unit 最长 32 字符。revision/epoch 只允许原样比较，不按大小推断新旧。时间为带时区的 RFC 3339 字符串；序列和计数为不超过 Number.MAX_SAFE_INTEGER 的整数。外部输入必须经过运行时校验，TypeScript 类型检查不能代替它。

普通查询/布局请求必须通过当前宿主认证。home 模式端点归属现有 Supervisor；管理 DSH 页通过既有受信任 Host 通道做代理，不向页面发送管理 bearer。local 模式端点只由当前 Host 提供，只访问本 Host；不得将模式字段或用户传来的 spaceId 当成访问其它 Home 的许可。

Cookie 调用要求精确 Origin/Host 校验和 `X-DSH-Dashboard: 1` 自定义头；不允许通配带凭据 CORS。Node 管理调用沿用现有受控身份校验。发布凭据、普通 workspace/view 身份、只读看板身份不能调用管理或布局写入。DSH 原生认证和代理装配必须在 P0 用实际 SDK 验证，不能另开匿名 HTTP 入口。

## 2. 路由总表

| 路由 | 主体 | 输入类型 | 成功响应 | 副作用 |
| --- | --- | --- | --- | --- |
| `POST /api/dashboard/v1/query` | 已认证 reader；publications 另需 manager | DashboardQuery | 200 DashboardQueryResponse | 无业务/配置写入 |
| `POST /api/dashboard/v1/commands` | layout writer | BoardMutation | 200 BoardMutationReceipt | 仅布局和回执 |
| `GET /internal/dashboard/v1/grant` | 当前空间 run publisher | 无 body | 200 PublisherGrant | 只读本 run 授权 |
| `POST /internal/dashboard/v1/publish` | 当前 run publisher | PublishRequest | 200 PublishAck | 本空间、授权 provider 投影 |
| `POST /internal/dashboard/v1/heartbeat` | 当前 run publisher | PublisherHeartbeat | 200 HeartbeatAck | 通道活动记录，不更新业务内容 |

内部端点仅监听已绑定 loopback 服务，只接受 Node 发布 bearer，拒绝 Cookie 和带浏览器 Origin 的调用。认证先于 body 中 providerId/runId 的解释。spaceId 与 Home 身份由 credential binding 决定；PublishRequest 不接收这两个身份字段。

没有直接执行业务按钮的端点，没有任意文件读取、任意 URL fetch、任意命令或跨空间工具调用。任何 `action.execute` 类请求返回 unsupported-operation，而不是透传至 Agent。

## 3. 查询

所有查询都返回 `{protocolVersion, backendEpoch, data}`；`data.kind` 必须对应输入 kind。backendEpoch 在服务实例变化时更新；home 模式绑定当前 Supervisor 实例，local 模式绑定当前 Host 的看板 backend，不暗示本地也存在 Supervisor。

| kind | 语义与约束 |
| --- | --- |
| overview | mode、defaultBoardId、看板摘要、来源摘要、能力和限额。即使无看板也不创建默认数据 |
| catalog | 只列当前获准的实例元数据，不包含 content。支持 spaceIds 过滤和 cursor；空 spaceIds 表示空集合，省略表示所有可见来源 |
| instances | refs 数量 1..50，禁止重复；响应 items 与输入顺序及数量一致。每项独立报告 present/unavailable |
| board | 读取布局；不存在返回 board=null。布局中的失效引用不使整板读取失败 |
| receipt | 按 requestId 只读已保存的调用结果；不存在/已过期返回 null，不代表变更必然未发生 |
| navigation | 仅解析实例自身的逻辑 SourceTarget。来源停止、目标不存在或不可访问时 available=false、target=null |
| publications | 仅 home manager 查询指定空间授权；未设置过的 provider 不出现。local 请求返回 501；home reader 请求返回 403 |

catalog 默认 limit=50，最大 100，spaceIds 最多 100 个且不得重复，cursor 最多 4096 字符；cursor 必须绑定主体、过滤条件、目录 revision 与 backendEpoch。实例的 content 变化不应使目录 cursor 失效。目录结构变化或 cursor 过期返回 cursor-invalid，调用方不能静默重新拉第一页。每次读取重新检查授权；未授权的 ref 按 not-found 隐藏，不泄露标题、插件信息或是否存在。

present 表示“存在可读投影”，不表示任务成功。通过 freshness/sourceState 和 content 中的业务状态区分最近数据、过时数据与业务失败。unsupported 用于已经授权但没有受支持渲染合同的引用，不能自动换用通用 HTML 渲染器。

## 4. 布局写入

`BoardMutation` 是唯一首版看板写入 DTO。客户端在首次发送前生成 requestId 和 issuedAt，所有命令携带 overview 得到的 backendEpoch。具体命令为 board.create、board.replace、board.delete；replace/delete 必须有 expectedRevision。create 的 boardId 由客户端或 defaultBoardId 提供，ID 已存在或已删除则冲突，不覆盖。

摆放使用 12 列网格：x/y/w/h 为整数，x、y >= 0，w、h >= 1，x+w <= 12，y+h <= 10000；同板 placement.id 唯一，矩形不得重叠。允许同一实例多次摆放，但每个摆放有独立 ID。标题与 ref 不得被解释成 HTML、路径或命令。

create 和新增/改指向的 placement 必须引用此刻可读的实例；替换时未改变 ref 的旧失效摆放可以保留，避免一个失效来源让整板不能整理。后台重新验证数量、网格、权限与 CAS，不能信任前端拖拽校验。

成功只在布局及回执共同提交后返回。重复请求的比较、超时后结果查询、回执保留和时效规则见 [数据文档](domain-and-lifecycle.md)。对已记录的相同请求先校验当前读取权限，再返回原回执；未知请求才做 issuedAt 时效校验。服务 epoch 变化后的旧命令不执行；既有回执仍可通过 query 读取，但必须按当前权限脱敏。

回执的 backendEpoch 保存原执行服务实例；receipt query 的外层 backendEpoch 是当前服务实例，两者不能混为自动执行许可。客户端忽略已经关闭的读取会话的迟到响应。

receipt 中的 board 也不是永不过期的授权证据：来源被撤销后，回执查询必须隐藏其敏感内容。本版布局只保存 ref 和用户自填标题，不保存源实例标题或 content。读取旧回执绝不触发执行。

## 5. 发布注册与快照

Supervisor 在一次正常空间启动时创建 runId 和发布凭据；grant 只列该 run 的授权 provider 与 selection。没有 Home 配置时 provider 以 local-only 运行，不向内部端点试探连接。

publish 请求携带 runId/providerId/grantRevision/sequence 和完整 types/instances。类型 version 为正整数；typeId 唯一；实例 ID 唯一；每个实例必须能匹配本请求的 typeId/typeVersion/content.kind。progress 的 max>0、0<=value<=max；metric 为有限数值；list 最多 100 行且行 ID 唯一，label 最长 500 字符；markdown 受单实例内容字节上限限制，禁止原始 HTML。staleAfterSeconds 为 null 或 30..86400 的整数。

selection=selected 要求 1..100 个不重复的 instanceIds，空选择使用 selection=null 撤销。发布时只能包含获准 instanceIds 的子集；all 意味着用户明确允许此 provider 后续新增实例也进入 Home。没有匹配授权的实例使整个请求拒绝，不能静默剔除后宣称全部发布成功。types 只携带本次已选中实例实际引用的声明，避免泄露未选中组件的类型标题。provider 可以正常发布 types=[]、instances=[] 表达移除，但不得用它掩盖读源失败。

确认返回被接受的 run/provider/sequence/receivedAt，不返回其它空间内容。幂等、乱序、新旧 run 覆盖规则见数据文档。heartbeat 的 provider 身份按本 run 启动时绑定的集合校验；撤销项的心跳不恢复授权或 freshness，其他有效 provider 的心跳仍可记录。lastSequence 为非负整数，不能据此制造缺失快照或向前推进已确认 sequence。

正常心跳 15 秒一次；45 秒没有成功心跳或快照时，将通道标为不可用并将依赖其新鲜度的结果标 stale，不据此宣布进程死亡，也不自动重连。已知进程退出使用 Supervisor 的真实状态。run 凭据认证/网络故障终止本 run 的发布通道；单 provider 的数据验证或 grant 失效终止该 provider 的发布，其他健康来源不受牵连。

## 6. 发布授权仍走管理平面

拟给现有 `WorkbenchPlanRequest` 增加 `PublicationPlanInput`，但不改变协议 v2 的写入上下文：

- `preview({kind:'dashboard.publication.set', ...}, {serviceEpoch, expectedRevision})`。
- 用户确认后，`submit({kind:'plan.execute', planId}, requestId, {serviceEpoch, expectedRevision})`。

这是现有类型接口的计划扩展，不表示已实现该 union 成员。预览展示空间、插件、选择范围、现有授权 revision、内容将进入 Home、缓存与备份影响，以及是否需下次正常启动才生效。publications 查询结果中没有该 provider 时，客户端使用固定未创建标识 `absent` 作为 expectedGrantRevision；服务端仅在执行时确实不存在该策略时接受。

撤销用 selection=null，读取阻断立即生效。任何策略变更立即使旧 provider 授权 revision 失效；新增/扩大授权只在下一次用户正常启动/重启空间时签发新凭据并发布当前状态。界面显示 pendingStart，不后台重启，不自动重新取 grant。预览结果保留既有 5 分钟有效期，并在执行时复查空间代次、管理 epoch/revision 和授权 revision。

正常插件安装使用现有 plugin.install 计划；不得从 query 或首页渲染函数调用安装。授权操作不复制 Home 管理权限给空间，也不开放业务执行权限。

## 7. 错误合同

统一 JSON：`{protocolVersion:1,error:{code,message,requestId?,details?}}`。message 必须脱敏；details 仅允许 field/limit/actual，不携带原始 body、文件路径、Cookie、栈中的密钥或聊天内容。

| HTTP | code 后缀（均带 dashboard/ 前缀） | 含义 |
| --- | --- | --- |
| 400 | invalid-input | 字段、JSON、身份格式或跨字段关系非法 |
| 401 | unauthenticated | 未认证或凭据失效；客户端清除敏感内存显示 |
| 403 | forbidden | 主体无权；不能继续展示该权限范围的缓存 |
| 404 | not-found | 不存在或不可见，避免存在性探测 |
| 409 | stale-epoch / stale-run / stale-grant | 服务、发布会话或授权已变化 |
| 409 | stale-sequence / sequence-conflict | 旧序列或同序列不同内容 |
| 409 | revision-conflict / request-conflict | 布局 CAS 或幂等键冲突 |
| 409 | cursor-invalid | 分页上下文失效 |
| 400 | request-expired | 未见过的请求超出允许时间窗 |
| 413 | limit-exceeded | 字节、数量或存储配额超限 |
| 429 | rate-limited | 当前调用超出发布速率；不自动重试 |
| 400 | unsupported-version | 协议或语义版本不能解释 |
| 501 | unsupported-operation | 非首版操作、错误运行模式或未实现能力 |
| 503 | unavailable | backend/维护状态/回执容量使操作不可用 |
| 500 | storage-failed | 真实存储提交失败，不能伪装成成功 |

query 中单个不可见实例返回 unavailable/not-found，不使同批已获准项全部失败；整个会话认证失效必须整体 401/403。网络失败不是 HTTP 成功响应；SDK 必须保留“未收到结果”与“服务端明确拒绝”的区别。

## 8. 版本与兼容

首版对象封闭。新增执行行为、权限或不兼容字段需要升级协议；不能塞进未定义扩展字段。旧客户端遇到新响应字段/版本明确报告不支持；旧 provider 不满足接口时显示该来源不支持，不能自动更新或替换它。管理协议 v2、看板协议 v1、组件类型版本、组件包版本和磁盘 schema 版本是不同维度。

首版读取使用有界 polling 而非 EventSource。HTML 标准的 EventSource 在连接关闭时有自动重连行为；不能直接把它作为当前故障政策下的默认客户端。[WHATWG SSE 规范](https://html.spec.whatwg.org/multipage/server-sent-events.html)。HTTP 状态码遵循 [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) 的通用含义；业务幂等和禁止重试规则由本合同额外限定。
