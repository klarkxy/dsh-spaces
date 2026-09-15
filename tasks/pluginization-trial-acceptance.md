> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# 插件化可分发试用验收

日期：2026-09-12。分支：`codex/spaces-pluginization`。本轮落实前次建议的“先补齐可分发试用”，Phase 2/3 功能边界保持不变。

后续补验：[裸 DSH Web 多主题验收](pluginization-themes-acceptance.md) 将正式安装与浏览器验证合并在同一 profile，测试四个真实主题；三种界面渲染成功，两个能进入 Spaces，发现 XP 入口遮挡、Catppuccin 客户端不兼容和 EternalNight 欢迎区对比度缺陷。这里原有试用通过结论不代表任意社区主题均兼容。

## 本轮交付

- 插件提供中文与英文。默认跟随浏览器语言，面板内可切换；名称、包名和用户数据保持原文。侧栏名称跟随浏览器语言，面板内切换不修改宿主全局语言。
- 接入原生 `dsh.bundle.patch`。正式 `dsh plugin add` 会自动启用 Spaces，无需再手写 Loader insert；卸载移除 bundle，原 profile 能继续使用。
- 完整安装、同版本替换、卸载验收脚本；补齐 `snapshotRoot` 的可选 id-only 配置文档。
- Windows NSIS 安装包已生成，并从该安装包提取实际应用执行打包模式验收。

Grok 承担客户端、分发脚本、bundle 和桌面验收脚本施工；Codex 负责接口与文件所有权、实际构建、独立审计和运行验收。Bridge 回执确认 Grok `grok-4.6`；首批请求 high，两个边界明确的后续任务请求 medium，其中分发续接回执仍报告 observed high，因此不将请求值冒充实际值。没有调用 Kimi 或其他施工模型。

## 独立验证

| 项目 | 实际结果 |
| --- | --- |
| 插件相关回归 | 89 项通过，0 失败/跳过，含新增 6 项语言覆盖；`.sandbox/pluginization-distribution-tests.log` |
| TypeScript 与构建 | 插件类型检查与三包构建通过；桌面构建和 Windows NSIS 打包通过 |
| 中文/英文真实浏览器 | 默认中文创建及验证成功；切英文后保留选择并再次验证；官方新会话入口正常，页面错误为 0；`.sandbox/pluginization-chinese-web-runtime.log` |
| 正式安装 | 最新 tarball 经 `dsh plugin add` 安装；自动加入 bundles，未手动 insert 已出现 `id: dsh-spaces`；真实 Host RPC 正常 |
| 快照配置 | id-only `snapshotRoot` 覆盖生效，notes 读取到属于本 Home 的 fixture 快照 |
| 替换 | 同一 0.2.0 tarball 重新 add/force 后保持启用，RPC 正常；这不是跨包版本升级 |
| 卸载 | coding 的包依赖、bundle、组合配置行消失；保留可选 id-only 覆盖时，官方 `session/list` 正常，`spaces/overview` HTTP 404 |
| 未知版本 | 实际 CLI `0.1.5-rc.2` 启动插件后为 `unknown-readonly`；创建和验证已有非宿主空间均明确返回 `spaces/read-only`；Home 配置指纹不变 |
| Windows 安装包载荷 | `app.isPackaged=true`，中文主窗口可见，从侧栏打开 coding 后呈现认证的官方界面；重启、保存读回、停止、退出通过，两个端口均关闭 |

兼容运行环境是 CLI `0.1.5-rc.1` / SDK `0.1.5-rc.2`。未知版使用真实安装的相邻 CLI，没有改 manifest 假造版本。所有验收使用独立 Home、userData、工具链或缓存，没有读取/改写生产 DSH 数据，没有输入 API key 或调用模型。

原有 180 项桌面测试沿用 2026-09-11 的通过基线；本轮没有修改桌面产品源码，补的是实际打包与 UI 验收，不把历史测试称为本轮重跑。

## 安装包与证据入口

- 插件：`.sandbox/pluginization-delivery/dsh-spaces-plugin-0.2.0.tgz`；与正式分发验收使用的 tarball 字节一致。
- core / doctor：同目录下 `dsh-spaces-core-0.2.0.tgz` 与 `dsh-spaces-doctor-0.2.0.tgz`。
- Windows：`.sandbox/spaces-windows-distribution/DSH Spaces Setup 0.2.0.exe`。验证的是这个安装包中的应用载荷；没有执行安装向导或测试系统注册、快捷方式、操作系统卸载流程。
- 分发结果：`.sandbox/spaces-distribution-acceptance/{results.json,tarball.json,unknown-version.json}`，运行日志 `.sandbox/pluginization-distribution-runtime.log`。
- Web 截图：`.sandbox/spaces-plugin-acceptance/spaces-sidebar.png`。
- 打包桌面结果与截图：`.sandbox/spaces-desktop-acceptance/{results.json,window.png,coding.png}`。

验收入口：`npm run validate:distribution`、`npm run validate:plugin`、`npm run validate:desktop`。运行所需的实际 CLI、Playwright、Node/pnpm fixture 及环境变量见对应脚本和施工记录。

## 仍需区分的边界

- 上游 CLI `0.1.5-rc.1` 在 Windows 转发 pnpm 时丢失含空格路径的参数边界；README 指导使用无空格绝对路径。验收脚本只复制相同字节的 tarball 到隔离安全路径，再用正式命令安装，不通过手解包绕过安装。
- 尚未执行跨插件包版本升级、NSIS 系统安装/卸载、macOS/Linux 验收；未发布 npm 包或 GitHub Release，未推送。
- standalone recover/rollback 与快照恢复：**已撤销**（2026-09-15），不是后续阶段工作。R5 要使旧命令返回不支持和非零退出。
- 仍可后续推进且不含恢复：Web 启停、插件变更、运行时安装/升级（提交前失败不切换指针；提交后不回退）、多实例嵌入。
- `snapshotRoot` 未配置时明确显示不可用；本地 file: 安装的版本字段显示未知，避免向浏览器暴露磁盘路径。
