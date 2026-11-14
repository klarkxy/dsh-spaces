# 2026-11-10 Desktop Web authentication failed：本机 Cookie 累积

## 范围与结果

用户报告退出并重开 Desktop 后出现 `desktop welcome: Web authentication failed`，随后明确授权修复，并说明真实 `.dsh` 允许读取、禁止写入。本次仅修改 AppData 内 Desktop 浏览器的 Cookie 数据库；未写真实 `.dsh`、未禁用插件、未修改官方 EXE/ASAR、未启动日常 Home。

已清除本次启动阻塞的直接条件。官方 Cookie 累积机制和错误报告实现未修改，因此不宣称永久解决或真实 Home 启动验收通过。

## 证据

- 安装版为 `@deepseek-ai/dsh-desktop 0.2.2-rc.1`，Electron 44.7.0、Node 24.21.0。原报告时间为北京时间 2026-11-10 18:07:03。
- 安装版 `lib/main.js:20382` 先通过 Node fetch 换取认证 Cookie；`:20386` 随后经 Electron net.fetch 连接欢迎页。`:16856` 将任何非成功响应统一报告为 `Web authentication failed`，未记录 HTTP 状态码。
- Desktop 浏览器数据库中有 71 个 `127.0.0.1` DSH Cookie，名称、值及分隔符合计约 16,019 字节。Cookie 以端口派生名称，但浏览器按主机发送，因此多次不同端口启动遗留的 Cookie 会一起进入请求。
- 仅用官方基础组合的新隔离 Home 启动成功；在隔离 Home 加入共享 npm SDK 链接层同样成功。该依赖布局差异不是本次根因证据。
- 在全新隔离 Desktop 数据目录加入 71 个虚构 Cookie，欢迎页请求返回 HTTP 431，并复现原报错。进一步使用符合 DSH 名称和载荷结构、签名虚构的 71 个 Cookie 也复现。
- 对该隔离目录执行定向清理后，在同一个目录重新发起一次测试启动，认证及 productAnalytics、settings、LLM、credentials、account 请求均返回 HTTP 200，欢迎页正常打开。测试程序随后正常退出。
- 前期探针先后遇到空 `Response.url` 和调试求值环境模块加载限制；这些是诊断脚本错误，未作为产品失败证据。最终探针用 `process.getBuiltinModule` 写入脱敏日志。

## 本次处置

清理前确认 Desktop 已退出，数据库没有活动 WAL/journal。逐项校验 Cookie 的主机、路径、名称与载荷 authority 对应关系；只对连接结果明确为 `ECONNREFUSED` 的端口执行清理。存活、未知或格式异常条目保持不动。

原数据库先完整备份并核对 SHA-256 与 SQLite 完整性；删除在单次 SQLite 事务内执行，发布前核对未选中行的内容哈希。现场 71 项全部符合清理条件，删除 71 项，剩余 0 项，`quick_check=ok`；之后从最终位置再次只读核对，已无本机 DSH Cookie。

备份保存在原数据库旁：

`%APPDATA%/@deepseek-ai/dsh-desktop/Network/Cookies.before-stale-cleanup-2026-11-10T10-36-53-888Z`

本机验证材料位于 `.sandbox/desktop-auth-20261110/`。`production-cleanup.json` 只含计数、路径与完整性结果，不含 Cookie 值；`probe-1794306928559/requests.jsonl` 保留同一隔离目录清理前后的 431/200 对照。备份含认证信息，仅留本机，不应随问题报告上传。

## 验证边界

本次未改产品代码，未运行产品全量类型、构建与测试组；采用官方 Desktop 的隔离前后对照和实际数据库完整性验证。日常应用未由代理启动，因为正常启动会写真实 `.dsh`。需要用户正常打开后确认现有插件组合及 Spaces 页面。

持久修复需在 Desktop 的本机认证请求/Cookie 生命周期以及错误报告中处理；本次没有向官方安装加入补丁、自动清理、自动重启或重试。
