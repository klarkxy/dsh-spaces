# Spaces 宿主嵌入合同 / Host embedding contract

状态：现行产品合同。官方 Windows Desktop 与普通 Web 宿主已在隔离 Home 完成实测，见 [当前验收](../../tasks/node24-desktop-20261020.md)；早期原生实验记录和 Web 首批实现保留作历史。当前架构基线见 [现行架构](../architecture.md)，安装与操作见 [标准安装](../plugin-standard-install.md)，故障政策以 [let it crash](../let-it-crash.md) 为唯一权威。本合同不改变管理权限和故障政策。

## 产品边界

DSH Spaces 是兼容宿主内的多空间插件，发行单元只有插件 tarball，本仓库不提供自有客户端或独立桌面壳。安装到官方 Web、官方 Desktop、第三方或自有应用的产品目标相同：左侧空间栏、右侧选定 WebUI、随时回到当前应用。

宿主必须提供实际可用的布局与认证嵌入能力。“不依赖品牌”不表示任意应用无需适配，也不表示模拟官方 Desktop 标记可获得权限。普通 Web 适配限于同站 loopback iframe；官方 Desktop 使用其受支持的原生展示通道。远程 HTTPS、其它本机主机名和其它原生宿主仍需要单独适配与验收。缺失条件必须明确显示并在初始化前拒绝，不关闭浏览器安全机制。

| 对象 | 责任 | 非责任 |
| --- | --- | --- |
| 宿主 | 原应用界面、布局插槽、窗口、自己的运行时 | 不把私有组件交给蓝图安装 |
| 空间 | WebUI 端点、配置和数据范围、运行归属 | 不是单纯一个 iframe |
| 空间视图 | 显示、隐藏、导航、就绪握手 | 不提供数据隔离或自动启动权限 |
| 管理服务 | 经授权创建、配置、启停受管空间 | 不因某页面显示空间栏而授予它管理权限 |
| 蓝图 | 新空间的插件组合和配置配方 | 不选外层浏览器、宿主品牌或替换宿主外壳 |

产品面向单机、单用户和同一 OS 用户信任域。空间隔离用于分离插件组合、会话、工作数据和管理权限，不构成恶意插件沙箱、多租户隔离或跨机器高可用。

## 展示与管理分离

真正的管理 profile 继续注册工作台管理能力。其它顶层宿主提供只读指引；身份已验证的 Desktop 另外提供下述受限的显式启停入口。空间栏不替换宿主 root、品牌或会话 DOM。当前应用是一个展示入口，不进入受管空间删除/停止列表。布局适配只保留窄空间栏并在切换时遮蔽、禁用原内容；退出插件恢复其拥有的样式与属性，不重新创建原 UI。

普通被嵌入空间带合法视图桥身份时不再挂完整空间栏。管理空间被嵌入时使用 contained 布局：隐藏第二排空间按钮，保留 Home、创建、设置操作。查询参数只控制展示，不改变身份、权限转接、单写者约束或授权。

Home 仍由管理工作台提供，保留默认首页（原生 Home）。宿主若在安装期间重载插件，会回到当前应用。普通 Web 的初始化请求不持久化、不重放；已存在的健康服务只连接，不在 Web 安装入口的页面加载中创建管理服务。服务就绪后，Web 用户点击「Spaces 首页」打开工作台。

官方 Desktop 打开应用后外层仍显示当前应用。宿主按当前 Home 在后台初始化并启动管理服务，不因这次启动进入设置，也不自动打开子空间。同一宿主进程把该次终态留在这份 Home 记录里；刷新或重新进入面板只是重新加入，失败或正常停止不会自动再启动。正常再次打开应用是一份新启动。已有的确认式手动服务操作也会建立一份新操作。设置仍固定在普通空间列表之外，不占用宿主默认主页；它共用既有管理服务，不是可删除、可启停的普通 profile。普通 Web 仍由用户显式点击初始化，其默认 Home 行为不由 Desktop 后台启动改变。

管理服务可能先于管理器就绪。只读观察该次启动完成后才领取一次性入口；状态读取失败、运行代次变化、服务不可用或管理器崩溃立即结束，不重试、不重启。

## 认证与视图来源链

普通宿主通过已认证的宿主能力请求一份受限展示入口。宿主验证封闭请求对象，经既有 Node 管理通道向管理服务申请入口票据；浏览器不能直接调用该内部申请入口。

管理服务签发有界、单次、60 秒的入口票据，绑定父来源和随机通道。票据通过一次性入口地址兑换既有 HttpOnly、SameSite=Strict 的 operator Cookie；父页面不获得可复用的 Node 管理凭据或 Cookie。该一次性入口地址本身属于临时认证材料，不得写入日志、蓝图或持久配置。兑换后的文档限期可重载；已加载会话继续使用正常会话认证，没有持久票据或跨重启续接。

实际嵌入链：

```text
当前宿主 + 空间栏
  -> 管理服务来源的受限展示页
       -> 管理空间来源的 contained 工作台
            -> 普通空间来源的 WebUI
```

这条链保留既有视图桥的精确父来源，避免把受保护的子页面直接搬到任意父来源。展示页向外发送裁剪的空间目录、切换结果和错误状态。外层只可选择目录中运行中的空间或 Home（官方 Desktop 另有固定的设置系统目标）；没有提交、预览、启动、停止、安装或脚本转发。

官方 Desktop 的 Browser Space 使用额外的封闭展示消息：管理空间先确认当前可见、已注册的子窗口/来源/通道/运行代次，并裁剪视口；原生展示层只接收该管理窗口和来源，校验当前运行空间，再通过有界片段交给最外层插件。插件以官方浏览器租约创建 HTTP(S) 网页 guest，回复匹配请求 ID 的地址/标题观察。新标签请求取代旧的在途展示，旧回复不覆盖新选择。外部网页不获得 preload、Node、嵌套 webview 或宿主 API；宿主切换/退出立即隐藏，短租约到期释放网页 guest。该专用展示通道不授予管理权限。

官方 Desktop 的用户点击空间表示打开并在需要时启动；侧栏显示运行状态，右键可启动、关闭或重启单个受管子空间。这个显式入口由身份已验证的 Desktop 宿主单独转接，不经展示消息授予管理权；拒绝主空间、管理空间、外来空间、维护状态及过期服务纪元，关闭和重启只执行目标空间的非破坏性正常计划。连续点击不重复提交，观察失败不重发，完成后尊重用户后续导航。通用嵌入宿主仍从真正的管理界面启动未运行空间。所有写入继续由管理服务经运行代次/状态版本、计划和单写者规则处理。

三层消息分别校验窗口来源、精确 origin 和通道，内层还校验服务纪元、空间 ID 和运行代次。入口有数量和期限上限；响应读取有字节上限；连接/握手超时是失败，不是“成功但未显示”。失败终止本次通道，不自动重连、补装、重启或接管。切回当前应用、隐藏视图、卸载插件均不停止后台。

## 桥接与版本

管理插件在管理器启动前与当前组件组对齐；对齐失败即阻止该管理器启动并报告原因。

普通空间按需获得随组桥接。既有空间是否已按当前组件组重新对齐必须据实展示：已安装桥接不等于版本一致，Spaces 不把“存在桥接”写成“已对齐”。空间固定的 DSH 运行时版本与 Spaces 组件组版本是两个坐标：管理空间跟随宿主，普通空间固定精确 DSH 版本并按用户操作切换。

Spaces 跟随宿主插件升级：更新宿主中的 Spaces 插件 → 在管理工作台停止服务 → 重新打开 Spaces。应用内自我更新和任何自动交接不是现行能力。

## Host adapter obligations (English)

The default adapter occupies the additive host layout seat and requires its explicit layout contract. It keeps the existing native application tree alive. Root replacement, brand guessing, broad DOM searches and spoofing host globals are not integration contracts.

Display role and management authority are independent. The generic embedded rail receives a bounded inventory and selects running views. The verified Desktop host additionally forwards explicit open/start/stop/restart requests for one managed child through the authenticated management service; its presentation relay grants no management authority. The original application is not adopted as a managed profile.

A contained manager preserves the existing origin chain to its children and suppresses a duplicate space rail. The Home surface and ordinary template/share editor remain the same implementation. Blueprint workflows in Spaces are sealed; neither blueprints nor host adapters install the outer shell or select iframe versus a native view.

The Web transport requires same-site HTTP loopback cookies. The official Desktop experiment uses its authenticated native guest carrier and two fixed system destinations; its tested version and limits are recorded separately. Remote deployments and arbitrary third-party layouts remain uncertified. A new adapter must prove authentication, embedding policies, layout cleanup, exact-source messaging and runtime ownership without broadening the core management API. Lack of an adapter must be visible before initialization writes.

## 验收门槛

实际浏览器应证明：安装宿主 URL 不变；原会话 DOM/草稿保留；空间视图保留；只一排空间栏；Home 可打开；窄屏可用；卸载布局恢复；错误来源、过期运行代次和伪造消息不能导航；只读选择不触发启动或管理写入。还需要真实 CLI 安装、授权初始化、卸载和重启独立服务验收。纯页面 fixture 不替代真实插件，也不替代官方 Desktop 签名安装包验收。
