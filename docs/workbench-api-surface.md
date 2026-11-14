# 工作台管理 API 公共语义

> 状态：现行说明。完整协议见 [merge-contract-v2.md](../tasks/merge-contract-v2.md)，架构见 [architecture.md](architecture.md)，故障政策见 [let-it-crash.md](let-it-crash.md)。本文不复制方法清单、类型定义或实现派生关系；现行方法集合以 `src/shared/workbench.ts` 的 `WORKBENCH_API` 为准。

## 单一事实源与变更纪律

管理 API 的方法名、参数顺序、参数与结果类型必须由同一份共享定义派生到 Host 注册、客户端、Supervisor 白名单和分发检查。不能在某一端单独新增、改名或删除方法。

修改共享 API 定义就是修改协议表面，必须同步评估：

- 浏览器与 Host 的调用参数和结果；
- Host 到 Supervisor 的 wire 编码；
- Supervisor 的方法准入与完整分发；
- 协议版本、旧客户端拒绝和兼容边界；
- 秘密字段是否可能进入任务、日志或浏览器持久状态。

方法的业务实现不需要为了“单源化”合并；需要统一的是公共表面，不是业务代码。

## 公共 wire 语义

- 传输为 `POST /api/workbench/<method>`，JSON 请求体；查询也使用 POST。未知方法在白名单处拒绝。
- 成功返回 `{ ok: true, value }`；失败返回 `{ ok: false, error: { code, message } }`。
- 错误不携带建议修复、恢复计划或自动重试字段。
- `submit` / `preview` 携带 `{ serviceEpoch, expectedRevision }`，比较发生在 Supervisor 的串行执行边界。
- 模型配置只通过封闭 command `space.models.sync` 或创建时的 `modelSource` 变更；手动同步在预览中携带主空间模型摘要，执行前重新读取并比较。运行中空间经自身 `settings` / `credentials` Remote 接口写入并保持运行，下一次请求生效；已停止或异常退出空间直接写配置文件。凭据值只进入内存和本机回环请求体，接口返回名称、设置状态和数量。
- 产品读取与预览使用封闭的 `product(request)`，不接受任意方法名、路径或透传对象。
- 新建空间使用配对的 `base` 与精确 `baseVersion`；版本查询按 base 返回，Browser 产品版本不能作为 DSH 框架版本。两者都省略的既有调用保留原默认语义；只传其中一个、未知 base 或冲突的旧 Browser 标记会被拒绝。本次为协议 2 的可选字段及封闭产品查询增量，不改变既有字段含义。
- Spaces 蓝图工作流封存期间，`blueprint.source` / `generate` / `inspect` / `preview` / `apply` 返回 `workbench/unsupported`；保留旧 DTO 仅用于兼容识别和历史记录。
- Guide 属于独立服务与命名空间，不因名称相似而获得管理权限。`beginDesktopLaunch` 与 `desktopLaunchState` 都不带参数，仅身份确认的 Desktop 允许调用；普通 Web 和子空间拒绝。前者加入宿主按当前 Home 持有的一次 Desktop 启动，后者只读该次状态。两者都返回 Desktop 启动快照，不包含 Home 路径、命令或凭据，也不授予管理写入，不替代普通 Web 的显式初始化。
- 已认证的管理通道可以只读调用 `startupStatus`。它观察 Supervisor 的启动状态，不改变 canonical `state` 的协议字段和含义。健康的旧 Supervisor 可以按现有 `state` 连接。尚未就绪且缺少 `startupStatus` 时，才是明确的兼容失败，不是另一次启动。不是所有缺少该接口的旧服务都因此被拒绝。

## 校验与兼容

Host 与 Supervisor 可以在各自边界执行不同严格度的校验，但差异必须是有意的兼容决定，不能靠两份定义偶然漂移。公开错误码和拒绝行为发生变化时，应按协议变更处理。

历史验证只证明对应批次的方法集合和 wire 行为未漂移，不构成当前全量验收。历史批次记录见 [tasks/archive/todo-2026-10.md](../tasks/archive/todo-2026-10.md) 的 Workbench API 单源化条目。
