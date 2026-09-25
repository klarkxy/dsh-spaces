# Spaces 宿主嵌入合同 / Host embedding contract

状态：2026-09-25 新定位的首批实现。基于 Home 看板 PR #16；不是已发布版本或全宿主兼容认证。验收及剩余范围见 [实施记录](implementation.md)。本页取代旧文档中“普通宿主只能跳转到管理工作台”的展示限制，不改变管理权限和故障政策。

## 产品边界

DSH Spaces 是兼容宿主内的多空间插件。安装在官方 Web、官方 Desktop、第三方或自有应用中的产品目标相同：左侧空间栏、右侧选定 WebUI、随时回到当前应用。自有 Electron 客户端是预装插件和运行环境的发行方式，不是核心能力的唯一入口。

宿主必须提供实际可用的布局和认证嵌入能力。“不依赖品牌”不表示任意应用无需适配，也不意味着模拟官方 Desktop 标记可获得权限。首批内置适配器限于 `http://127.0.0.1` 同站 iframe；`dsh-app://app`、远程 HTTPS、localhost 别名和独立 Electron 原生视图需要单独适配与验收。缺失条件明确显示，初始化前拒绝，不关闭浏览器安全机制。

| 对象 | 责任 | 非责任 |
| --- | --- | --- |
| 宿主 | 原应用界面、布局插槽、窗口、自己的运行时 | 不把私有组件交给蓝图安装 |
| 空间 | WebUI 端点、配置和数据范围、运行归属 | 不是单纯一个 iframe |
| 空间视图 | 显示、隐藏、导航、就绪握手 | 不提供数据隔离或自动启动权限 |
| 管理服务 | 经授权创建、配置、启停受管空间 | 不因某页面显示空间栏而授予它管理 RPC |
| 蓝图 | 新空间的插件组合和配置配方 | 不选外层浏览器、宿主品牌或替换 desktop-host |

本批保持蓝图 v1 的普通新建空间语义、封闭字段和验证规则，不通过 extensions 加入可执行行为。接入外部既有空间的完整注册模型仍是后续工作，不因展示合同就声称已实现。

## 展示与管理分离

真正的 manager profile 继续注册 Workbench 管理 Remotes。其它顶层宿主仅注册 Guide，增加 `shell.overlay` 上的空间栏，不替换宿主 root、品牌或会话 DOM。当前应用是一个展示入口，不进入受管空间删除/停止列表。布局适配只保留 72px 空间并在切换时遮蔽、禁用原内容；退出插件恢复其拥有的样式与属性，不重新创建原 UI。

普通被嵌入空间带合法 view-bridge 身份时不再挂完整空间栏。manager 被嵌入时使用 contained 布局：隐藏第二排空间按钮，保留 Home、创建、设置操作。查询参数只控制展示；它不改变身份、RPC 注册、单写者或授权。

Home 聚合看板仍由管理工作台提供，保留 PR #16 的默认首页、发布授权和显式聊天入口。外层宿主默认显示当前应用；初始化成功由该次明确操作进入 Home。已存在的服务只连接，不在安装入口的页面加载中创建管理服务。

## 认证与视图来源链

普通宿主通过已认证 Guide 请求 `portalTarget({parentOrigin, channel})`。Host 验证封闭 DTO，经现有 Node bearer 连接请求 Supervisor 的 `/internal/portal`。浏览器不能用 operator Cookie 调用该内部端点。

Supervisor 签发有界、单次、60 秒 entry ticket，绑定父来源和随机 128-bit channel。ticket 通过 `/portal-bootstrap/<ticket>` 兑换既有 HttpOnly、SameSite=Strict operator Cookie；父页面不获得可复用的 Node bearer 或 Cookie。该一次性 entry URL 本身属于临时认证材料，不得写入日志、蓝图或持久配置。兑换后的文档限期可重载；已加载会话继续使用正常会话认证，没有持久 ticket 或跨重启续接。

实际嵌入链：

```text
当前宿主 + 空间栏
  -> Supervisor 来源的受限展示页
       -> manager 来源的 contained Workbench
            -> 普通空间来源的 WebUI
```

这条链保留既有 view-bridge 的精确 parentOrigin，避免把受保护的子页面直接搬到任意父来源。展示页仅向外发送裁剪的空间目录、切换结果和错误状态。外层只可选择目录中运行中的空间或 Home；没有 submit、preview、start、stop、安装、任意 URL 或脚本转发。

用户需要启动尚未运行的空间时，进入真正的空间管理界面执行正常操作。所有写入仍由 manager 经现有 epoch/revision、计划、单写者规则处理。按钮可见不等于管理权限。

三层消息分别校验 Window 来源、精确 origin、channel，内层还校验 serviceEpoch、spaceId、generation。入口有数量和 TTL 上限；响应读取有字节上限；连接/握手超时是失败，不是“成功但未显示”。失败终止本次通道，不自动重连、补装、重启或接管。切回当前应用、隐藏视图、卸载插件均不停止后台。

## Host adapter obligations (English)

The default adapter occupies the additive `shell.overlay` seat and requires its explicit `data-shell-overlay` layout contract. It keeps the existing native application tree alive. Root replacement, brand guessing, broad DOM searches and spoofing Desktop globals are not integration contracts.

Display role and management authority are independent. Only the actual manager exposes management Remotes. The in-place rail receives a bounded inventory through an audience-bound relay and can select already-running views; explicit management stays inside the authenticated manager. The original application is not adopted as a managed profile.

A contained manager preserves the existing origin chain to its children and suppresses a duplicate space rail. The Home dashboard and blueprint editor remain the same implementation. A blueprint neither installs the outer shell nor selects iframe versus a native view.

The bundled transport currently requires same-site HTTP loopback cookies. Official Desktop custom schemes, remote deployments and arbitrary third-party layouts are not certified by this change. A new adapter must prove authentication, embedding policies, layout cleanup, exact-source messaging and runtime ownership without broadening the core management API. Lack of an adapter must be visible before initialization writes.

## 验收门槛

实际浏览器应证明：安装宿主 URL 不变；原会话 DOM/草稿保留；空间视图保留；只一排空间栏；Home 可打开；窄屏可用；卸载布局恢复；错误来源、过期 generation 和伪造消息不能导航；只读选择不触发启动或管理写入。还需要真实 CLI 安装、授权初始化、卸载和重启独立服务验收。纯页面 fixture 不替代真实插件，也不替代官方 Desktop 签名安装包验收。
