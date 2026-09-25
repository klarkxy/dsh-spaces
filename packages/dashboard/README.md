# @dsh-spaces/dashboard

实验性原生 DSH Web 看板插件。**已完成独立 tarball 构建和隔离命名 profile 的原生安装验证，尚未发布 npm 或正式版本。** 不依赖 Electron，不启动 Supervisor，不自动替换 Spaces 的默认首页。

原生安装验证见 [native-implementation.md](../../docs/dashboard/native-implementation.md)，前一阶段证据保留在 [local-implementation.md](../../docs/dashboard/local-implementation.md)。总合同：[DASHBOARD.md](../../DASHBOARD.md)。

## 当前安装边界

初始适配只接受以 `--profile <name>` 或 `--profile=<name>` 显式启动的命名 profile，以及 `127.0.0.1` HTTP 服务。根 `web`、缺失或重复的 profile 参数、远程监听和未识别的宿主接口会明确拒绝，不提供兼容回退。

**命名 profile 不自动等于数据隔离。** 插件使用该 Host 已选择的官方 `storageDomain`，不会自行改写 storage root；宿主必须先保证该 profile 的存储隔离与单写者所有权。不要在继承根数据目录的 profile 中试装。本仓库安装验收脚本在自己的临时 Home 中先应用现有隔离逻辑，再安装插件，并校验根 `web`、sessions、storages 指纹。

安装与验证只能在隔离开发 Home 进行。本包没有发布到 npm，不能把包名安装当作已可用的分发方式。

## 从源码构建

在包含依赖 PR 的本仓库分支、Node 24 环境中执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
node scripts/build-dashboard-plugin.mjs
mkdir -p .sandbox/dashboard-artifacts
npm pack ./packages/dashboard --ignore-scripts --pack-destination .sandbox/dashboard-artifacts
```

构建输出 `lib/index.js` 和 `lib/client.js`，并将许可证带入 tarball。客户端通过 DSH 的 `__ModuleLoader__` 加载，React 和官方 SDK 保持外部依赖，不嵌入第二份 React。该构建不修改 Spaces 的现有五组件清单。

对**已准备好且隔离的**命名开发 profile，官方 CLI 的安装操作为 `dsh plugin --profile <name> add <tarball-absolute-path>`；正常启动仍显式指定该 profile。完整可复现的隔离安装入口是 `scripts/test-dashboard-native.mjs`，环境准备和验收命令见本轮记录。不要直接对真实 Home 运行测试。

## 使用与插件接入

登录原生 DSH Web 后，从侧栏打开 **工作首页**。初始没有内置假任务；只有同一 Host 的业务插件主动注册并发布后，目录才出现组件。可以固定、移除和调整位置与尺寸，摆放记录保存在官方存储中。删除摆放不删除源业务实例。

业务插件在自身 Cordis 上下文中使用 `dashboardProvider.register({ types, snapshot })`，取得 `publish()` / `dispose()` 句柄。身份取自当前调用者的 `fiber.name`，不是注册参数或网页请求。重复名字不能覆盖另一个 provider；这个名字是宿主中的逻辑标识，不是 npm 作者认证，也不是恶意 Node 插件沙箱。

业务插件需要独立运行时，应通过 Cordis 的可选服务接入，不把看板设为其核心业务的必需依赖。测试中的 source 是故意依赖看板的专用验收插件，不是生产业务模板。`dashboardProvider` 没有注册浏览器 Remote 方法。

## 原生认证与数据边界

HTTP 仅暴露 `POST /api/dashboard/v1/query` 和 `POST /api/dashboard/v1/commands`。每次请求复用原生 `connection.requestRejection` 的登录校验，再检查精确 Host、Origin 和 `X-DSH-Dashboard: 1`；异步操作返回前再次检查。不存在匿名读取、任意业务执行或跨空间发布 HTTP 接口。

请求正文采用严格 JSON、1 MiB 上限、5 秒读取期限和有界并发；响应不缓存。浏览器传输使用同源 Cookie，拒绝重定向，读响应有 8 MiB 上限。认证失败清除界面内容；失败请求不自动重发。

域标识 `dsh_dashboard_local`、version 1、single global，同时保存布局、回执和本空间快照。首次显式打开官方域可以创建空目录，但查询不隐式写入默认看板。存储损坏和写入失败不切换后端、不恢复旧状态、不伪造成功。

## 当前界面与未完成项

目前支持 progress、metric、list、markdown；Markdown 是安全纯文本，没有脚本、HTML、外部图片或可点击链接。布局使用位置表单，尚无拖拽；目录显示前 100 项并明确提示，完整目录分页界面、看板管理、双语与原生样式细节仍需补齐。

原生入口当前没有接入来源导航按钮；逻辑 navigation 查询保留在后端，后续实际跳转必须复查目标，不能把 ID 当成路径。

**默认仍是本空间模式。** 已新增 Home 聚合模块及可选后台发布端，见 [Home 施工记录](../../docs/dashboard/home-implementation.md)。可信启动器显式提供 `DSH_SPACES_DASHBOARD_BOOTSTRAP_FILE` 时，Host 才读取本次私有凭据并发送获准组件；没有该变量就不寻找全局服务，非法配置明确报错。

两个原生 DSH Host 的后台发布已经过隔离验收，但现有生产 Supervisor 的授权管理和生命周期尚未挂载；不能自行填写全局 token 或把测试固定角色当作生产认证。当前 Home 私有文件只支持已验证的 POSIX 权限模式，Windows ACL 尚未实现并明确拒绝。

默认预装、组件清单过渡、Home 默认页面、授权界面和 Electron 产品验收仍未完成。独立包安装或双 Host 测试通过，不代表整个首页方案已经交付。
