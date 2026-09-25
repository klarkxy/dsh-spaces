# DSH Spaces 首页看板施工入口

状态：**设计合同，待实现**。日期：2026-09-25。设计版本：1。协议标识：`dsh-dashboard`。

核对基线：`c700f548157d6dab111e6c3f4830d524c573d647`。本次仅提交文档、类型合同和示例，不表示首页、发布通道、权限管理、SDK 或安装迁移已经实现；不发布版本，不迁移用户 Home。

## 产品目标

打开 Spaces 首先看到可组合的工作首页，而不是管理空间的默认聊天页。空间负责执行工作，组件负责呈现结果，看板负责组织组件。默认首页提供“需要我处理”“进行中的工作”“固定组件”和空间入口；“待处理”在首版只展示并跳转，不代替来源空间审批或执行。

全局的是组织方式，不是所有数据的访问权。默认预装的是轻量发布基础能力，不是全部业务插件，也不是完整管理器。首版限于单机、单 Home、现有本地使用者信任模型；不承诺多用户 ACL 或对同一 OS 用户下恶意 Node 插件的沙箱隔离。

## 阅读顺序

| 文档 | 解决的问题 |
| --- | --- |
| [架构与装配](docs/dashboard/architecture.md) | 运行边界、插件作用域、双端复用、现有代码接入位置 |
| [数据与生命周期](docs/dashboard/domain-and-lifecycle.md) | 类型/实例/摆放、并发、快照、离线、删除和持久化 |
| [接口合同](docs/dashboard/api.md) | HTTP、授权主体、请求响应、CAS、错误和版本 |
| [插件接入](docs/dashboard/plugin-sdk.md) | 可选依赖、发布流程、独立 DSH Web 模式、示例 |
| [安全与权限](docs/dashboard/security.md) | 发布授权、凭据、撤销、渲染、隐私和信任边界 |
| [施工与验收](docs/dashboard/implementation.md) | 分阶段任务、迁移、测试矩阵、发布门槛 |
| [TypeScript 合同](docs/dashboard/contracts.ts) | 无框架依赖的字段与联合类型；不是已发布 SDK |
| [可类型检查示例](docs/dashboard/examples.ts) | 写作、任务列表、跨空间布局与查询/变更样例 |
| [文档验证记录](docs/dashboard/validation.md) | 本次已做的文档检查、复现命令与未验范围 |

字段结构以 `contracts.ts` 为准；行为、安全、限制和故障语义以对应 Markdown 为准，两者必须同时满足。若发生冲突，停止相关施工并在同一 PR 修正文档，不自行猜测优先级。故障政策始终以 [let it crash](docs/let-it-crash.md) 为准。

## 首版固定的决定

1. Home 聚合模块随现有 Supervisor 运行，只有一个 Home 写入者；不增加第二个管理进程，不在 Supervisor 中加载第三方业务插件。
2. 独立看板插件在普通 DSH Web 中仅访问当前 Host；通过显式适配器接入 Spaces 后才能汇总多空间。Electron 不拥有业务状态或特权接口。
3. 每个受管理普通空间默认安装轻量 provider；业务发布默认关闭，须单独授权。根 `web`、管理 profile 和既有普通空间不在打开首页时被静默改写。
4. 数据走 Host 后台到聚合层，不走 iframe、DOM、`postMessage` 或桌面 IPC。现有 `view-bridge` 保持页面握手职责。
5. 首版使用完整 provider 快照和成功期间的有界只读轮询。失败后停止对应通道，不自动重连、重发、补传、重启或重放任务。
6. 首版只有安全内置组件、布局变更和来源导航，没有任意 HTML/JavaScript、自定义执行按钮、跨空间写任务或新的全局 Agent。
7. 新增看板协议 v1 不修改现有管理协议 v2 的含义。布局 CAS、数据序列与管理 revision 分离。
8. 不改变蓝图 v1 的执行语义。空间内组件配置可进入插件预设；全局布局分享、多空间编排和任意 Home 插件市场属于后续设计。

## 与现状的区别

| 基线已经存在 | 本方案新增，尚未实现 |
| --- | --- |
| `spaces-hub` 共享工作台、独立 Supervisor、桌面薄壳 | 可组合首页与本地/多空间 `DashboardBackend` |
| 普通空间 `view-bridge` 与视图握手 | Host 级 provider registry 和发布授权通道 |
| 管理协议 v2 的 epoch/revision、任务和预览 | provider 全量快照、布局 CAS、只读聚合查询 |
| 蓝图 v1 创建普通空间 | 不扩展蓝图权限；首页组合另行实现 |

以上现状依据 [README](README.md)、[工作台说明](docs/workbench.md)、[原生插件合同](packages/plugin/README.md)、[管理类型](src/shared/workbench.ts)、[视图桥接](packages/view-bridge/src/index.ts) 和 [蓝图规范](BLUEPRINT.md)。旧文档中的首页聊天行为作为历史基线保留；直到真实验收完成，不能将本设计写成当前用户说明。

## 施工纪律

实际进度和证据继续记录在 [唯一活动账本](tasks/todo.md)。本目录里的阶段与验收项是待执行计划，不是第二份完成记录。实现者先读 `AGENTS.md`、故障政策和活动账本；只使用隔离沙箱，绝不以真实 `~/.dsh` 验证。

第一项工作是按施工文档的 P0 在实际 DSH SDK 中验证服务注入、共享 React、标准 bundle、认证和凭据交付。本文给出的是新接口设计，不声称官方 DSH 已存在同名服务或支持这些 HTTP 路由。
