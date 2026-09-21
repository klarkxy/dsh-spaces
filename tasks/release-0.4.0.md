# v0.4.0 发布验收记录

2026-09-21，用户授权“提交推送打版本”。[DSH Spaces 0.4.0](https://github.com/klarkxy/dsh-spaces/releases/tag/v0.4.0) 已于 11:40:12 UTC 公开并设为 Latest，不是草稿或预发布。

蓝图实现提交为 `2930449`，合并远端桌面正常启动修正为 `d67501a`，版本提交为 `6c0ac8484950830df77f1fa3f934aed95b4ceb97`。发布时远程 main 与标签 `v0.4.0` 指向该版本提交。根包及六个组件包统一为 0.4.0；未执行 npm publish。本记录随后的提交只补充文档，不移动发布标签。

## 验证结果

- 本地组合回归：蓝图 196 通过、4 项 Windows 文件符号链接权限跳过；桌面启动相关 55 项通过；类型检查和构建通过。源码阶段的完整证据与边界见[蓝图实施记录](blueprint-implementation.md)。
- [main CI](https://github.com/klarkxy/dsh-spaces/actions/runs/35591747156) 成功。
- [Release CI](https://github.com/klarkxy/dsh-spaces/actions/runs/35592738121) 的版本检查、Windows gate、标准插件安装 gate、Windows/macOS/Linux 构建全部成功。标准插件 gate 包含蓝图及官方模型桥回归。

Release 首次运行在 `workbench-package-upgrade.test.ts` 的临时目录清理遇到 Windows `EPERM`。失败记录保留，重新执行同一源码提交的失败 CI job 后通过；未修改源码、测试断言或标签。该 CI 重跑不是产品的失败恢复流程。

## 正式附件

从 GitHub 下载全部 10 个附件，核对文件长度与 GitHub SHA-256。三个更新清单的版本、路径、长度及 SHA-512 均与对应正式附件一致。公开后再次校验，匿名读取 Latest Release 和三个更新清单均成功。

macOS ZIP 的 blockmap 构建时名为 `DSH.Spaces-0.4.0-arm64-mac.zip.blockmap`，公开前改为与 ZIP 对应的 `DSH-Spaces-0.4.0-arm64-mac.zip.blockmap`，内容与摘要不变。后续发布仍需核对名称对应关系。

| 主制品 | 字节 | SHA-256 |
| --- | ---: | --- |
| DSH-Spaces-Setup-0.4.0.exe | 97328052 | `49f56c49eb964964759a5ae0e08bb5aa0c74246c0c6c51f29dcf278984d5d987` |
| DSH-Spaces-0.4.0-arm64.dmg | 115787120 | `a9784d350e54114d797a38bb9db705545f542949922f63c6a7385c0a89a70dcd` |
| DSH-Spaces-0.4.0-arm64-mac.zip | 115651368 | `172cc20a75933a2cf6b415e062dafbaa62fb1f1aa5ac356f90bb6848f5edfa81` |
| DSH-Spaces-0.4.0.AppImage | 123571807 | `55922dd620a5bd80c5adadb5e5b8d56f9ca568113379e0f46acff981b3eac5c0` |

## 正式 Windows 程序

从正式 NSIS 附件提取 Electron 与组件，核验运行版本 0.4.0、组件清单 schema 2 / protocol 2，以及清单内五项组件的 20 个文件摘要和长度。程序可执行文件 SHA-256 为 `728b18fbcb25a822cfd9e04ffaa9ab64e43f1b57387d58df92b577735a43370b`。

在全新隔离 Home 中，官方 CLI 安装管理插件和蓝图插件成功；预览不写入，缺少输入会拒绝；预设、停用的直接依赖、本机模型绑定均读回一致。重新生成蓝图保留占位符且不泄漏本机值，已消费的预览不能重复创建空间。

用户主动启动空间后，实际 DSH 模型目录包含绑定的模型和默认模型，主题插件加载并绘制 CSS；正常停止成功。Chromium 中粘贴、预览、创建、生成、复制分享码、保存 JSON、读取文件均通过；修改名称后旧预览失效，带 BOM 的文件被拒绝。正式 Electron 通过同一后台创建空间，创建后保持未启动；退出桌面后服务仍可用，随后主动关闭后台成功。页面错误为空，未发送模型推理请求。

再次打开正式桌面程序，正常冷启动进入可写工作台；主动关闭后台后未自动重启。完整流程和冷启动脚本均退出 0。截图已人工检查。

本机证据位于 `.sandbox/release-040/` 下的 `verification.json`、`public-verification.json`、`anonymous-verification.json`、`components-verification.json`，以及 `.sandbox/blueprint-acceptance/live/release-040-ZLDE7b/` 下的结果、日志和截图。该次结果明确标记 `artifactOrigin: github-release`。之前本地候选包的结果保留，未混作正式附件证据。

验收未访问真实 `~/.dsh`，隔离 Home 中 `profiles/web`、默认 `sessions/`、`storages/` 始终不存在。未执行 NSIS 安装登记或卸载；macOS ARM64 和 Linux 有构建与附件校验，未做本机运行交互。桌面包未签名。
