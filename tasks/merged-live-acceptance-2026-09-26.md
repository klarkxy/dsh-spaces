# 合入后 Windows 实机验收（2026-09-26）

结论：**部分通过，整体不通过。** `main@990cc80faf65d5335c6c330cb1470ab925ccc4f3` 已合入 PR #10–#17；当前 Windows 构建的默认 Home 看板不可用，跨空间发布能力不能交付。宿主空间栏和基本桌面流程实际通过，不抵消该缺口。

本轮仅构建、运行隔离验收并记录结果，没有修改产品源码、提交、推送或发布。历史文档中的“尚未合入”和此前 Linux CI 结果不作为本次状态依据。

## 环境与边界

- 本机 Windows，Node 24.16.0，官方 DSH CLI 0.1.7-alpha.1，当前仓库 Electron 与 Playwright 1.62.1。
- 当前源码重新执行 `npm run build` 及独立 dashboard 构建，两者通过。Electron 使用当前 `out/`；宿主插件由当前构建重新打包后通过官方 CLI 安装。
- 所有 Home 位于 `.sandbox/`；普通宿主使用 `acceptance-host` 命名 profile，从官方虚拟默认配置创建并应用隔离 patch。没有读写真实 `~/.dsh`，没有复制用户数据、配置凭据或发起模型请求。
- 本轮是未打包 Electron 和真实官方 Host 验收；不代表 NSIS 安装包、官方 Desktop 自定义协议、其他操作系统或真实业务 provider 已通过。

## 阻断项

### 1. Windows 默认首页进入不可工作的看板

复现：使用当前构建启动全新隔离 Home，等待真实 Supervisor 和管理 Host 就绪，默认首页显示“看板读取已停止 / 当前内容不可用 / dashboard/unavailable”。从相同已登录 Supervisor 页面请求 `/api/dashboard/v1/query`，实际返回 HTTP 501、`dashboard/unsupported-operation`。

产品代码仍在 Windows 跳过 `WorkbenchSupervisorRuntime.initDashboard`；`HomeDashboardFileStore` 及私有 bootstrap/publisher 也明确拒绝 Windows。该限制是合入内容已知但尚未完成的 Windows ACL 接入，不是本机缺少测试数据或模型密钥。因此本轮没有将多空间发布、固定卡片、撤权和布局持久化记为 Windows 通过。

证据：[默认首页截图](../.sandbox/merged-desktop-20260926-RB2aJA/01-home.png)、[桌面结果 JSON](../.sandbox/merged-desktop-20260926-QKI2Dw/result.json)。代码位置：`src/adapters/node/workbench-supervisor.ts` 的 `initDashboard`、`src/adapters/node/dashboard/file-store.ts` 构造器、`src/adapters/node/dashboard/bootstrap.ts`、`packages/dashboard/src/host/home-publisher.ts`。

### 2. 平台不支持的具体原因在浏览器中丢失

普通宿主和桌面管理页来自管理 Host 端口，Home API 来自 Supervisor 端口。在 Windows 无 dashboard 的分支，`handleDashboardRequest` 直接返回 501，没有允许管理来源的 CORS 响应。实际宿主浏览器记录了 preflight 缺少 `Access-Control-Allow-Origin`；前端只能得到网络失败并显示 `dashboard/unavailable`，没有显示代码中已有的“此平台尚未支持 Home 看板能力”。

证据：[宿主结果 JSON 的 consoleErrors](../.sandbox/merged-portable-20260926/results.json)、[宿主首页截图](../.sandbox/merged-portable-20260926/initialized.png)。当前 unsupported 响应分支位于 `src/adapters/node/workbench-supervisor.ts:456` 附近，前端错误转换位于 `packages/dashboard/src/http-client.ts`。修正时应保留精确来源与认证边界，不能用放宽 CORS 代替平台能力实现。

## 实际通过的流程

| 范围 | 实际结果 |
| --- | --- |
| 桌面启动 | 当前构建冷启动真实 Supervisor 与管理 Host，返回可写状态；后续桌面重新打开连接同一存活服务 |
| 默认首页的副作用边界 | 打开看板不创建聊天 iframe；服务中没有测试空间被自动启动 |
| 原生聊天 | 点击聊天创建原生页面，首用声明与“稍后配置”可操作；首轮最终截图显示原生默认工作区/输入界面，没有第二个 Spaces 栏 |
| 设置与保留状态 | 常规设置、深色、English/中文、固定关闭可操作；设置及看板/聊天切换后保持同一聊天 iframe window |
| 桌面尺寸 | 实测最小内容宽度为 800px，无文档横向溢出；未证明 500px 或 450px 桌面 |
| 宿主安装 | 当前插件 tarball 经官方 CLI 装入独立普通命名 profile，安装前后没有提前创建管理器 |
| 宿主初始化 | 从真实浏览器点击初始化，在宿主内打开 contained manager，创建恰好一个管理 profile |
| 普通空间 | 创建并启动 `coding`，空间只安装 view-bridge；宿主栏进入空间并完成认证/握手，子页面显示原生首用界面 |
| 重复进入与宿主重开 | 重复进入不增建管理器；正常关闭并重新启动普通宿主，仍进入原管理器 |
| 正常关闭 | 显式 `service.shutdown` 提交一次；连接随关闭断开后，读取同一持久 job 的 succeeded、死亡 PID、失效端点和关闭端口确认结果，没有重新提交 |
| 卸载 | 同一普通命名 profile 经官方 CLI 卸载，package、bundle 和 dump-config 中的插件登记均消失 |
| 隔离与清理 | 最终再次核对三个本轮 Home，`profiles/web`、根 `sessions`、根 `storages` 均不存在；运行 owner 已释放。宿主 `forceCleaned=false`、无遗留端口；测试桌面进程已退出 |

宿主验收的 `status=pass` 只描述该安装/管理生命周期脚本的合同。它同时记录了上述 Home CORS 错误，不意味着整批新功能通过。子空间截图停在官方首用声明，不能据此声称已验证子空间发消息或业务插件执行。

## 证据与测试工具限制

- [构建日志](../.sandbox/acceptance-20260926-build.log)。
- [首轮桌面日志](../.sandbox/merged-live-20260926.log)、[原生聊天实际渲染](../.sandbox/merged-desktop-20260926-RB2aJA/failure-1.png)。首轮脚本因等待旧版“选择工作区”文案超时；实际截图已显示新的默认工作区。这一脚本断言失败不计产品聊天故障。
- [后续桌面日志](../.sandbox/merged-live-20260926-followup.log)、[设置截图](../.sandbox/merged-desktop-20260926-QKI2Dw/04-settings.png)、[最小窗口截图](../.sandbox/merged-desktop-20260926-QKI2Dw/05-narrow.png)。原始日志“500px”是请求尺寸，实际 JSON 已记录 `width=800`；最终结论按实际 800px。后续 `03-chat.png` 仍有稍后配置模态，不作为完成首用证据。
- [宿主完整日志](../.sandbox/merged-portable-20260926.log)、[结果 JSON](../.sandbox/merged-portable-20260926/results.json)、[空间握手截图](../.sandbox/merged-portable-20260926/coding.png)。原脚本标签保留了 `web` 和 `channel=latest` 文案；本轮实际配置为命名 `acceptance-host` 与精确版本 `0.1.7-alpha.1`，不代表改写默认 web 或查询 latest 标签。
- 宿主验收脚本来自当前 `scripts/verify-plugin-standard-install.mjs`，临时副本仅调整本地 import、宿主 profile 名及隔离 patch。桌面和宿主临时脚本、全部数据与截图均保存在 `.sandbox/`。
- 最初受限执行环境中 Electron GPU 子进程加载失败，未计通过；正常本机进程环境运行成功。未关闭系统/浏览器安全机制。Computer Use 的原生捕获返回空白，视觉结论采用已逐张检查的实际 Electron/Chromium 页面截图，不宣称原生前台捕获验收成功。

后续 Windows 验收必须补齐受验证的私有存储/凭据 ACL 接入和错误呈现，再运行两个真实来源空间的授权预览/取消/确认、启动发布、固定/持久化、撤权和正常关闭流程。当前记录不能替代该验收。
