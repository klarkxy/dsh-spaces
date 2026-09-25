# 业务插件与看板插件接入

状态：待实现的 SDK 设计。类型与样例：[contracts.ts](contracts.ts)、[examples.ts](examples.ts)。

## 1. 三种支持组合

| 组合 | 行为 |
| --- | --- |
| 只有业务插件 | 原业务正常；不存在看板服务不应导致启动失败 |
| 普通 DSH Web + provider + dashboard | 仅本 Host 的组件与布局；不要求 Electron 或 Supervisor |
| Spaces + 每空间 provider + Home dashboard | 多空间授权投影汇总，浏览器和桌面复用相同界面 |

是否连接 Home 必须由明确的宿主装配决定。没有配置是 local-only；已经配置但握手失败是 failed，不能切回 local-only 伪装正常。业务插件不依赖 Home 管理 API，不导入 Electron 模块。

## 2. 插件作者提供什么

作者提供类型声明、稳定实例 ID、当前完整快照以及可选来源导航引用。provider registry 从真实 Host 插件上下文绑定 providerId；业务插件不能任意选择其它 providerId。首次注册后明确调用 publish 提供初始快照，随后仅在已提交的业务状态变化时请求更新。

`BoundProviderRegistry` 是新设计的可选能力接口，不是 DSH 已存在的 `ctx.dashboard`。P0 的 Host 适配器应基于实际 SDK 验证的可选注入和生命周期钩子提供它。注册表、空间发布身份与浏览器接口分别实现，不能为了少写适配层把 Host Context 直接交给 UI。

接入次序：验证可选 registry → register(types, snapshot) → publish() → 在业务提交后 publish() → 在正常插件卸载时 dispose()。没有 registry 时跳过这条展示链，不能阻止原业务启动。

snapshot 只读取当前业务状态，不生成内容、不调用模型、不执行任务、不扫描其他空间。它必须能在前端页面从未打开时运行。读取失败应报告该 provider 的真实失败，不能返回空列表冒充“没有任务”。

## 3. 发布返回值与失败隔离

publish 首先校验并提交本地投影，然后由 Home 适配器按授权选择实例，并只携带这些实例引用的类型声明。返回的 localRevision 只对应本地快照；home.state=not-configured 明确没有配置 Home 发布，not-authorized 表示此 provider 没有获准输出，published 表示已收到对应序列的耐久确认，failed 包含脱敏错误。不要把本地提交成功写成跨空间发布成功。

本地 snapshot/验证失败时 Promise reject，局部展示链失败；已经完成的业务提交不回滚。Home 网络/授权失败以 home.failed 保留原始分类，本地业务仍可继续。失败的 Home 通道在本次运行不再次发送；后续业务变化不构成重新连接的授权。

高频 publish 可以在真正发送前合并完整状态；本地 revision 与 Home sequence 不保证一一对应，也不保证展示所有中间状态。不能把这条通道用于必须逐条执行的业务命令或财务事件。对同一 provider 的 snapshot/发布调用需要串行化，防止较慢的旧 snapshot 覆盖较新的本地状态。

正常 dispose 表示 provider 的展示能力已移除；在仍健康且获授权的通道上提交一次明确的空集合后释放注册。失败时报告并释放能证明归属的本次句柄，不重新发送；不删除原业务数据库。异常退出由宿主观察，不能在 finally 中伪造一次成功移除。

## 4. 两个首版参考 provider

[examples.ts](examples.ts) 提供写作章节进度和代码审阅列表。示例包名、ID、时间与数据均为虚构；实际 bearer、空间身份和 grant 必须由运行环境提供，不得照抄示例建立生产授权。

写作插件应从自己的章节状态获得进度，实例 ID 与作品绑定。不得读取 Dream 记忆正文来“顺便总结”首页。任务列表由任务插件自己的状态投影，点击列表仍回来源空间，首页不能批准任务或提交发布。

同一实例可以在多个看板里出现。来源插件升级时维持 instanceId；需要改变字段语义时增加类型版本。旧消费者不支持时显示占位，不自动将新字段喂给旧渲染器。

## 5. 发布授权交互

在 Home 管理设置中选择实际安装的 provider 并预览授权。默认使用明确选中的 instanceIds；这些 ID 可由用户从来源空间选取，不能通过未授权的 Home catalog 枚举内容。选择 all 必须说明后续新增实例也会发布。

首次授权的预览只需要展示插件身份、选择范围及数据影响；不能为了展示预览而先静默拉取未授权正文。来源页面发起的“请求固定到 Home”也只是导航/授权意图，不是已批准的写入；Home 端必须重新验证来源身份、权限与选择，再走管理预览/执行。

用户确认后显示 pendingStart，下一次用户正常启动/重启空间时发布当前快照。撤销立即隐藏 Home 数据；不会等待来源空间在线，也不会为了清理而启动它。

## 6. 原生打包与依赖

使用仓库已有 [标准插件安装规则](../plugin-standard-install.md) 与 [包合同](../../packages/plugin/README.md)：标准 bundle、官方 loader、共享 SDK/React，不安装第二份导致 Cordis 服务身份分裂的 SDK。provider 是 Host 基础层，dashboard 是可选 UI 层；业务层只把看板注册作为可选集成。

standalone dashboard 的标准组合包含所需 provider 服务；已经存在同一 provider 服务时不能再注册第二份。包冲突明确失败，不由 Spaces 自动禁用其中一份。版本与资源由明确的发行包锁定，不能在打开首页时下载 latest。

新 provider 包要进入不可变组件组和安装验证链；具体过渡见 [施工文档](implementation.md)。把源码目录放进仓库不等于普通空间已安装插件，也不等于官方 CLI 能理解看板蓝图。

## 7. 首版可组合范围

用户可以选择业务 provider、选择发布哪些实例、添加/移除/重复摆放组件、调整网格和建立看板。安全内置 renderer 由看板包提供，读取受校验的数据；不要求第三方前端执行代码。

全局布局预设的导入导出、任意第三方 renderer、跨空间写操作和 Home 级插件市场不属于本版 SDK。以后增加它们必须补充版本、安全与验收合同，不能用 WidgetContent 中的 markdown 或 ID 偷渡代码。
