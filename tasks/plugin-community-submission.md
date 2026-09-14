# 社区分发准备（2026-09-13）

当前状态：本地预构建包已通过官方安装流程；尚未公开发布或申请目录收录。

| 字段 | 提交值 |
| --- | --- |
| 名称 | DSH Spaces |
| npm 包 | `@dsh-spaces/plugin` |
| 版本 | `0.2.0` |
| 仓库 | https://github.com/klarkxy/dsh-spaces |
| 插件子目录 | `packages/plugin` |
| 许可证 | MIT |
| 关键词 | `dsh-plugin`, `deepseek-harness`, `dsh`, `spaces`, `workbench` |
| 平台 | DSH Web；本轮实际验收 Windows / Node 24 |
| CLI | `0.1.5-rc.1`、`0.1.5-rc.2`，默认后者 |
| 简介 | 在 DSH Web 中管理多个独立空间，提供空间切换、进程管理与独立恢复入口。 |

分发单位是包含预构建客户端、Host、supervisor 和 view-bridge 的完整插件包。管理空间内置所需工具，不要求用户克隆仓库或运行 Electron。`@dsh-spaces/supervisor` 保持 private。公开仓库根目录是 monorepo，不能直接冒充可安装插件目录。

发布前剩余工作：

1. 用户在本机完成 npm 登录，并确认 `@dsh-spaces` scope 的包发布权限。现场 `npm whoami` 返回 `ENEEDAUTH`，未执行发布。
2. 将已验收代码推送到将要用于公开文档的分支，使包的 GitHub README / 文档链接可用；本轮未提交或推送。
3. 用最终验收的 tarball 发布 public npm 包，读回版本、完整性和文件列表；再从 npm 包名在全新 Home 重跑标准安装验收。
4. 为仓库添加 `dsh-plugin` 等相关 topics，并向目标社区目录提交上述信息。关键词和 topics 有助于发现，不保证任意市场自动收录；具体目录需按其规则收录后读回搜索结果。

公开发布完成后，可给目录使用的命令：

```powershell
pnpm dlx @deepseek-ai/dsh@0.1.5-rc.2 plugin --profile web add @dsh-spaces/plugin@0.2.0 --config.auto-install-peers=true
pnpm dlx @deepseek-ai/dsh@0.1.5-rc.2 web
```

以上包名命令在发布前不可用。当前本地安装命令见 [用户指南](../docs/plugin-standard-install.md)，测试证据见 [验收记录](plugin-standard-install.md)。
