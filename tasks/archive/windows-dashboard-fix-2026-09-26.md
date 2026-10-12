# Windows 看板与 DSH Web 发布前修复（2026-09-26）

结论：**本轮问题已修复，最终构建的标准 Web 与双空间发布实机验收通过。** 本轮处理 [原验收](web-release-acceptance-2026-09-26.md) 的 Windows 看板 501 和 CORS 缺失，以及复核中发现的并发、提交权限和导航竞态。

验收候选为 `main@990cc80faf65d5335c6c330cb1470ab925ccc4f3` 加当时未提交的改动，用户原有 Desktop/头像工作保留。验收时未修改真实 Home、升版、提交、推送或发布；现已分批本地提交，仍未升版、推送或发布。

## 当前实现

- Windows 看板存储和私有发布 bootstrap 接入 SID/ACL 校验，移除直接拒绝 Windows 的分支；现有危险权限不修补，路径、链接和文件身份继续校验。
- 当前管理 Origin 在缺失或已关闭的看板服务上也能读取认证后的不可用错误；预检只允许约定路由及头部，普通空间、旧管理来源和内部 bearer 路由未获得新权限。
- 存储共用一个按需启动、随存储关闭的异步权限校验子进程，每次操作重新检查实际 ACL。无权限缓存、重启、重试或失败任务重放。启动失败、意外退出、协议损坏及超时均终止该次生命周期。
- 提交前重新检查当前运行实例/授权、布局写权限或管理计划权限。异步等待期间停止空间或失去权限，旧请求不会继续落盘；清理失败也不恢复已提交的撤权。
- Web 失败消息恢复原有严格字段格式，保留原生 Desktop 所需字段。进入空间时一次性读取当前状态，避免内外轮询状态不同步造成即时拒绝；新外层选择、内层 Home/空间选择或视图代次变化会使迟到结果失效。导航不会启动空间或自动重试。
- 复用并扩展真实 Supervisor 验收脚本，修正 Windows 包管理器执行方式、统一隔离缓存；新增浏览器固定/移除、窄屏、撤权和重开验证。CI 增加 Windows 私有文件、helper 生命周期和 CORS 检查。

依赖选择先检查了现有工具和 npm/GitHub：已有原子写工具不能证明 Windows ACL，进程沙箱包不是私有文件适配器，旧安全插件只有 SID/所有者查询能力。本轮使用系统 Windows PowerShell/.NET，不增加运行时 npm 依赖；固定脚本嵌入独立包，不依赖源码目录中的辅助文件。

## 最终验证

| 检查 | 结果与范围 |
| --- | --- |
| Windows 组合回归 | 235 项：234 通过、1 跳过、0 失败；覆盖权限、校验进程故障、实际文件提交竞态、看板、Supervisor、维护、交接和重开 |
| 最终导航与界面专项 | 79/79 通过，包含旧状态、已停止空间、迟到外层响应和新内层 Home 选择 |
| Ubuntu POSIX 回归 | 48 项：43 通过、5 项 Windows 专用检查跳过、0 失败；运行于 WSL 独立 `/tmp` 目录，没有以 Windows 模拟 POSIX |
| 类型与构建 | node/web/spaces 三套检查、独立 dashboard-home 检查、build-spaces、独立 dashboard 包构建及差异格式检查通过 |
| 8 个独立发布进程 | 两轮 16/16 更新获确认，最终值读回正确；两轮最大耗时 338/158ms，事件循环最大延迟 52ms，独立 HTTP 最大 9ms，无失败或清理残留 |
| 标准 Web 安装 | 当前 tarball 经官方 CLI 安装；浏览器初始化、正常看板、创建/启动/进入空间、重复进入、宿主重开、后台正常关闭和卸载全部通过；`forceCleaned:false`、`leftoverPorts:[]` |
| 两个真实 DSH Host | 独立打包安装 dashboard 与测试业务插件，实际 Supervisor 授权并启动；两个空间发布到同一看板，浏览器键盘移除/按钮固定、800px 布局、停止、撤权隐藏和重开持久化通过；关闭后无遗留凭据和运行权 |

Windows 为 Node 24.16.0、官方本地 DSH CLI 0.1.7-alpha.1、真实 Chromium；未重新宣称该 CLI 为官方最新版本。POSIX 为现有 Ubuntu Node 22.22.1，测试编译器仅放在隔离目录，下载包已校验 npm SHA-512。

最终标准 Web 插件 SHA-256：`21572ed468e88c5f9746a722608f1ffe052518f798ec056699db24e37f997e84`。测试使用全新隔离 Home，默认 `profiles/web`、`sessions`、`storages` 未创建；没有复制真实数据或调用模型。

## 证据

- [最终标准 Web 结果](../../.sandbox/windows-dashboard-web-accepted/results.json)、[日志](../../.sandbox/windows-dashboard-web-accepted.log)、[首页截图](../../.sandbox/windows-dashboard-web-accepted/home-dashboard.png)
- [最终双空间实机结果](../../.sandbox/windows-dashboard-native-accepted/result.json)、[双空间截图](../../.sandbox/windows-dashboard-native-accepted/two-published-cards.png)、[800px 截图](../../.sandbox/windows-dashboard-native-accepted/dashboard-800.png)、[撤权后截图](../../.sandbox/windows-dashboard-native-accepted/revoked-source-hidden.png)
- [独立 8 空间并发结果](../../.sandbox/review-dashboard-concurrency-result.json)
- [Windows 组合检查](../../.sandbox/windows-dashboard-final-regressions.log)、[最终导航检查](../../.sandbox/windows-dashboard-selection-tests.log)、[POSIX 检查](../../.sandbox/windows-dashboard-posix-final.log)
- [提交竞态检查](../../.sandbox/windows-dashboard-commit-races.log)

独立审查曾拒绝同步权限实现：8 个发布者全部超时，事件循环阻塞约 6.7 秒；随后又验证了实例停止后的提交竞态和内层 Home 被迟到选择覆盖的问题。对应修正均经独立复核关闭。早期测试还记录了受限权限无法结束测试进程、包缓存不一致、页面定位错误和真实宿主握手失败；原始失败记录均保留，不把旧候选的成功代替最终候选证据。

## 已知限制与发布边界

- 一个额外的“外部 SID 为文件所有者”反向测试需要当前账户不具备的赋值权限，明确跳过；当前 SID、宽 ACL、null DACL、链接和实际身份检查均已执行。
- Windows 保留文件 fsync 和原子改名，但 Node 不支持目录 fsync，不承诺断电后的目录元数据持久性；POSIX 继续刷新目录。
- 单次 bootstrap 交付/销毁仍采用同步校验，单次调用有 10 秒上限；并行测试负载下观察过一次约 8 秒耗时。热发布路径已异步化，本轮不宣称所有启动/停止操作都无阻塞，也不代替长期压力验收。
- 本轮是本地源码/插件制品验收；未发布新版本、未验证签名安装程序，不把 Linux 文件回归等同于 Linux/macOS 完整产品实机验证。真实 Host 的发布数据来自测试业务插件；没有模型调用。
- 多智能体处置记录及收尾检查通过；该审计切片不包含完整运行时模型/成本元数据，产品结论以本页测试与实机证据为准。
