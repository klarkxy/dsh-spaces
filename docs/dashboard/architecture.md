# 首页看板架构与装配

状态：设计合同，待实现。入口：[DASHBOARD.md](../../DASHBOARD.md)。故障政策：[let it crash](../let-it-crash.md)。

## 1. 边界与数据流

逻辑链路为：业务插件 → 当前 Host 的 provider registry → 空间发布适配器 → Supervisor 内的 DashboardHub → DashboardBackend → 浏览器或桌面中的同一看板组件。

普通空间之间不建立同步连接。看板不读取空间数据库、完整会话或工作目录。聚合层持有经过授权的展示投影，而不是第二份业务系统；任务、审批、文件和记忆仍由来源空间负责。界面未打开不影响仍在运行的 Host 发布；Host 停止后不可能凭缓存继续工作。

现有管理平面继续负责空间生命周期、安装、配置和 Home 运行权。新增数据平面负责发布和读取，新增布局平面只负责摆放。三者共享明确的身份边界，但不共用一个高频更新 revision。

## 2. 作用域不是安装次数

| 作用域 | 实例数 | 权限与状态 |
| --- | --- | --- |
| Home 看板能力 | 每个 Home 一份权威存储 | 授权投影、看板布局；管理写入仍走 Supervisor |
| 空间 provider 基础插件 | 每个选择安装的 Host 一份 | 本地注册表、本地投影、限定本空间的输出能力 |
| 业务插件 | 按空间选择 | 原有业务状态；可选提供组件，不因缺少看板而停止业务 |
| 看板前端 | 每个打开的浏览器/桌面视图一份 | 显示和编辑布局；不持有 Home bearer 或发布凭据 |

“所有空间默认预装”仅指以后由 Spaces 创建的受管理普通空间。根 `web` 保持不变；已有空间通过用户可见的正常安装计划加入；管理 profile 使用自身装配，不能被普通空间模板覆盖。

## 3. 建议代码单元

下列包名与新增路径均为施工目标，不是已有或已经发布的 npm 包。

| 单元 | 职责 | 明确禁止 |
| --- | --- | --- |
| `@dsh-spaces/dashboard-contracts` | 字段、验证规则、浏览器安全接口 | 依赖 Electron、文件系统或凭据服务 |
| `@dsh-spaces/dashboard-provider` | DSH Host 插件；本地 registry、发布适配器、本地只读查询 | 接管空间管理、扫描其它 profile、启动 Supervisor |
| `@dsh-spaces/dashboard` | 标准 DSH 看板插件、内置渲染器、布局 UI、local/home backend 适配 | 通过 DOM 抓取业务数据、让客户端直接管理进程 |
| `DashboardHub` | 现有 Supervisor 中的受信任模块；验证、存储、查询 | 加载第三方插件代码、调用 LLM、运行用户脚本 |

provider 在未获得 Home 发布配置时是明确的 `local-only` 状态，不尝试发现或启动全局服务。看板在 local 模式通过当前 Host 的已认证接口访问本地 registry；本地布局由该 Host 单写入。home 模式通过管理工作台的受信任适配器连接 Supervisor。两种模式是用户/宿主明确选择的装配，不是失败后的自动切换。

同一页面只装配一个布局 backend。普通空间运行 standalone 看板，不会因此获得管理工作台的 remotes。业务插件通过 Host 绑定的可选 registry 接口注册；不得自行声明另一个插件的身份。

## 4. 与现有代码的衔接

| 已核对的入口 | 施工位置与约束 |
| --- | --- |
| [WorkbenchApp](../../packages/plugin/src/workbench/app.tsx) | 注入同一 DashboardView/backend；不要新建桌面专用状态容器 |
| [管理合同](../../src/shared/workbench.ts) | 保留 v2；新增发布授权计划类型需同时扩展 host/client 校验 |
| [Supervisor 入口](../../packages/supervisor/src/index.ts) | 继续调用现有 `createWorkbenchSupervisor`；聚合模块在其生命周期内装配 |
| [view-bridge Host](../../packages/view-bridge/src/index.ts) 与 [client](../../packages/view-bridge/src/client.ts) | 只保留视图环境与 ready/failed/disconnected 握手；不复用为业务总线 |
| [完整插件安装合同](../../packages/plugin/README.md) | 标准 bundle、共享 SDK/React、既有管理 profile；普通空间不装完整管理器 |
| [蓝图 v1](../../BLUEPRINT.md) | 保持新普通空间和封闭字段合同，不通过 extensions 偷增执行行为 |

建议新增纯域逻辑 `src/core/domain/dashboard.ts`、Node 存储/路由适配器 `src/adapters/node/dashboard-*`，以及上述插件包。具体文件拆分可调整，但浏览器包不得反向依赖 Node 模块。P0 必须核对实际 SDK 的服务命名、释放钩子、可选注入和认证方法；不能把本文 SDK 草案直接当作 DSH 内置 API 调用。

## 5. 首页与导航

Spaces 的默认首页改为看板；当前管理空间聊天页保留独立“聊天”入口，已有会话、草稿和历史不搬迁、不删除。旧 `homeUrl` 的职责应明确迁移为聊天入口引用，不能同时暗指新看板和旧聊天页。

路由由现有工作台承载；逻辑入口为 `dashboard.home` 和 `dashboard.board/<id>`。具体 DSH 视图注册方式在 P0 固定，不占用普通 DSH Web 的根 UI。独立安装只添加看板入口，不强行替换普通 Web 首页。

首页包含空间摘要、待处理/进行中的组件集合、固定组件区。系统空间状态来自现有 Supervisor 自己已知的数据，不通过读取业务插件获得。没有发布授权时仍能显示空间入口、明确的空状态和添加组件入口，不自动调用模型填充首页。

卡片必须显示来源空间、来源插件、更新时间和离线/失败/不支持状态。同一个实例可在多个看板摆放。点击来源只解析受信任的逻辑导航目标；来源停止时展示正常空间入口，不隐式启动。

## 6. 首版不建的东西

不建立通用消息代理、事件溯源系统、CRDT、多 Home 联邦、多用户协同、全局任务引擎、生成代码渲染器或新的插件市场。Home 级业务插件未来仍应运行在适合的 DSH Host 中，不能因为“全局”就放入 Supervisor 的管理信任域。

HTTP 发布和有界只读查询足以验证首版。浏览器成功完成一次读取后才安排下一次正常读取；任何失败结束该读取会话。没有 SSE/WebSocket 自动重连、自动补传或持久 outbox。真实需求证明需要流式接口时，另行扩展协议并维持同样故障边界。

## 7. 默认布局与可替换性

首次显式进入看板可经一次普通布局写入建立空的默认看板；GET/query 本身永不创建它。稳定默认看板 ID 与创建幂等性防止两个客户端各建一份。用户可以移除默认组件、重新排序、建立其它看板。

自由组合主要发生在“业务 provider + 安全组件类型 + 看板引用”上，不要求任意插件组合必然启动成功。替换看板 UI 不改变来源任务；停用 Home 发布不影响本地业务；退出桌面不停止发布服务；停用看板插件不删除来源数据。这四项均是发布门槛。
