# DSH Spaces 工作台

> 现行使用与运维说明。架构和数据所有权见 [architecture.md](architecture.md)；管理协议见 [merge-contract-v2.md](../tasks/merge-contract-v2.md)；故障政策见 [let-it-crash.md](let-it-crash.md)。历史实施与验收记录不替代当前版本验证。

## 1. 工作台是什么

Spaces 安装在现有 DSH Web 或 Desktop 宿主中。初始化后，原应用保留，空间栏用于切换主应用、管理工作台和普通空间。

每个 Home 只有一个 Supervisor 持有 Spaces 管理写权。管理工作台由专用 `spaces-hub` profile 承载；普通空间使用独立 DSH 进程和轻量桥接，不会成为第二个管理器。

普通空间只能在 Spaces 中通过直接创建、普通模板或 `.dshspace` 分享导入产生。Spaces 不扫描、收养或修改其他 profile。蓝图创建工作流当前封存。

## 2. 安装与初始化

按 [标准安装](plugin-standard-install.md) 构建并安装宿主插件。普通 Web 打开 **工作台 / Workbench** 后，仍要点击 **初始化 Spaces / Initialize Spaces**。官方 Desktop 在应用打开时于后台初始化并启动管理服务，主界面保持可用，不因启动开始、成功或失败而自动进入设置、新建或子空间。

这次启动由宿主进程按当前 Home 保存终态。界面刷新或重新挂载只是重新加入该记录，不会再要一次启动。失败或正常停止后，同一宿主进程不会自动重启。正常再次打开应用是一份新启动。已有的确认式手动服务入口也会建立一份新操作。子空间按本次启动的恢复模式启动：默认恢复上次正常关闭前运行中的空间；用户可在服务启动/重启确认中选择不恢复，或在设置页“通用”中的“服务设置”中关闭该恢复。

设置和新建在准备期间可以点击，只保留最后一次导航意图；回到主空间会取消这次跳转，不取消后台启动。失败详情在用户主动打开设置或新建后显示：原始错误、随后的停止结果和进程记录是否保留各自独立，并经过脱敏。已有健康服务直接连接。宿主缺少所需启动观察接口时，这是明确的兼容失败，不回退到旧的初始化流程，也不据此断定服务没有启动。

- 已存在健康服务时，附着该服务；
- 没有服务且运行环境允许时，正常启动一次；
- 服务已停止本身不是错误，同一宿主进程内保持停止；
- 启动失败、所有权冲突或配置不兼容会显示真实原因；
- 后续打开页面不会自动补装、重试、恢复或续接失败请求。

完整 Spaces 插件只需安装在受支持的宿主入口。普通空间不要重复安装完整管理插件。

## 3. 空间与视图

- Desktop 点击空间会核实当前状态，已运行时进入，已停止时启动一次，启动中只等待已有操作；侧栏状态标识和右键菜单提供启动、关闭、重启和打开空间设置（跳转至设置页并直接打开该空间详情）。通用嵌入宿主的未运行空间仍从管理入口启动。
- 已访问视图可以保留；目标停止或重启后，旧视图身份失效。
- 新启动或切换失败时，保留仍可用的原视图并显示本次失败。
- 管理操作通过认证管理链执行；Desktop 侧栏额外提供受限的单个子空间启停入口，普通子空间及通用嵌入页面不因此获得管理写权。
- 关闭标签不会停止空间或 Supervisor。由官方 Desktop 启动的 Supervisor 跟随该 Desktop 退出：Desktop 宿主进程结束时，Supervisor 执行一次正常关闭（停止它管理的空间、释放运行权后退出）；关闭失败时保持原样并保留运行权，不强杀、不重试。由 Web 启动的 Supervisor 不受影响；Desktop 附着到已有 Supervisor 时不改变它的生命周期。

主应用、`spaces-hub` 和普通空间是不同角色。主应用不属于可删除、可停止的普通空间。

新建空间对话框顶部提供 **空白 / 从模板 / 从文件导入** 三种方式：空白与从模板创建以 **显示名称** 为主输入并自动生成空间标识（支持在折叠的“高级选项”中自定义标识、切换官方 DSH 精确版本或模型来源，并可选择创建后是否直接启动进入）；从文件导入接收 `.dshspace` 分享归档并进入导入预览。版本目录读取失败会直接显示错误并阻止提交。

设置页的空间列表点击行即打开该空间的设置详情（含“常规 / 插件 / 高级”三页），右侧 `⋯` 按钮与右键菜单统一提供空间设置、启动/重启/停止、导出分享文件、存为模板、上移/下移、重命名、换图标与删除。常规页为每个空间提供“打开 Desktop 时启动”，默认关闭；开启后，只在用户打开 Desktop 且管理服务就绪时启动该空间一次。设置页“通用”中的“服务设置”另提供“启动服务时恢复上次正常关闭前运行中的空间”，默认开启。

主空间（web/desktop）在 Creator（`cordis` preset）下可用四个宿主工具：`spaces_context`（服务纪元/版本/可写性/忙闲/可用模型源）、`spaces_create_preview`（冻结一次性计划）、`spaces_create_execute`（单次审批后按 requestId 执行单个组合作业）、`spaces_job`（按作业 id 读结果）。执行是一个串行作业：prepare/运行时安装 → create → view-bridge → models-sync（选择主空间模型时）→ 逐项插件安装并读回 → 可选 start；首处失败即停止，partial 结果如实记录，不重试、不回滚。插件只接受 npm 精确版本或 GitHub 完整 commit，install script 仅在审批明确列出的 allowBuilds 键下运行。工具经独立 Creator scope 调用，只授予创建相关命令。

同一 preset 下还有空间总控工具：只读 `spaces_overview`、`spaces_inspect`、`spaces_logs`、`spaces_templates`；两阶段变更 `spaces_import_preview`、`spaces_plan` → `spaces_execute`，用 `spaces_control_job` 读结果；运行中空间另有 `spaces_ui_open` / `spaces_ui_snapshot` / `spaces_ui_act` / `spaces_ui_eval` / `spaces_ui_close`。变更计划绑定服务纪元、状态版本、目标指纹和有效期，执行前重验并在独立审批中列出目标与精确来源；停止态和运行中插件操作不能同时写同一 profile。`spaces_ui_eval` 每次单独审批并展示完整脚本，页面内容按不可信数据处理。

Browser Space 入口当前封存：不显示创建选项，不接受 Browser 创建或启动，不开放原生浏览器展示转接。底座、版本契约和扩展实现保留，后续另行验收与启用；界面不显示封存提示。

## 4. 启停与服务生命周期

空间的 **启动 / 停止 / 重启** 是独立的用户操作，只影响目标空间。

**停止全部空间** 与 **停止 Spaces 服务** 不同。停止服务通过预览确认其影响，随后停止受管子进程并结束 Supervisor；只有正常停机完成后才释放运行权和端点。

关闭页面不是停止服务。服务失联后不会自动重启、重连、重发管理请求或接管锁。用户再次打开应用可以形成一次新的正常启动，但仍须满足所有权和维护证据规则。

Desktop 错误页的有限手动入口（“重新加载空间界面”与服务启动/重启）仅以 [let-it-crash.md](let-it-crash.md) 为准：前者仅在后台与管理空间仍就绪时以只读方式重建前端壳层控制器，后者先预览受影响空间并明确确认；确认时可选择服务启动后的空间恢复模式。它不续跑任务、不强制终止或清除证据。

## 5. 任务、计划与批量操作

普通变更携带当前服务纪元，单写者作业队列串行执行；工作台忙碌状态按目标空间计算（全库级操作如 Home 备份与服务关闭才占用全局忙碌），无关空间的启动、创建或变更可提交并进入 `queued` 排队，同名不同内容的重复请求仍被拒绝。

危险操作先预览再执行。空间级计划只校验受影响的目标空间指纹与代次，无关空间的状态变化不会令已预览的空间计划失效；全库级计划继续校验全局状态版本。计划有效期在提交入队时核验，入队等待不会令已提交的计划超时失效；刷新只读取原任务，不重新执行。

任务状态为：

```text
queued → running → succeeded / failed / cancelled
```

进程中断后，任务保留失败或结果无法确认的现场，不续跑。批量操作在首个失败处停止：前面的成功保留，失败项留证，后续项不执行。

管理读取可以是瞬时投影，不应把任务列表、日志或所有磁盘内容理解为同一全局一致性快照。

## 6. 模型与连接

每个空间用自己 profile 里的模型配置直接调用供应商。主空间模型通过一次性同步进入空间：

| 时机 | 入口 | 条件 |
| --- | --- | --- |
| 创建时 | 新建对话框选择“使用主空间模型”（默认），或主空间 Creator 工具 `modelSource: "main"` | 创建作业的 `models-sync` 步骤 |
| 手动 | 空间详情 → 常规 →“从主空间同步模型”，或主空间 `spaces_plan` 的 `models.sync` | 运行中、已停止或异常退出的受管 Web 空间 |

同步复制主空间的 `llm-pi-ai` 路由、`llm-deepseek` 配置、默认模型和这些路由引用的 Key。同名路由以主空间为准，空间自己添加的路由保留。预览列出路由、默认模型、Key、跳过项与缺失 Key 的名称；执行前重新读取并比较摘要，变化时在任何写入之前拒绝。运行中空间通过自身 `settings` / `credentials` 接口写入并保持运行，下一次模型请求使用新配置；已停止或异常退出的空间直接写入配置文件；启动中或停止中的空间需等待状态稳定后重试。首处失败保留真实现场，并列出已写入、失败和未执行项。同步之后两边各自独立，主空间再改配置时，需要的话再点一次同步。

“常规”页的模型卡片显示该空间配置文件的已配置、配置不完整或未配置状态，以及默认模型和路由数量。它不代表模型连通性已经验证。登录授权型（OAuth）和表达式路由跳过并列出名称。Browser 空间和管理空间没有这个入口。

运行中同步目前只支持可由目标 `credentials` 接口写入的 Key 引用。若主空间使用供应商凭据记录，运行中入口会在任何写入前拒绝；可在正常停止目标空间后，另行发起一次文件同步。

空间本地默认和会话显式选择保持独立。显式目标失效时如实失败。旧委派方案的合同见 [归档](archive/llm-main-inheritance.md)；设置界面的历史收敛方案同样只作记录。

## 7. 插件、普通模板与分享

默认插件目录使用 Spaces 仓库维护的[公共清单](../catalog/README.md)，面向所有作者开放收录；内置快照与公开 `catalog/index.json` 使用同一份数据。首批条目来自 dsh-plugins，作者继续独立发布自己的 npm 包。界面展示双语简介、分类、作者、来源、支持范围，以及“已收录”或带精确版本与证据的实测记录。已有本地缓存由用户刷新后更新，自定义目录地址继续生效。安装前通过用户选择的 npm 官方源或镜像读取版本；未收录插件可使用“按 npm 包名安装”，无需先申请目录收录。

插件发现、制品下载、安装到空间、配置参与组合和实际运行是不同状态。目录按用途分类，卡片提供最新已发布稳定版一键预览安装、就地展开版本选择与已安装标记；未能读取实际版本时显示错误，不改用 `latest` 冒充确定版本。运行中空间的普通插件安装、移除与启停通过该空间自身的 `pluginManager` 在线执行，不先停机；若插件需要重启空间才能完全生效，作业结果返回 `restart-required`，由用户决定立即重启或稍后自行重启。误装管理包清理（`cleanup-manager`）仅在检测到该空间确有误装时显示，并与 DSH 运行时切换一样保持停机修改与重启语义。

普通模板与 `.dshspace` 分享归档用于创建或分享空间配方，不是环境备份。配方保留 base 和其精确版本；导入先创建相同 base，再安装扩展，不可用的版本直接失败。Browser 配方当前不创建空间或安装扩展。定义、安装、配置和启动分别记录结果，导入不自动启动空间。

既有空间的“导出分享文件”与“存为模板”统一从空间右键或行尾 `⋯` 菜单发起；设置页的 **模板** 列表专注于已存本机模板的使用与删除（点击“使用此模板创建”会在新建空间对话框中预选该模板），从模板创建与 `.dshspace` 文件导入均在新建空间对话框中完成。

**Spaces 内蓝图工作流当前封存。** 蓝图创建、生成、预览、应用以及分享码导入导出暂停；普通模板和 `.dshspace` 分享不受影响。独立蓝图包、DSHBP1/DSHBP2 协议和既有文件保留，待 Spaces 核心系统稳定后再评估唤醒。协议与封存边界见 [blueprint.md](blueprint.md)。

## 8. DSH 版本与 Spaces 升级

每个普通空间固定一个精确 DSH 版本，禁止降级。官方基础插件随所选运行时变化，不由 Spaces 作为第三方插件安装进 profile。管理空间跟随宿主运行时。当前基线 SDK 和新空间默认运行时为 `@deepseek-ai/dsh` **0.2.2-rc.1**，最低空间运行时为 `0.2.0-rc.2`（Cordis 4.1.0；宿主 Node ≥24.9，本项目 engines 为 Node 24.21+ 的 24.x 或 26.x）；官方升级指南目前只覆盖到 v0.2.2-alpha.3，rc.1 接缝以版本锁定源码为准。

`@klarkxy/dsh-dev-index` 随宿主插件和 view bridge 的组合 patch 以同一行 id 预装：主空间和每个 Web 子空间可用；Browser 的 profile patch 显式禁用它，普通模板与 `.dshspace` 分享不改变这个边界。

Web 空间在空间详情中预览并切换官方版本；不自动创建快照，不兼容的第三方插件会阻止切换。Browser 的框架版本由其 base 发行版固定，不提供单独切换 DSH 的入口。未再被任何空间使用的运行时可以通过正常管理操作删除。

升级 Spaces 本身：

1. 通过官方插件管理更新宿主中的 Spaces 插件；
2. 在管理工作台停止 Spaces 服务；
3. 重新打开 Spaces。

Supervisor 使用新宿主插件携带的同一组件组，管理插件在管理器启动前对齐。普通既有空间不能仅凭“已经装有桥接”就视为与新组件组版本一致；当前版本状态必须据实判断，不宣称每次启动都会自动重对齐。

没有应用内自我更新、一次性启动器交接或升级失败回滚。

## 9. 备份与诊断

### 本地轮换诊断日志

Spaces 在 `<DSH_HOME>/.dsh-spaces-control/logs/` 写入本地 JSONL 诊断日志。`host.jsonl` 记录宿主插件与 Cordis 日志，`supervisor.jsonl` 记录管理服务、管理请求、空间生命周期和子空间输出。每条记录包含 UTC 时间、级别、来源、事件名、进程 ID，以及经过脱敏的消息、上下文或错误堆栈；可以用支持 JSONL 的编辑器按事件名、级别或空间 ID 检索。

打点覆盖 Supervisor 所有权和组件准备、管理空间创建与接入、计划预览和执行、作业阶段、CLI 调用、插件下载/安装/移除、运行时下载/版本校验、空间进程启动/就绪/退出，以及模型同步的写入与读回。阶段事件以 `step.started` / `step.completed` / `step.failed` 记录具体 `step` 和耗时；`operationId` 关联同一请求或作业，`job` 是作业 ID，`space` 是空间 ID。定位失败时先按 `operationId` 或 `job` 收集事件，再查看最后一个完成阶段之后的首个 `error` / `fault`；不会根据日志猜测未知插件归属。

发布包默认从 `info` 开始，因此只记录关键操作边界、状态和失败，不保留 `debug` 的请求/阶段起始细节或子空间普通输出。需要完整调用时序时，在开发构建中使用默认 `debug` 级别。子空间 Remote 调用只记录 `remote.*` 的方法、目标、状态与耗时，不记录参数和响应载荷。

日志不记录原始 HTTP 请求正文、聊天载荷、Cookie、bootstrap token、API Key 或本机绝对路径。CLI 失败保留经过脱敏和长度限制的输出；模型同步只记录路由/凭据名称、数量和校验结果。`http.request` 的 `request` 与 `operationId` 相同，可与后续 `request.*`、`job.*` 和阶段事件对照。

级别固定为 `debug`（定位细节）、`info`（关键状态）、`error`（已观察到的失败）、`fault`（未捕获异常、异常退出或停机失败）。源码开发与测试默认保留全部四级；`pnpm run pack:plugin` 生成的发布包默认只保留 `info`、`error` 和 `fault`，调试子空间普通输出也不会进入发布包日志。

当前文件超过 100 MiB，或从创建时起超过 7 天，在下一条日志前滚动为带 UTC 时间戳的归档。归档在写入时清理：保留最近 7 天，且每个日志源的归档总量最多 100 MiB（当前活动文件另计）。归档不会自动上传。日志写入失败只向标准错误说明，不重试、不改变原操作结果，也不触发恢复或重启。

凭据、Cookie、启动令牌、常见聊天载荷和本机绝对路径会在落盘前移除。日志用于定位 Spaces 自身和子进程可观察到的故障，不等同于第三方插件的完整内部追踪；进程被操作系统强制终止时，可能只有此前已写入的记录。

设置页左侧导航固定为 **空间 / 模板 / 通用 / 维护** 四项：**通用** 直接展示界面语言与外观主题，低频服务配置（包来源、插件目录地址、端口范围）收纳在折叠的“高级”区；**维护** 在单页内集中承载服务状态与任务列表、Home 备份、DSH 运行时、工作台日志与停止服务入口。

Home 备份支持 **创建 / 查看 / 删除**，不支持产品内恢复。创建备份会停止已知受管空间。

未登记的手工 DSH 进程不可见也不可停止，因此备份只保证已知受管空间停止后的一致性范围，不能保证所有潜在外部写者都已停止。详见 [外部进程边界](../tasks/workbench-external-discovery.md)。

工作台诊断提供有界、脱敏的错误与日志。独立 Doctor 只诊断，不解锁、不恢复、不回滚、不改写任务或配置。损坏、未知和未来格式的记录保留原证据。

## 10. 错误处理

已知原因时，错误应包含空间、阶段、已知插件或其他可归因对象、原因和退出信息。无法确定时明确写出未知，不能把最近安装的插件直接认定为根因。

错误详情和复制日志必须脱敏，不包含 token、Cookie、凭据或聊天内容。

用户主动启动、停止、重启、安装、卸载和配置仍是正常管理操作，但不包装成“一键修复”“恢复中断任务”或“检查并恢复”。完整边界以 [let-it-crash.md](let-it-crash.md) 为唯一权威。

## 11. 支持边界

- 普通 loopback Web 与已验收的官方 Desktop 使用各自受支持的展示适配。
- 远程 HTTPS、任意第三方原生宿主和未验证布局不属于已认证范围。
- Web iframe 可能受到站点嵌入限制；跨域导航可见性与 Desktop native guest 不同。
- 空间隔离不是恶意插件沙箱；同一 Host 进程和同一 OS 用户属于信任边界。
- 当前构建、真实宿主和平台验收状态以对应记录为准，不由本文推导。

---

## English summary

DSH Spaces uses one Supervisor per Home, a dedicated manager profile and independent ordinary-space processes. The original host remains in place; presentation never grants management authority.

Use [the installation guide](plugin-standard-install.md) to install and initialize. Closing a tab does not stop the service. Mutations use protocol 2 epochs and revisions, dangerous operations use preview then execute, and interrupted jobs are never replayed.

Each space calls model providers directly with its own configuration; main-space model configuration can be copied once at creation (`models-sync`) or synced manually (`models.sync`). Manual sync previews and rechecks a non-secret summary. A running target stays running and uses the new configuration on its next model request; stopped and crashed targets are written directly. Starting and stopping targets wait for a stable state. Failures retain the actual partial result without silent fallback.

Upgrade Spaces by updating the host plugin, stopping the service and reopening it. Backups are create/list/delete only. Unregistered external DSH writers are outside the consistency guarantee. See [the current architecture](architecture.md) and [the fault policy](let-it-crash.md) for the authoritative boundaries.
