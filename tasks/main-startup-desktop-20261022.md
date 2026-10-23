# Desktop 启动 main：独立官方实例调试

日期：2026-10-22。用户授权另起 DSH Desktop 调试，不能影响日常实例。全部实机操作使用官方安装 EXE、独立 Home、独立 userData 和仓库外临时目录，调试窗口启动后隐藏；没有读取真实 `~/.dsh`、修改官方安装文件、提交、推送或发布。

## 结果

1. **全新启动时注册过早的 400 已修复。** Supervisor 先公布端点，再初始化管理器；原 `remember()` 在管理器尚未就绪时就调用 main 注册，真实响应是 `The supervisor is still initializing.`。现在在首次注册之前只读等待管理器就绪；失败停止观察，不发注册、不重试。管理器本身没有 attachment listener，不等待自己的启动。连接只在注册成功后保存，不能用半完成的连接绕过失败。
2. **main 不被后台故障遮挡已在官方 Desktop 验证。** 首屏、首次初始化后、正常退出重开后均保留 main；设置切换和重开后的输入草稿保持。注册在两个正常启动中各一次、均为 200，同一个 Supervisor 的 `serviceEpoch` 和 manager generation 1 未变。
3. **复现了原截图的 404 触发方式。** 在全新测试 Home 先安装 10-20 留存的旧包并启动 Supervisor，正常退出 Desktop，仅升级该测试 profile 的插件，再打开新版 Desktop。旧 Supervisor 仍 ready 且纪元不变，但没有新注册接口，唯一注册请求返回 404。main 仍可输入；点击设置才显示 `MAIN_REGISTRATION_REFUSED:404`，返回后草稿保留；超过后台观察间隔后仍只有一个请求。没有替用户重启或升级旧服务。这是隔离复现，不是对用户真实 Home 的版本诊断。

## 实机与制品

- 官方 Desktop / SDK：`0.2.1-rc.2`，Electron `44.7.0`，实际内嵌 Node `24.21.0`，`app.isPackaged === true`。
- 修复包 SHA-256：`2aa4f229097f5460fa0e5008d98b1c17315e0c187b787a28da6b9357c7545ac6`。
- 修复包安装后的 client、host、Supervisor 与 manifest 四个文件均和当前构建哈希一致；旧服务场景升级后的 profile 也重新核对一致。
- `cordis.patch.yml` 保留官方 `!!js` 标签，仅给测试 Home 以文本追加观察插件。观察器只记录注册操作时间、状态码及受限错误原因，不修改响应，不记录 bearer 或请求载荷。

所有相对证据位于 [调试目录](../.sandbox/main-startup-desktop-20261022/)：

| 实例 | 用途 | 关键证据 |
| --- | --- | --- |
| `run-2026-10-22T13-15-55-711Z` | 首次实机发现 400，失败后 main 和草稿仍可用 | `03-registration-failed.png`、`04-main-after-failure.png` |
| `run-2026-10-22T13-21-21-149Z` | 在第二个新 Home 确认服务端拒绝原因 | `registration-observations.json`、`02-initialization-registration-400.png` |
| `run-2026-10-22T13-32-06-467Z` | 修复包首次初始化及正常重开 | `registration-observations.json`、`loaded-payload.json`、`supervisor-before-reopen.json`、`reopen-02-settled-main.png` |
| `run-2026-10-22T13-37-05-421Z` | 旧 Supervisor + 新插件，真实 404 | `old-supervisor-before-upgrade.json`、`upgrade-payload.json`、`registration-observations.json`、`reopen-03-404-details.png`、`reopen-04-main-after-details.png` |

各实例的 `shutdown-complete.json` 记录正常关闭成功。最终 [隔离审计](../.sandbox/main-startup-desktop-20261022/isolation-audit.json) 确认：6 次测试 Desktop 启动均使用指定隔离目录且进程已退出；4 个测试 Supervisor 正常停止、端点移除；`profiles/web`、根 `sessions`、根 `storages` 均未创建；官方 EXE / ASAR 哈希未变；开始前已有的 7 个 Desktop 相关进程 PID 与创建时间均保持一致。

## 源码验证与限制

- 针对注册就绪／启动失败／注册拒绝及既有入口等待的专项 9/9。
- Node 26.10.0、官方 rc.2 SDK、外部临时根下执行完整 15 组：14 组通过；默认测试 269 通过、1 项子进程提前退出。该原测试不改超时和实现，单独复查 1/1 通过。不能把首轮描述成全绿。
- 工作台 558 通过／2 条件跳过，LLM 122/122，Chromium 13/13；清单、三组类型检查、构建和包预检均通过。[完整结果](../.sandbox/main-startup-desktop-checks-final-20261022/result.json)、[单项复查](../.sandbox/main-startup-desktop-checks-final-20261022/process-manager-recheck.log)。
- 初轮新增测试的空数组类型推断错误已修；原检查目录保留。隐藏窗口下 Playwright 截图曾超时，后来通过同一隔离进程的 `webContents.capturePage()` 取图；实际截图和可访问性树均已检查。
- 本次没有配置模型、发送模型请求或验证所有子空间能力，也没有修改用户当前运行的实例；不关闭其它 S1/P0/P1 或长期运行验收项。
