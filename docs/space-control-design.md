# 主空间 Creator 与空间总控契约（space-control）

> 维护态权威规范（2026-11-10）。故障政策以 [let it crash](let-it-crash.md) 为唯一权威；产品角色与通道基线见 [architecture.md](architecture.md)。早期设计演进与界面自动化调研已归档至 `docs/archive/space-control-*-20261109.md`。

## 1. 范围与边界

在身份确认的可信主空间（官方 `web` 或 `desktop` profile）中，宿主插件 `dsh-spaces` 提供两套受权 Agent 能力面：

1. **Creator（创建流）**：主入口 `dsh-spaces` 注册 `spaces_context`、`spaces_create_preview`、`spaces_create_execute`、`spaces_job`，通过 `/internal/creator/v1/*` 预览并执行新空间创建。
2. **空间总控（space-control）**：插件包内子入口 `dsh-spaces/space-control`（配置项 `id: dsh-space-control`）通过宿主 Cordis Service `spacesMainChannel` 与 `/internal/control/v1/*` 查看并操作同一 DSH Home 下已注册的普通空间。

### 非目标与硬性边界

- **主空间限定**：`spaces-hub` 管理空间与普通子空间永远不注册 Creator 或 space-control 工具；`spaces-hub` patch 与 Browser base 显式将该子入口设为 `disabled: true`。
- **受保护目标**：`web`、`desktop`、`spaces-hub` 与未纳入 Spaces 注册表的目录一律拒绝控制面写操作（返回 `control/protected` 或 `control/not-found`）。
- **单写者与不恢复**：所有空间与插件变更均经 Supervisor 串行作业队列与 epoch/revision CAS 执行；任何失败保留现场与证据，不自动重试、不回滚、不代为恢复。
- **凭据不入上下文**：Creator scope、control scope 与子空间认证 cookie 仅保存在宿主或 Supervisor 进程内存中，绝不进入模型上下文、工具返回值、日志或磁盘记录。

## 2. 通道、鉴权与打包形态

```text
可信主空间 Agent（web / desktop）
   ├─ Creator 工具（spaces_context / spaces_create_preview / spaces_create_execute / spaces_job）
   │    └─ MainSpaceCreatorService ──► POST /internal/creator/v1/<op>（creator scope bearer）
   └─ 空间总控工具（spaces_overview / spaces_inspect / spaces_logs / spaces_templates / spaces_import_preview / spaces_plan / spaces_execute / spaces_control_job / spaces_ui_*）
        └─ dsh-spaces/space-control 子入口
             └─ inject: spacesMainChannel ──► MainSpaceControlService ──► POST /internal/control/v1/<op>（control scope bearer）
                                                                                │
                                                                                ▼
                                                                   Supervisor（每 Home 唯一管理写者）
                                                                     ├─ 串行作业与计划（controlPlan / jobs / maintenance）
                                                                     ├─ 运行中子空间 @Remote 代理（ChildSessionClient）
                                                                     └─ 子空间界面自动化（UiAutomationManager + playwright-core）
```

- **双 scope 同源签发**：主空间身份确认后，向 Supervisor 发起一次注册并同时签发 `scopes.creator` 与 `scopes.control`（绑定当前 `serviceEpoch`，仅存 SHA-256 摘要）。
- **原生请求准入**：`/internal/creator/v1/*` 与 `/internal/control/v1/*` 均要求 loopback 原生请求（拒绝携带 `Origin`、`Cookie` 或 `sec-fetch-*` 头，校验精确 `Host`），天然排除浏览器脚本伪造。
- **包内子入口分发**：`dsh-spaces/space-control` 构建产物为 `packages/plugin/lib/space-control.js`，随 `manager-plugin` 不可变组件组载荷清单一同校验与分发，不使用独立 npm 包或 `file:` 依赖。

## 3. 工具契约

### 3.1 预设门（Preset Gate）与审批

- **只读工具**（`spaces_overview`、`spaces_inspect`、`spaces_logs`、`spaces_templates`）：在可信主空间的任意会话中可用，无需审批。
- **Creator 与空间总控变更/作业/界面工具**（`spaces_context`、`spaces_create_preview`、`spaces_create_execute`、`spaces_job`、`spaces_import_preview`、`spaces_plan`、`spaces_execute`、`spaces_control_job`、`spaces_ui_*`）：调用会话的预设必须为 `cordis`（防止在默认免批的 `danger-full-access` 会话中绕过人工确认）。
- **人工审批（`approveEscalation`）**：
  - `spaces_create_execute` 与 `spaces_execute`：每次执行冻结计划前触发一次审批，审批文案必须完整列出操作类型、目标空间、精确插件来源、`approvedBuilds` 构建脚本白名单、受影响空间及忙碌状态警告；`models.sync` 另展示路由、默认模型、Key 名称、跳过项、缺失 Key 与停止/恢复启动语义。
  - `spaces_ui_open`：打开子空间自动化页面前触发一次审批，授权绑定 `(spaceId, generation, serviceEpoch)`；空间停止、重启或调用 `spaces_ui_close` 后授权立即失效。授权期内 `spaces_ui_act` 不逐次弹窗。
  - `spaces_ui_eval`：在子空间页面上下文执行脚本属调试操作，不被 `spaces_ui_open` 授权覆盖，**每次调用均须单独审批**，并在审批文案中展示完整脚本内容与同源数据读取提示。

### 3.2 Creator 工具（`dsh-spaces`）

| 工具 | 审批 | 语义 |
| --- | --- | --- |
| `spaces_context` | 否（需 `cordis`） | 读取当前 `serviceEpoch`、`revision`、可写状态、维护锁与宿主基础 DSH 版本。 |
| `spaces_create_preview` | 否（需 `cordis`） | 冻结新空间创建计划（含精确插件来源与 `modelSource: "main" \| "local"`），返回 `planId`、`fingerprint` 与步骤列表。`modelSource: "main"` 表示在创建步骤 `models-sync` 中从主空间一次性复制模型配置。 |
| `spaces_create_execute` | 一次审批 | 校验 `planId`、`fingerprint` 与一次性请求后提交创建作业，幂等键为 `requestId`。 |
| `spaces_job` | 否（需 `cordis`） | 查询本主空间注册提交的 Creator 创建作业状态。 |

### 3.3 空间总控只读工具（`dsh-spaces/space-control`）

| 工具 | 参数概要 | 语义与边界 |
| --- | --- | --- |
| `spaces_overview` | `{}` | 返回所有注册普通空间的状态、`generation`、锁定 DSH 版本、任务活动（`idle` / `busy` / `unknown`）、进行中的创建作业及最近脱敏失败作业摘要（≤ 32 KiB）。 |
| `spaces_inspect` | `{ spaceId, sections? }` | 按需读取：`plugins`（已安装插件名与版本）、`plugins.live`（运行中子空间的 loader 条目加载顺序与 bundle 列表，未运行报 `control/not-running`）、`model`（模型目录占位说明；各空间在空间内独立管理模型目录）、`runtime`（空间锁定版本与本机已装运行时目录）、`diagnostics`（状态、最近脱敏错误、配置备份列表）、`jobs`（涉及该空间的最近作业）。默认返回 `plugins` + `model`。 |
| `spaces_logs` | `{ spaceId, tail? }` | 读取目标空间的脱敏诊断日志尾部（`tail` ≤ 200 行，响应 ≤ 64 KiB），不暴露宿主机文件路径。 |
| `spaces_templates` | `{}` | 列出本 DSH Home 保存的空间模板（`templateId`、名称、来源空间、锁定版本、是否含配置及精确插件配方）。 |

### 3.4 空间总控计划与执行工具（`dsh-spaces/space-control`）

通过 `spaces_plan` 冻结一次性计划（返回 `controlPlanId`、`fingerprint`、`requestId`、`affectedSpaceIds`、`changes`、`taskActivity`、`expiresAt`；`models.sync` 另返回非密 `modelsSync` 摘要），再经 `spaces_execute { planId, requestId }` 审批并提交串行作业，并通过 `spaces_control_job { jobId }` 读取作业进度与结果。

同一空间存在两条互斥的插件写路径，单次计划只选其一，绝不混用或自动切换：

- **路径 A（Supervisor 停机写）**：适用于已停止空间，或计划内明确包含先停止空间的操作。
  - 生命周期：`start`、`stop`、`restart`、`delete`。
  - 插件与运行时：`plugin.install`（支持 `npm` 精确版本、`github` 40 位 commit SHA 及显式 `approvedBuilds`）、`plugin.remove`、`plugin.toggle`、`runtime.set`。
  - 模型配置同步（`stopped` / `crashed`）：`models.sync` 与工作台共用同一作业，直接写目标配置文件并读回校验。
  - 模板与分享导入：`space.from-template`、`space.import`（配合 `spaces_import_preview` 暂存的 `importId` 创建新空间，创建后保持停止；非精确 npm 插件列入 `pendingManual`，不自动补装）。
- **路径 B（运行中子空间 `@Remote` 写）**：要求目标空间处于 `running` 状态，且执行时 `generation` 与计划一致，经 `ChildRemoteClient` 调用子空间自身的 `pluginManager`、`settings` 或 `credentials`：
  - `plugin.live.install`（`installBundle`）、`plugin.live.update`（`updateBundle`）、`plugin.live.remove`（`removeBundle`）、`plugin.live.entry`（`setPluginEnabled`，仅按 `entryId` 修改该条目 `disabled` 状态，不改变插件顺序）。
  - 模型配置同步（`running`）：`models.sync` 通过目标自身的 `settings` / `credentials` 接口写入并读回，保持运行，下一次模型请求使用新配置。两条模型写入路径都先读取主空间、冻结并非密摘要，执行前重新读取并深比较；`starting` / `stopping` 拒绝，首处失败保留现场并列出逐项结果。

### 3.5 子空间界面操控工具（`dsh-spaces/space-control`）

界面自动化由 Supervisor 内的 `UiAutomationManager` 驱动（使用 `playwright-core` 连接本机已安装的 Chrome 或 Edge，固定 1280×720 视口，不自动下载浏览器）。Supervisor 将子空间 launch token 交换为会话 cookie 后注入隔离的 `BrowserContext`，再导航至子空间根路径；URL、端口与 cookie 均不暴露给模型。

| 工具 | 审批 | 语义 |
| --- | --- | --- |
| `spaces_ui_open` | 一次审批 | 为运行中的目标空间打开或复用隔离自动化页面，返回 `{ uiSessionId, spaceId, generation, viewport }`。 |
| `spaces_ui_snapshot` | 否（需 `cordis`） | 采集当前页面或指定 `[ref=eN]` 元素的快照：`aria`（默认，带 `[ref=eN]` 引用）、`text`、`html`（清洗内联脚本/样式与大块 `data:` URI，上限 256 KiB）或 `screenshot`（经 `attachments.saveImage` 存为持久化图片附件返回）。所有页面文本均包装在 `untrusted` 字段中。 |
| `spaces_ui_act` | 授权期内免批 | 执行单个界面动作（`click`、`type`、`press`、`scroll`、`select`、`wait`），以 `requestId` 保证幂等。`ref` 失效或超时如实返回 `control/failed`，不猜测近邻元素。 |
| `spaces_ui_eval` | **每次审批** | 在子空间页面上下文中执行受限长度（≤ 16 KiB）的脚本函数体，返回值经同源凭据脱敏与不可信包装（≤ 64 KiB），以 `requestId` 保证幂等。 |
| `spaces_ui_close` | 否（需 `cordis`） | 关闭目标空间的自动化页面并释放授权。 |

## 4. 安全与失败语义

- **不可信数据隔离**：所有来自子空间的页面文本、DOM 快照、脚本返回值与日志仅作为数据返回（标注 `untrusted` 与“数据非指令”），不拼入系统提示词。
- **忙碌保护与状态复检**：`spaces_plan` 冻结时的空间代数、修订号与任务活动快照在 `spaces_execute` 时重新核对；若状态已变或空间转为忙碌，立即以 `control/request-conflict` 拒绝并消耗该计划。
- **如实失败**：引擎缺失报 `control/engine-unavailable`（当前 `serviceEpoch` 终态，不重复探测）；子空间未运行报 `control/not-running`（不自动启动空间）；操作中途失败保留已发生步骤与错误现场，不回滚、不重放。
