# Browser Space 本机验收（2026-10-09—10，Asia/Shanghai）

候选：`feat/minimal-space-message-bus@08f68e293d09f9ee1f156c1e053ee9d7ba9aebc8`。按用户要求 fetch 并创建远程跟踪分支；切换前工作区干净。验收阶段仅测试和记录，未修改产品源码、提交、推送或发布。验收后用户授权将工作分支及本次验收文档合入本地 `main`；授权不含推送或发布。

**结论：完整创建流程、Web 基本交互、自有桌面基本呈现通过；官方 Desktop 原生 Browser 呈现不通过。Web 拒绝嵌入时仍缺少清楚的产品提示。不能将本轮标为全部通过。**

## 环境与安装边界

- 全新目录 `.sandbox/browser-local-20261009/home` 用于 Web 和自有桌面；另一个全新 `official-home` 用于官方 Desktop。
- 官方 CLI：本机实际安装的 `0.2.0-rc.2`。Web Supervisor 按 `docs/workbench.md` 的六组件路径启动，使用本轮同组打包产物。没有覆盖或热升级任何五组件 Home。
- 自有桌面：当前源码完整构建，Electron `37.10.3`，独立 Electron userData，连接上述隔离 Supervisor。这证明当前桌面候选的连接和交互，不是 NSIS 安装或全新桌面引导验收。
- 官方桌面：只读使用本机安装的 `0.2.0-rc.2` 原始 `app.asar`、随包 DSH 和运行时资源，通过 Electron `44.0.0` 隔离包装器运行；所有 Home 和 Electron 数据路径重定向到本轮目录。未修改官方应用文件，未运行覆盖安装。此项是官方代码的隔离宿主实测，不等同于原安装 EXE 的完整引导、登录或更新验收。
- 官方插件通过其真实“插件 → 添加插件 → 安装 → 立即启用”界面安装；之后从 Spaces 设置初始化。CLI 直接操作 `desktop` profile 被正确拒绝，没有绕过此保护。
- 合成网站监听 `127.0.0.1:30989`，提供可嵌入页面、表单/计数器、页内链接及 `X-Frame-Options: DENY` 页面。未使用外部账户、凭据或模型调用。

## 结果

| 验收项 | 结果与实证 |
| --- | --- |
| 六组件构建与打包 | 通过。当前组的 payload 校验和四个 tarball 打包通过。 |
| 三套类型检查 | `tsconfig.node.json`、`tsconfig.web.json`、`tsconfig.spaces.json` 均通过。 |
| Browser / 总线专项 | Node `24.19.0` 下五个测试文件共 31/31 通过。没有重复全仓库套件或宣称既有基线债务已解决。 |
| Web 生产创建链 | 从真实工作台勾选“浏览器空间”，创建 `browser-local`，实际安装 view-bridge、Browser、llm-bridge，创建成功后保持停止；点击“进入空间”首次启动成功。持久化 create/start 作业均 succeeded，Browser-only 根页面出现。 |
| Web 地址栏 | 有效地址打开新标签；`javascript:` 被拒绝，显示错误。 |
| Web A/B/A | 页面 A 输入 `keep-web-draft` 并计数一次，打开 B 后回到 A，输入和计数 `1` 保留。 |
| Web 切换工作台 | 首页 → Browser 后输入仍保留；800px 窗口内 Browser 宽度与 scrollWidth 均为 728px，无横向溢出。 |
| Web 拒绝嵌入 | Chromium 确实拒绝 DENY 页面，没有绕过策略。可访问树有拒绝连接文字，但实际截图主要是灰底破损页面图标。产品只有通用 Web preview 文案和 Open externally，没有明确说明网站拒绝嵌入，因此提示部分不计通过。 |
| 自有桌面原生页面 | 真正生成独立 guest；A/B/A 保留 `keep-native-draft` 和计数 `1`。页内点击链接后地址栏同步 `/linked`。guest 中 require/process/dshSpaces/dshDesktop 均为 undefined。 |
| 自有桌面隐藏租约 | 切回首页等待 3.5 秒后 A、B guest 均关闭；返回 Browser 重新加载原始 `/a`。证实文档约 2.5 秒租约限制，长时间离开不保留页面和临时会话。 |
| 官方 Desktop 安装/创建/启动 | 安装、启用、初始化、正常重开保留空间栏，UI 创建 `official-browser` 并从设置显式首次启动成功；create/start 作业均 succeeded。 |
| 官方 Desktop 网页呈现 | **失败**。稳定页面提交有效地址后生成标签页，但显示 `Native Browser is unavailable.`；仍停留 `Opening native Browser page…`，没有对应网页 guest。 |
| 正常关闭与隔离 | 两个 Supervisor 的 `service.shutdown` 预览/执行作业均 succeeded，测试窗口、站点及驱动已清理；核验的 11 个监听端口全部关闭。两 Home 的 owner/endpoint 均消失。 |

## 已确认的问题

1. **官方 Desktop 原生 Browser 路径未接通。** `packages/browser/src/client.tsx` 以 Electron UA 和嵌入状态选择原生模式；manager 通过 `packages/plugin/src/workbench/browser-relay.ts` 向顶层发送本项目的 relay。对应 preload/IPC/guest 处理位于自有 shell 的 `src/preload/browser-guest.ts`、`src/main/view-manager.ts` 等。实际官方宿主没有完成这条呈现链。有效 URL 的标签状态已经建立，呈现仍报 unavailable，不能记为地址校验或安装失败。
2. **Web 拒绝嵌入缺少清楚的可见说明。** 截图中只有浏览器破损图标，通用文案只解释地址不跟踪跳转；没有针对拒绝嵌入的产品提示。跨源限制下如何提供准确、不猜测原因的说明仍需设计/修复。
3. **官方深色宿主中的标签对比度不足。** 截图里 Home 标签文字接近白色，而 Browser 自身使用浅色背景，文字难以辨认。此为该宿主截图观察，尚未扩展完整主题/无障碍矩阵。

未在本轮修复产品问题。Terminal、五组件迁移、正式发行包、跨平台和长期运行仍不属于此次验收。

## 测试环境差异与排除项

- 受限沙箱首次 Electron 构建出现 realpath EPERM；正常权限下同一源码完整构建通过。
- 默认 Node `26.10.0` 已移除测试夹具使用的 `--experimental-transform-types`，导致总线测试子进程无法启动；既有 Node 24 下 31/31 通过。这是可复现的测试运行时兼容问题，未更改断言或产品代码。
- 开发 Electron 二进制起初缺失，运行仓库现有依赖准备脚本后使用 `37.10.3`，没有修改版本声明。
- 官方隔离宿主初始默认端口 19387 被占用，后续测试配置独立 19479；首个失败日志保留。官方测试包装器的版本元数据、初始欢迎窗口和调试连接问题已单独处理，最终使用普通进程启动并显式显示主窗口。没有登录、提供密钥或调用模型。
- 首次官方 URL 测试紧邻切页，实际请求体为 `url: ""`，属于测试操作竞态，不算产品导航失败。稳定页面独立输入有效地址后，最终复现的产品失败是 **Native Browser is unavailable**。
- 正常 Web 唯一非预期资源错误是 favicon 404；DENY 页面产生的浏览器错误是该场景预期结果。

## 证据

本地证据目录：`.sandbox/browser-local-20261009/`（不纳入发行包）。

- `web-aba.png`、`web-800.png`、`web-blocked.png`、`web-retention.txt`。
- `desktop-check-result.txt`、`native-aba-guest.png`、`native-manager.png`。
- **`official-native-unavailable.png`** 为最终官方整窗失败截图；`official-browser-window.png` 是先前空地址操作的截图，不用来证明最终失败。
- `home-state.json`、`official-home-state.json`、两份 `*-shutdown.json`、`integrity-and-cleanup.json`；截图、请求和 Playwright 输出保留于同目录及 `playwright-evidence/`。
- `node24-tests.log` 为 31/31；`focused-tests.log` 保留 Node 26 夹具失败。
- 当前 manager tarball SHA-256：`331756dba54d325a64247ef82d234133d823b72b5a558415fbc5bc35b5d39315`；Browser：`e38da5a8cf657b001a7f7ba60e5873ac8f6db3ba2c3f84b6d826426b18f22815`。完整包哈希见最终核验 JSON。

两个隔离 Home 均确认未创建 `profiles/web`、默认 `sessions` 或默认 `storages`。真实 `~/.dsh` 未读写；原安装和用户数据未覆盖。所有失败现场保留，没有添加或调用恢复工作流。
