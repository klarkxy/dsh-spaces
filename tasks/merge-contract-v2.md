# 单 Supervisor 实施合同 v2

本文件由主 Agent 固定跨任务边界，细化 [合并计划](../docs/plans/spaces-merge-convergence.md) B1–B5。修改本合同或共享类型须由主 Agent 协调；执行者不得各自发明协议。现行故障政策仍为 [let it crash](../docs/let-it-crash.md)。

## 入口与职责

桌面保留本地窗口、标题栏、托盘、首次 Node/pnpm/CLI 准备和服务启动/连接。工作台采用一个独立、受沙箱约束的 WebContentsView，顶层加载 Supervisor 的一次性 bootstrap 入口；该远程 view 无 preload、无 Node 集成，启用 contextIsolation。它与浏览器使用同一个 spaces-hub 工作台页面及组件。不得为了 file:// iframe 放宽 Origin、Cookie 或 CSP 校验。

本地 renderer 只显示首次准备、启动状态和桌面壳操作，不再管理空间或模型。服务认证与一次性 bootstrap URL 留在主进程，不经 renderer IPC 返回；共享工作台依靠现有 manager Host 的权限转接。管理页面崩溃只报告，桌面不构建第二后台或自动重载失败组件。

关闭窗口仍隐藏到托盘，无托盘时保留可找回行为。退出桌面销毁客户端而不停止服务。停止全部空间、停止整个服务是不同操作，调用后台预览和同一任务执行器；退出不暗中调用任何一个。浏览器和桌面打开现存健康服务不构成恢复；失联后不自动重启或重发管理请求。

## 协议、身份与版本条件

新协议版本固定为 `2`。状态、视图及管理 endpoint 必须能识别当前服务身份；新客户端遇到旧协议明确拒绝管理操作，不猜测兼容或回到旧桌面写路径。

`serviceEpoch` 由当前 Home 运行权持有者身份生成，使用摘要或独立公开标识，不公开用于释放锁的原始 nonce。一次服务运行中保持不变。视图/模型实例使用 `serviceEpoch + spaceId + generation`；视图的 origin、channel、窗口 source 校验继续有效。

`WorkbenchState` 增加 `protocolVersion: 2`、`serviceEpoch: string`、`revision: string`、`availability: 'ready' | 'limited' | 'unavailable'`。revision 是确定的管理状态摘要：至少覆盖空间元数据、实例 generation/status 和 Home 管理设置；排除轮询时间、日志和 job 列表，避免读取本身制造冲突。LLM catalog/policy 继续使用已有独立 CAS revision。

普通变更使用 `WorkbenchMutationContext = { serviceEpoch: string; expectedRevision: string }`。`submit(command, requestId, context)` 和 `preview(request, context)` 接受此条件；输入缺失或格式不符明确拒绝。比较在真正的串行执行边界完成，避免两个请求同时通过预检后覆盖彼此。已接受的同 requestId、同命令读取同一 job，不能因为当前 revision 已变化而执行第二次；同 ID 不同命令拒绝。

服务端预览保存 epoch、目标状态和资源指纹，执行时重新校验。公开 `WorkbenchPlan` 增加 `serviceEpoch` 与 `stateRevision`。旧服务的计划即使未过 TTL 也不能执行。LLM apply 的 observation 带 serviceEpoch，执行队列轮到它时再次核对实例，不仅在提交时检查。

公开合同移除 `controller.acquire`、`controller.release`、`recovery.resume`、`snapshot.restore`、`config.restore` 和 `recoveryRequired`。正常服务停止使用 `service.shutdown` 预览。旧调用只在明确的兼容拒绝边界返回 unsupported，不能继续出现在新命令联合类型或新 UI 中。旧持久记录可作为历史证据读取，未知或损坏记录保留原字节，不重放、重置或修补环境。

endpoint v2 包含协议版本、公开服务 epoch、canonical Home 身份摘要和 Node-only bearer。连接必须把本地 Home、当前 lease、endpoint 和远端 state 对上；存在无法识别的 endpoint/旧持有者时拒绝冷启动，不把解析失败当成全新 Home。新服务更换 bearer，旧客户端不能沿用旧实例授权。任何身份不明或死锁残留只诊断，不清理接管。

## 产品 API 与执行归属

沿用 `WorkbenchApi.submit/preview/job`，不另造任务总线。补充一个类型化 `product(request)` 读/预览入口，与已有 `llm(request)` 风格一致；请求与结果为封闭 union，禁止任意方法名、路径、shell 命令和透传对象。读方法不得悄悄落盘刷新或同步缓存。

| product 方法 | 输入与返回 |
|---|---|
| `settings` | 返回 Home 管理设置（端口范围、包来源、目录 URL）；旧 locale/theme 可作为首次客户端默认值，后续是客户端偏好 |
| `catalog` | 返回本地目录快照及 source；查询、显式刷新分开 |
| `library` | 返回下载制品的公开元数据；隐藏 tarball/绝对路径及任何来源凭据 |
| `diagnostics` | spaceId → 有界脱敏日志、已知错误与正常备份列表，不含聊天正文或原始凭据 |
| `templates` | 返回已保存模板/配方的公开列表 |
| `share.export` | spaceId、includeConfig → 经无秘密检查的归档 base64、文件名及预览；不写任意用户路径 |
| `share.previewImport` | 有大小上限的归档 base64 → 预览与 opaque importId、到期时间；解析失败明确报告 |

新增普通 command 仅携带无秘密参数：`settings.update`、`catalog.refresh`、`plugin.download`、`plugin.library.remove`、`template.save`、`template.create`、`space.import`。精确参数类型由 `src/shared/workbench-product.ts` 固定并由 shared/workbench 引用。所有写入经同一后台队列与管理门禁。批量安装/移除沿用受预览保护的维护用例，第一失败停止，已经成功的结果保留。

导入的归档和配置内容仅在受认证请求与当前服务的有界暂存中存在；通用 job 只保存 importId、空间名等无秘密信息，不序列化上传归档。暂存绑定服务 epoch、摘要与 TTL；重启后旧 importId 无效，不续跑导入。分享/模板的模型需求要求接收方显式映射，不能沿用发送方有效绑定。

产品服务从 Supervisor 接收现有 registry、运行状态、创建空间、安装插件、LLM 和设置端口，放在独立应用/Node 模块中；Supervisor 只装配与分发。模板和分享用同一个版本化配方创建流程，兼容现有磁盘与分享格式，分别记录定义/安装/启动/模型映射结果。正常快照创建、查看、删除及安装 worker 保留。

凭据请求仍使用 `llmCredential` 专用通道，值只在请求内存中，持久化无秘密回执。它与其他管理写入共享授权及互斥；不得因没有通用 job 而绕过正在进行的维护或停止操作。

## 装配与模块迁移

现有 Supervisor 是唯一管理执行器；桌面入口不得创建 ProfileRegistry、ProcessManager、RuntimeStore、CoordinatedUpgrade 或 DesktopLlmHost。旧前端 API 没有第二套业务实现；需要过渡时只能转发并在最终切换时退出。

通用非 Electron 模块从 `src/main` 移到 `src/adapters/node` 或其明确子目录，领域/应用规则留在 core；同步真实消费者、测试、构建与资源路径。控制残留/工具链检查放到 Node 共用处，不让 Supervisor 导入 desktop。迁移时保留数据格式和原行为，修复范围内故障政策冲突单独留证。

UI 工作围绕现有 WorkbenchApp 扩展完整能力，不更换框架。两端共用设置、插件目录/缓存、模板、分享、模型和日志交互；桌面壳只增加 OS 功能。界面不会出现第二份任务结果或控制权接管。

## 构建与正常升级

运行中的服务必须能够准备新版本，不能只反复读取自身启动时绑定的归档。共享更新区通过现有队列提交 `workbench.prepare`，公开输入仅为可选 `version`（默认 `latest` 或精确版本）；包名固定 `@dsh-spaces/plugin`，不接受任意 URL、路径或包。它复用已有下载和缓存，将完整嵌套组件组验证、暂存并打包到 Home 外，再返回安全的候选版本与摘要。查询 `workbenchPackage` 只读候选，升级预览固定该摘要；执行前重新校验，候选改变或损坏必须在停机前拒绝。准备与确认停机是两个明确动作，不增设候选数据库，不在重启后续跑旧准备任务。

扩展现有不可变 payload 清单；同一构建标明 Supervisor、管理插件、view-bridge、llm-bridge 和安装 worker 的版本、摘要、协议及路径。标准插件与桌面打包均消费该清单，最终制品逐件验证；不建立新的通用注册中心。

升级期间 Home 运行权不能出现释放后无人保护的窗口：旧服务准备制品、封闭写入并停止所属进程后，把已有运行锁以一次性身份校验交给启动器，再交给新服务。预约绑定 Home、旧 epoch、制品摘要和明确的正常停机确认；其他入口看到预约必须拒绝启动。启动器只切换程序版本指针并启动一次，不处理空间/插件/模型业务，不在崩溃后继续执行。

需要新的可控 HomeController 转移方法时，应以保留同一锁目录、原子替换持有者记录和 nonce/PID 绑定实现，不能先删除锁再抢回。旧服务未完成正常停机确认时启动器不切换；切换后启动失败保留结果与锁证据，不能回滚或重启。服务与一次性启动器的锁交接、回执和失败窗口需要独立竞争测试。

桌面壳更新、Spaces 组件更新和官方 DSH 运行时升级仍是不同流程。本次不增加 watchdog、数据库、复杂并行调度或自动恢复。

## 接入顺序

1. 主 Agent 审核新共享 DTO，Grok 实现协议/状态/Host schema/任务校验及对应测试。
2. Grok 产品服务与 Grok 桌面服务连接器可在稳定合同下分别施工；Supervisor 装配由单一后端写者串行接入。
3. Grok 扩展共享工作台 UI，再切换桌面壳；先验功能等价再删除旧路径。
4. 统一构建/升级，抽出安装 worker、清理遗留代码与文档，完成真实双端和包内启动验收。

所有路径由主 Agent 分配单一写者。接口不清或与当前代码冲突时回报具体位置，不能擅自缩小上述产品能力。
