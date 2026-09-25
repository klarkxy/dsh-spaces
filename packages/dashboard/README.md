# Dashboard source components

状态：**本空间后端、共享视图和官方存储适配已有实现；尚不是可直接安装的 DSH 插件包**。本目录还没有 package manifest、bundle、原生认证/remote 接线或公开发布。不要对用户提供虚构的 npm 安装命令。

本轮实现和验证证据见 [local-implementation.md](../../docs/dashboard/local-implementation.md)。总合同见 [DASHBOARD.md](../../DASHBOARD.md)，阶段状态以 [tasks/todo.md](../../tasks/todo.md) 为准。

## 模块

| 入口 | 作用 | 不负责什么 |
| --- | --- | --- |
| `src/view.tsx` | 共享 React `DashboardView` / `DashboardApp`；四种组件、固定/移除、位置表单、窄屏、读写错误 | 不创建 Home、不提供认证、不启动空间 |
| `src/model.ts` | 有界读取 overview/board/catalog/instances；一致 epoch 与响应校验；布局命令 | 不自动重试、不持久化浏览器内容 |
| `src/host/domain-store.ts` | 将本地看板完整文档交给官方 storage-domain 的 single 布局 | 不带自己的文件系统后端，不改其它 profile |
| `../../src/core/domain/dashboard/local-backend.ts` | 当前 Host 的查询、provider 绑定、串行持久写、回执与分页 | 不聚合其它空间、不持有 Supervisor 管理权 |

看板域的文件标识是 `dsh_dashboard_local`，遵守官方 unit name 规则；它不是插件包名或 wire protocol。域全局记录将布局、回执和本空间快照写在同一文档中。官方显式 domain open 会初始化空存储目录，查询本身不创建默认看板或写入记录。

## 宿主装配顺序

Host 完成自己的正常启动、profile 归属与单写者校验后，把**已选定的官方 domain facility**传给 `openDashboardDomainStore`。取得 store 后构造 `LocalDashboard`，传入宿主确定的 spaceId、标题、backendEpoch、时钟和 ID 生成器。

只给经过认证的客户端暴露 `service.client(authorizer)` 返回的 query/mutate。authorizer 必须读取当前会话权限，不能固定返回“允许”，不能使用浏览器提交的 subjectId 或 layoutWrite。每次调用、异步返回前和实际写入前都有复查，但适配层仍须实现真实 Cookie/Origin/Host/custom-header 校验以及 body 大小限制。

`bindProvider` 只交给受信任的 Host 装配代码，由真实插件身份分配 providerId，不向浏览器或任意业务参数开放。业务插件取得的是已经绑定的 registry，再调用 `register({types, snapshot})`。没有 HomePublisher 时，本地提交的 home 结果明确为 `not-configured`，不探测其它服务。

`DashboardApp` 接受已经认证的 `DashboardBackend`。原生 DSH 的共享 React 和 loader 接线还没有在本包交付；Chromium 测试使用测试 bundle，不应将该 bundle 当作正式 DSH 客户端加载方式。宿主提供的 `onOpen(ref)` 必须先调用 navigation 查询，并在实际导航时再次检查逻辑目标，不能把 sourceTarget 的 ID 拼成文件路径或任意 URL。

正常关闭时按业务 provider → dashboard/store 的依赖顺序释放。关闭看板界面不停止业务 Host。失败是终态，不切存储、不重放旧写入，也不重新取授权复活发布通道。

## 当前交互范围

- progress、metric、list、markdown 四类；markdown **按纯文本显示**，没有 HTML、脚本、远程图片或可点击链接。
- 固定/移除组件、12 列网格位置与尺寸表单、已有看板切换；**尚无拖拽和完整看板管理 UI**。
- 目录目前只显示前 100 个组件，超过时明确提示；后端分页已经实现，完整分页界面尚未接入。
- 布局写入保持 CAS；正常读取不会隐式创建布局。读写权限丢失立即清空来源内容并终止当前读取会话。
- UI 文案本轮为中文；完整双语与原生宿主样式集成仍待施工。

## 已验证与未验证

已在 GitHub Actions Node 24 上运行核心、本地服务、视图、真实官方存储和 Chromium 测试。实际 SDK 版本、精确提交和操作边界见实现记录；“测试已通过”不代表可安装包、原生 DSH Web、Home 聚合或 Electron 产品验收已经完成。
