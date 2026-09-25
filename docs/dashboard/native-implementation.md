# 原生 DSH 看板插件：第三批施工与验收

日期：2026-09-25。实现 PR：[#13](https://github.com/klarkxy/dsh-spaces/pull/13)，依赖 #12 → #11 → #10。本批验证代码：`be2a97610e3508775d18189a9c94276d6cb2fad2`。后续文档提交不代表重新运行不同代码。

本批将现有 local backend 和共享视图接成独立原生插件，并实际验证 tarball 安装、原生登录、Host 发布、客户端加载、固定组件、正常重启与卸载。**仍未完成 Home 聚合与默认首页替换，没有合并 main、发布版本、安装到用户真实 Home 或修改现有运行时锁文件。**

## 1. 新增装配

`packages/dashboard/package.json` / `cordis.patch.yml` 定义未发布的 `@dsh-spaces/dashboard@0.1.0-alpha.1`。`scripts/build-dashboard-plugin.mjs` 只构建此独立包：Host 代码保留官方 SDK 为外部依赖；客户端使用原生模块加载约定，React 不重复打包。构建检查阻止导入 Electron、Spaces 管理器或 Supervisor 装配。没有改写原有五组件清单。

`src/index.ts` 作为 Host 入口依赖 `storageDomain`、`connection`、`webServer`。先核实显式命名 profile 和 loopback 服务接口，再打开官方存储，创建 LocalDashboard，提供内部 dashboardProvider，注册两条精确 HTTP 路由。它不创建第二个 HTTP 监听器、Home 控制器或全局管理服务。

`src/client.tsx` 在原生 `sidebar.panellist` 与 `main` 中注册工作首页，不接管 `root` 或默认聊天页。客户端 backend 使用原生同源 Cookie，不收集 Home bearer 或启动 token。测试的 token 交换发生在验收程序中，浏览器使用的是原生 HttpOnly 会话 Cookie。

## 2. 身份、安全与生命周期

provider 注册不接受 spaceId/providerId 字段；native Host 从实际调用它的 Cordis `fiber.name` 分配逻辑 provider 标识。真实 SDK 探针验证了 contextual service 调用看到的是消费插件的上下文。这个名称可能继承命名祖先，不代表包来源证明；同名注册拒绝，不覆盖其它实例。对同一 OS 用户下的恶意 Node 代码，本方案不承诺沙箱隔离。

网页只能调用 query 和布局 commands。HTTP 层和 LocalDashboard 的授权回调都使用当前原生 Connection 校验，不以浏览器声明的角色、用户名或 spaceId 授权。当前原生载体是本机单操作者模型，不宣称多用户 ACL。匿名请求返回 401，不匹配的 Host/Origin/header 返回 403。

请求校验在读 body 前、读完后和异步响应前执行；正文严格 JSON、限制字节、期限和并发。错误内容使用固定公开码，不回显原始异常或秘密。客户端明确同源、禁止重定向、不缓存、不重发失败写入。发布句柄随调用者生命周期释放；插件停止会撤下路由并关闭本地存储，没有故障重启、补传或回滚链。

## 3. 实际验证结果

[Dashboard native run 36094740902](https://github.com/klarkxy/dsh-spaces/actions/runs/36094740902) 的 `http` 与 `native` 两个 job 均通过。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| Strict TypeScript | 通过 | Dashboard Host、HTTP、客户端和相关测试 |
| 新增 HTTP 测试 | 7/7 通过 | 真实 Node HTTP socket，鉴权、恶意 Host、Origin、重复键/编码/大小、幂等写、传输错误 |
| 独立包构建与 npm pack | 通过 | 预构建 Host/Client、官方 loader 包装、无重复 React、无桌面管理代码 |
| 实际 SDK contextual caller | 通过 | 实际安装 Cordis 的依赖声明、消费上下文与 fiber 名称 |
| 官方 CLI 安装与配置读回 | 通过 | 在命名隔离 profile 用 CLI 安装 tarball；bundle 自动出现，无手动激活行 |
| 原生认证及 Host 数据 | 通过 | 真实 token→Cookie，未登录/非法 Origin/header 拒绝，原生测试插件发布并被查询 |
| 原生 Chromium 看板 | 通过 | 正常完成首次引导、原生侧栏入口、真实共享 React/loader、点击固定并展示进度 |
| 正常重新启动 | 通过 | 关闭后新启动，布局 revision 和引用保留，不重发原 mutation |
| 卸载与根数据隔离 | 通过 | 正常 CLI 卸载与配置读回；受保护根目录指纹未改变 |

同一代码提交上的 [Dashboard local run 36094740938](https://github.com/klarkxy/dsh-spaces/actions/runs/36094740938) 通过，继续覆盖上批的 91 项 Node 检查和共享视图 Chromium 流程。本批新增 7 项 HTTP 检查，合计涉及 **98 项不同的 Node 测试**；contextual SDK 探针和两条浏览器流程另计，不重复累加同一套核心回归。

环境：GitHub Actions Ubuntu 24.04、Node 24.21.0。隔离 SDK 明确安装 CLI `@deepseek-ai/dsh@0.1.7-alpha.1` 和 pnpm 10.15.0；实际解析的 Cordis 为 4.0.4，Connection/Storage 等相关 SDK 为 0.1.7-rc.2。构建仍使用项目锁定依赖，未把传递依赖解析结果回写用户项目版本或宣称其它组合已兼容。

## 4. 证据与观察

原生测试产物 `dashboard-native-evidence`（artifact ID `10846444873`，上述 run，保留至 2026-10-02）含 `native.png` 和 `result.json`。已下载并读回结果 JSON、检查截图，状态为 passed，五项完成记录均存在。

这一次与上一批浏览器内存 fixture 不同：截图来自**实际安装 tarball 后的原生 DSH Web**。显示的数据仍来自验收脚本创建的合成业务 Host 插件，没有调用模型、访问真实业务数据或把该测试插件预装给用户。

截图确实显示原生侧栏中的“工作首页”和已固定的 3/10 进度卡。截图顶部同时存在原生“Unable to create default workspace”提示：本批没有验证或修复 DSH 默认聊天工作目录的初始化，不能把看板流程通过扩展为整个原生工作区体验无错误。按钮窄宽度换行、双语和样式一致性也仍是界面完善项。

第一次原生浏览器流程在首次引导遮罩处超时，因为脚本在 hydration 前立即判断按钮不存在；修订后等待并点击原生“继续”和“稍后配置”，没有强制点击、删除遮罩或绕过首次引导。失败现场不是被改写为成功，新的提交和新的 run 才是本记录的通过证据。

## 5. 使用限制与剩余门槛

本批只支持显式命名 profile 和 `127.0.0.1`，拒绝根 `web`。**有名字本身不能证明存储隔离。** 插件使用宿主已选择的官方 domain facility，不核验所有第三方 backend 的物理根。正常使用前必须由宿主建立隔离与单写者所有权；本次测试使用现有 applyIsolationPatch，在自己的临时 Home 内明确分离根目录。

验收脚本的根目录指纹是安装前后比较，不宣称独立证明所有任意插件组合、符号链接攻击、Windows ACL 或未隔离的 profile 都安全。测试只覆盖本机命名隔离场景，没有远程部署、反向代理、嵌入式启动器、不带 profile 参数、Electron 包或 Windows/macOS 原生安装验收。

P0/P1 的原生安装纵向链路已取得实际证据，但公开 SDK 类型分发、业务插件重复配置实例的稳定标识、完整独立卸载矩阵、完整目录分页、拖拽、双语和来源导航仍需继续完善。不把这一批称为全部 P0/P1 与发布验收完成。

P2–P5 尚需 Home 聚合/发布授权、真实多空间后台通道、默认预装、组件清单升级、首页路由替换和真实业务 provider 的跨端验收。没有把测试数据混入正式首页。

仓库级 CI 与 Desktop startup 是另行的门槛。记录时此提交的两个仓库级 run 仍在执行；前批 Windows 工作台升级与交接失败也不能用看板专项绿色抵消。本批未改对应实现或跳过那些测试，不宣称全仓库绿色。

## 6. 复现入口

在隔离开发工作目录使用 Node 24：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npx --no-install tsc -p tsconfig.dashboard-ui.json
node --import tsx --test tests/dashboard-http.test.ts
node scripts/build-dashboard-plugin.mjs
npm install --prefix .sandbox/dashboard-sdk --ignore-scripts --no-audit --no-fund --fetch-retries=0 @deepseek-ai/dsh@0.1.7-alpha.1 pnpm@10.15.0
npx --no-install playwright install --with-deps chromium
DSH_DASHBOARD_SDK_ROOT=.sandbox/dashboard-sdk node --import tsx scripts/test-dashboard-native.mjs
```

命令中的环境变量语法是 POSIX shell。测试脚本自己创建 `.sandbox/dashboard-native-*`，不要求填真实 Home。它创建的测试包、临时 Home 和失败证据属于该次调用，不会打包进公开插件。读取源码与安装/运行证据应分别审查。
