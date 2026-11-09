# DSH Spaces 工作台

> 现行使用与运维说明。架构和数据所有权见 [architecture.md](architecture.md)；管理协议见 [merge-contract-v2.md](../tasks/merge-contract-v2.md)；故障政策见 [let-it-crash.md](let-it-crash.md)。历史实施与验收记录不替代当前版本验证。

## 1. 工作台是什么

Spaces 安装在现有 DSH Web 或 Desktop 宿主中。初始化后，原应用保留，空间栏用于切换主应用、管理工作台和普通空间。

每个 Home 只有一个 Supervisor 持有 Spaces 管理写权。管理工作台由专用 `spaces-hub` profile 承载；普通空间使用独立 DSH 进程和轻量桥接，不会成为第二个管理器。

普通空间只能在 Spaces 中通过直接创建、普通模板或 `.dshspace` 分享导入产生。Spaces 不扫描、收养或修改其他 profile。蓝图创建工作流当前封存。

## 2. 安装与初始化

按 [标准安装](plugin-standard-install.md) 构建并安装宿主插件。普通 Web 打开 **工作台 / Workbench** 后，仍要点击 **初始化 Spaces / Initialize Spaces**。官方 Desktop 在应用打开时于后台初始化并启动管理服务，主界面保持可用，不因启动开始、成功或失败而自动进入设置、新建或子空间。

这次启动由宿主进程按当前 Home 保存终态。界面刷新或重新挂载只是重新加入该记录，不会再要一次启动。失败或正常停止后，同一宿主进程不会自动重启。正常再次打开应用是一份新启动。已有的确认式手动服务入口也会建立一份新操作。子空间仍只在用户点击后启动。

设置和新建在准备期间可以点击，只保留最后一次导航意图；回到主空间会取消这次跳转，不取消后台启动。失败详情在用户主动打开设置或新建后显示：原始错误、随后的停止结果和进程记录是否保留各自独立，并经过脱敏。已有健康服务直接连接。宿主缺少所需启动观察接口时，这是明确的兼容失败，不回退到旧的初始化流程，也不据此断定服务没有启动。

- 已存在健康服务时，附着该服务；
- 没有服务且运行环境允许时，正常启动一次；
- 服务已停止本身不是错误，同一宿主进程内保持停止；
- 启动失败、所有权冲突或配置不兼容会显示真实原因；
- 后续打开页面不会自动补装、重试、恢复或续接失败请求。

完整 Spaces 插件只需安装在受支持的宿主入口。普通空间不要重复安装完整管理插件。

## 3. 空间与视图

- Desktop 点击空间会核实当前状态，已运行时进入，已停止时启动一次，启动中只等待已有操作；侧栏状态标识和右键菜单提供启动、关闭、重启。通用嵌入宿主的未运行空间仍从管理入口启动。
- 已访问视图可以保留；目标停止或重启后，旧视图身份失效。
- 新启动或切换失败时，保留仍可用的原视图并显示本次失败。
- 管理操作通过认证管理链执行；Desktop 侧栏额外提供受限的单个子空间启停入口，普通子空间及通用嵌入页面不因此获得管理写权。
- 关闭标签不会停止空间或 Supervisor。由官方 Desktop 启动的 Supervisor 跟随该 Desktop 退出：Desktop 宿主进程结束时，Supervisor 执行一次正常关闭（停止它管理的空间、释放运行权后退出）；关闭失败时保持原样并保留运行权，不强杀、不重试。由 Web 启动的 Supervisor 不受影响；Desktop 附着到已有 Supervisor 时不改变它的生命周期。

主应用、`spaces-hub` 和普通空间是不同角色。主应用不属于可删除、可停止的普通空间。

新建空间当前使用 **Web**，选择官方 DSH 的精确版本，再选择跟随主空间模型或在此空间配置。版本目录读取失败会显示错误并阻止提交。

主空间（web/desktop）在 Creator（`cordis` preset）下可用四个宿主工具：`spaces_context`（服务纪元/版本/可写性/忙闲/可用模型源）、`spaces_create_preview`（冻结一次性计划）、`spaces_create_execute`（单次审批后按 requestId 执行单个组合作业）、`spaces_job`（按作业 id 读结果）。执行是一个串行作业：prepare/运行时安装 → create → view-bridge → llm-policy → 逐项插件安装并读回 → 可选 start；首处失败即停止，partial 结果如实记录，不重试、不回滚。插件只接受 npm 精确版本或 GitHub 完整 commit，install script 仅在审批明确列出的 allowBuilds 键下运行。工具经独立 Creator scope 调用，不授予其他管理命令，也不依赖 LLM 服务。

Browser Space 入口当前封存：不显示创建选项，不接受 Browser 创建或启动，不开放原生浏览器展示转接。底座、版本契约和扩展实现保留，后续另行验收与启用；界面不显示封存提示。

## 4. 启停与服务生命周期

空间的 **启动 / 停止 / 重启** 是独立的用户操作，只影响目标空间。

**停止全部空间** 与 **停止 Spaces 服务** 不同。停止服务通过预览确认其影响，随后停止受管子进程并结束 Supervisor；只有正常停机完成后才释放运行权和端点。

关闭页面不是停止服务。服务失联后不会自动重启、重连、重发管理请求或接管锁。用户再次打开应用可以形成一次新的正常启动，但仍须满足所有权和维护证据规则。

Desktop 错误页的有限手动服务启动/重启入口仅以 [let-it-crash.md](let-it-crash.md) 为准：先预览受影响空间并明确确认，不重启子空间、不续跑任务、不强制终止或清除证据。

## 5. 任务、计划与批量操作

普通变更携带当前服务纪元和状态版本。过期客户端、过期状态或同名不同内容的请求会被拒绝。

危险操作先预览再执行。计划绑定服务、状态和目标指纹，并有有效期；刷新只读取原任务，不重新执行。

任务状态为：

```text
queued → running → succeeded / failed / cancelled
```

进程中断后，任务保留失败或结果无法确认的现场，不续跑。批量操作在首个失败处停止：前面的成功保留，失败项留证，后续项不执行。

管理读取可以是瞬时投影，不应把任务列表、日志或所有磁盘内容理解为同一全局一致性快照。

## 6. 模型与连接

当前有两种模型来源：

| 来源 | 调用方式 | 主要生命周期依赖 |
| --- | --- | --- |
| 主空间继承 | 子空间经 Supervisor 使用主空间官方 LLM 服务 | 子空间、Supervisor、主空间均可用 |
| 本地/会话选择 | 按该空间或会话的显式配置调用 | 对应空间及显式目标 |

新 Web 空间默认可以跟随主空间模型，不复制主空间 Key。主空间退出后该路径不可用，不自动启动主空间或改用其他供应商。主空间的连接与默认仍由主空间官方设置拥有。Browser 不加载模型桥接。

空间本地默认和会话显式选择保持独立。显式目标失效时失败，不自动切换来源。设置界面剩余的收敛项见 [model-settings-redesign-20261022.md](plans/model-settings-redesign-20261022.md)，该方案不是已完成能力清单。

## 7. 插件、普通模板与分享

插件发现、制品下载、安装到空间、配置参与组合和实际运行是不同状态。未能读取实际版本时显示未知，不改用 `latest` 冒充确定版本。

普通模板与 `.dshspace` 分享归档用于创建或分享空间配方，不是环境备份。配方保留 base 和其精确版本；导入先创建相同 base，再安装扩展，不可用的版本直接失败。Browser 配方当前不创建空间或安装扩展。定义、安装、配置和启动分别记录结果，导入不自动启动空间。

**Spaces 内蓝图工作流当前封存。** 蓝图创建、生成、预览、应用以及分享码导入导出暂停；普通模板和 `.dshspace` 分享不受影响。独立蓝图包、DSHBP1/DSHBP2 协议和既有文件保留，待 Spaces 核心系统稳定后再评估唤醒。协议与封存边界见 [blueprint.md](blueprint.md)。

## 8. DSH 版本与 Spaces 升级

每个普通空间固定一个精确 DSH 版本，禁止降级。官方基础插件随所选运行时变化，不由 Spaces 作为第三方插件安装进 profile。管理空间跟随宿主运行时。当前基线 SDK 为 `@deepseek-ai/dsh` **0.2.2-rc.1**（Cordis 4.1.0；宿主 Node ≥24.9，本项目 engines 为 Node 24.21+ 的 24.x 或 26.x）；官方升级指南目前只覆盖到 v0.2.2-alpha.3，rc.1 接缝以版本锁定源码为准。

`@klarkxy/dsh-dev-index` 随宿主插件和 view bridge 的组合 patch 以同一行 id 预装：主空间和每个 Web 子空间可用；Browser 的 profile patch 显式禁用它，普通模板与 `.dshspace` 分享不改变这个边界。

Web 空间在空间详情中预览并切换官方版本；不自动创建快照，不兼容的第三方插件会阻止切换。Browser 的框架版本由其 base 发行版固定，不提供单独切换 DSH 的入口。未再被任何空间使用的运行时可以通过正常管理操作删除。

升级 Spaces 本身：

1. 通过官方插件管理更新宿主中的 Spaces 插件；
2. 在管理工作台停止 Spaces 服务；
3. 重新打开 Spaces。

Supervisor 使用新宿主插件携带的同一组件组，管理插件在管理器启动前对齐。普通既有空间不能仅凭“已经装有桥接”就视为与新组件组版本一致；当前版本状态必须据实判断，不宣称每次启动都会自动重对齐。

没有应用内自我更新、一次性启动器交接或升级失败回滚。

## 9. 备份与诊断

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

Main-model inheritance depends on the child, Supervisor and main host. Legacy shared connections retain frozen launch snapshots and direct provider calls. Local and session selections do not silently fall back to another source.

Upgrade Spaces by updating the host plugin, stopping the service and reopening it. Backups are create/list/delete only. Unregistered external DSH writers are outside the consistency guarantee. See [the current architecture](architecture.md) and [the fault policy](let-it-crash.md) for the authoritative boundaries.
