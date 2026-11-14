# 管理协议合同 v2（现行）

本文件是 Spaces 管理面（Supervisor ↔ 管理 Host ↔ 工作台客户端）的现行公共合同，随实现更新后保留本文件名。修改本合同或共享类型须由主 Agent 协调；执行者不得各自发明协议。故障政策唯一权威为 [let it crash](../docs/let-it-crash.md)；现行产品边界见 [docs/architecture.md](../docs/architecture.md)。

> 历史提示：本文件最初是 2026-09-20 单 Supervisor 合并的实施合同，含桌面壳移交、应用内自我更新与一次性启动器交接等条款。桌面壳与应用内升级已分别移除（见 [tasks/archive/todo-2026-10.md](archive/todo-2026-10.md) 的 2026-10-12 记录），下文不再描述它们。

## 入口与职责

每个 Home 只有一个 Supervisor。它持有 Home 运行权和管理写入，承载工作台页面、子进程监督和任务执行。浏览器与官方 Desktop 宿主通过受认证 Host 转接附着到同一个服务；普通空间只装 view-bridge，不注册管理 Remote，不启动第二个 Supervisor。

管理工作台以 Supervisor 的一次性 bootstrap 入口进入：一次性 token 兑换 HttpOnly、SameSite=Strict 的 operator cookie。浏览器不取得 Node 管理 bearer；宿主侧 bearer 只留在 Node 进程，不经渲染进程下发。

关闭标签或宿主窗口不停止服务。停止全部空间和停止整个服务（`service.shutdown`）是两个独立的用户操作，均走预览与同一任务执行器；宿主退出不暗中调用任何一个。浏览器和宿主打开现存健康服务是附着，不是恢复；失联后不自动重启或重发管理请求。

## 协议、身份与版本条件

协议版本固定为 `2`。状态、视图及管理 endpoint 必须能识别当前服务身份；新客户端遇到旧协议明确拒绝管理操作，不猜测兼容或回到旧写路径。

`serviceEpoch` 由当前 Home 运行权持有者身份派生，使用摘要，不公开用于释放锁的原始 nonce。一次服务运行中保持不变。视图/模型实例使用 `serviceEpoch + spaceId + generation`；视图的 origin、channel、窗口 source 校验继续有效。

`WorkbenchState` 携带 `protocolVersion: 2`、`serviceEpoch`、`revision`、`availability`。`revision` 是确定的管理状态摘要：至少覆盖空间元数据、实例 generation/status 和 Home 管理设置；排除轮询时间、日志和 job 列表，避免读取本身制造冲突。

普通变更使用 `WorkbenchMutationContext = { serviceEpoch, expectedRevision }`。`submit(command, requestId, context)` 和 `preview(request, context)` 接受此条件；输入缺失、多余字段或格式不符明确拒绝。比较在真正的串行执行边界完成，避免两个请求同时通过预检后覆盖彼此。已接受的同 requestId、同命令读取同一 job，不能因为当前 revision 已变化而执行第二次；同 ID 不同命令拒绝。

读取接口返回读取瞬时的投影：状态版本不表示任务列表、日志和所有磁盘读都来自同一一致性快照。管理读取不取 Home 写锁。

服务端预览保存 epoch、目标状态和资源指纹，执行时重新校验。公开 `WorkbenchPlan` 携带 `serviceEpoch` 与 `stateRevision`。旧服务的计划即使未过有效期也不能执行。计划执行在队列轮到它时再次核对服务纪元、实例和计划指纹，不仅在提交时检查。

公开合同不包含 `controller.acquire`、`controller.release`、`recovery.*`、`snapshot.restore`、`config.restore`、`workbench.prepare`、`workbenchPackage`、`workbench.upgrade` 和 `recoveryRequired`。正常服务停止使用 `service.shutdown` 预览。旧调用只在明确的兼容拒绝边界返回 unsupported，不继续出现在命令联合类型或新 UI 中。旧持久记录可作为历史证据读取，未知或损坏记录保留原字节，不重放、重置或修补环境。

endpoint 记录包含协议版本、公开服务 epoch、canonical Home 身份摘要和 Node-only bearer。连接必须把本地 Home、当前 lease、endpoint 和远端 state 对上；存在无法识别的 endpoint 或旧持有者时拒绝冷启动，不把解析失败当成全新 Home。新服务更换 bearer，旧客户端不能沿用旧实例授权。任何身份不明或残留锁只诊断，不清理接管。

## 产品 API 与执行归属

沿用 `WorkbenchApi` 的 `submit` / `preview` / `job` / `state` / `detail` / `view` / `cancel` 等面，不另造任务总线。`product(request)` 是类型化读/预览入口；请求与结果为封闭 union，禁止任意方法名、路径、shell 命令和透传对象。读方法不得悄悄落盘刷新或同步缓存。

产品读取与预览覆盖 Home 设置、插件目录与制品、诊断、普通模板、分享和版本查询等封闭用例；具体成员、参数与结果由共享产品契约单源定义，本文不复制一份容易过期的清单。读取不得悄悄落盘刷新，公开结果不得泄露绝对路径、来源凭据、聊天正文或其他秘密。Spaces 蓝图工作流封存期间，`blueprint.source` / `generate` / `inspect` / `preview` / `apply` 均返回 `workbench/unsupported`，旧 DTO 与历史任务记录仍可识别。

普通 command 同样使用共享契约定义的封闭集合，只携带无秘密参数。所有写入经同一后台队列与管理门禁。批量安装/移除沿用受预览保护的维护用例，第一失败停止，已经成功的结果保留。

导入的归档和配置内容仅在受认证请求与当前服务的有界暂存中存在；通用 job 只保存 importId、空间名等无秘密信息，不序列化上传归档。暂存绑定服务 epoch、摘要与 TTL；重启后旧 importId 无效，不续跑导入。分享/模板的模型需求要求接收方显式映射，不能沿用发送方有效绑定。

产品用例统一由 Supervisor 装配与分发，不在宿主入口复制第二套业务实现。模板和分享复用版本化配方创建流程，兼容现有磁盘与分享格式，分别记录定义、安装、启动和模型映射结果。正常快照创建、查看、删除及安装能力保留。

凭据和秘密值只在请求内存中处理，不进入通用 job、日志或持久化回执。凭据相关操作与其他管理写入共享授权及同一串行互斥；不得因没有通用 job 而绕过正在进行的维护或停止操作。

## 任务与计划

任务状态机：`queued → running → succeeded / failed / cancelled`。进程中断后重开：读取原任务，展示中断失败或结果无法确认，保留最后阶段和证据。不重放，不对账修补。损坏或未知格式的任务文件保留原字节。

危险或停机动作先 `preview` 再 `plan.execute`。服务端计划持久化并存有独立指纹；计划有效期届满、服务纪元变更、状态版本变化或目标指纹不符均在执行时拒绝。同一预览只消费一次。

单条命令的执行边界是 Supervisor 的串行 job 队列；同一 `requestId` 幂等读取同一 job。没有 `recovery-required`、恢复冻结或 `recovery.resume` 产品入口。

## 拓扑

独立 Supervisor 是唯一管理执行器：运行权、进程监督、任务执行、稳定 HTTP。宿主入口不得创建第二套空间注册、进程管理、运行时存储或升级协调。管理页是 `spaces-hub` 的原生工作台；Host 只作受信任转接。工作空间独立 origin；view-bridge 不含管理能力。

管理 profile 停机后若 Supervisor 仍在线，入口显示真实失败。Supervisor 不随管理 profile 停机。宿主退出销毁客户端，不停止服务。

客户端之间没有业务控制权交接。Home 锁由 Supervisor 持有。另一端只读查询。活着或身份不明的锁只诊断，不清锁、不接管。

## 装配边界

通用 Node 适配与领域/应用规则分层，宿主相关适配不得反向拥有通用业务。迁移时保留数据格式和原行为；故障政策冲突单独留证。

Web 与 Desktop 共用同一管理工作台、任务结果和业务客户端。宿主适配只增加平台展示与系统能力，不复制管理业务，也不出现第二份任务结果或控制权接管。

## 组件制品与正常升级

同一构建的不可变清单标明 Supervisor、管理插件（含 `dsh-spaces/space-control` 子入口）、view-bridge、Browser 和安装 worker 的版本、摘要、协议及路径。标准插件安装与 pack 消费该清单，最终制品逐件验证；不建立新的通用注册中心。冷启动总是选择宿主插件自带的组件组；仅当选中指针摘要一致才复用旧选择。

升级 Spaces 的正常路径是：宿主 `dsh plugin --profile web add <新包>` → 管理工作台停止服务 → 重新打开 Spaces；新的 Supervisor 在管理器启动前对齐管理插件。普通空间按需获得随组桥接，但既有桥接不能仅凭存在就视为与当前组件组版本一致。没有应用内自我更新、一次性启动器交接或服务端版本切换；中断的旧式更新遗留证据（`workbench-upgrade.json`、`.dsh-spaces-upgrade/journal.json`）仍阻止写入。

宿主更新、Spaces 组件更新和官方 DSH 运行时升级是不同流程。不增加 watchdog、数据库、复杂并行调度或自动恢复。

## 写入纪律

所有路径由主 Agent 分配单一写者。接口不清或与当前代码冲突时回报具体位置，不能擅自缩小上述产品能力。
