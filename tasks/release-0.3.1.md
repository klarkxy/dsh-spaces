# v0.3.1 发布记录

2026-09-21，用户授权推送 main 并发布补丁版本。GitHub Release 已于 03:13:15 UTC 公开并设为 Latest：[DSH Spaces 0.3.1](https://github.com/klarkxy/dsh-spaces/releases/tag/v0.3.1)。不是草稿或预发布。

发布标签 `v0.3.1` 指向 `3345bc317d99c4e404e7f20be94a2b2aaa4a5cd9`，发布时远程 main 与该提交一致。根包与六个组件包均为 0.3.1。本记录随后的提交只补充文档，不移动已公开标签。未执行 npm publish。

## CI 与修正

- [main CI](https://github.com/klarkxy/dsh-spaces/actions/runs/35555451673)：Windows gate、标准插件安装均成功。
- [Release CI](https://github.com/klarkxy/dsh-spaces/actions/runs/35555483833)：版本校验、两个 gate、Windows/macOS/Linux 构建全部成功，均针对发布提交。
- 发布准备后的三处测试文件修正没有改变 `src/`、`packages/`、`scripts/`、包版本或锁文件。与版本准备提交 `519fc30` 的这些路径已比对一致。

此前 CI 暴露两处测试问题，保留失败记录后修正，未降低断言要求：并行 Supervisor 测试复用端口区间造成碰撞，已分离区间；运行时发布响应性测试把同步准备 900 个测试文件的时间计入发布窗口，已用明确的准备完成信号隔开。主 Agent 独立执行相关 39 项测试全部通过；在实际发布位置临时替换为阻塞 250ms 加同步 rename 的对照实现时，测试按预期失败（273ms、HTTP 心跳 0），临时源码已移出编译目录。

一次本地完整 workbench 测试有临时文件清理 EPERM：416 通过、1 失败、1 跳过；该用例单独验证通过。它不记作本地完整套件通过。上方最终 CI 在修正提交上全部通过。

## 正式附件验收

下载并校验了全部 10 个附件：四个主制品、三个 blockmap、三个更新清单。文件长度和 GitHub SHA-256 一致；`latest.yml`、`latest-mac.yml`、`latest-linux.yml` 中的版本、路径、长度和 SHA-512 均与对应下载文件一致。公开发布后再次核对，匿名读取公开 Release 和 Windows 更新清单成功。

macOS ZIP 的 blockmap 构建时名为 `DSH.Spaces-0.3.1-arm64-mac.zip.blockmap`，与更新器按 ZIP URL 追加 `.blockmap` 的路径不一致。公开前已将附件改名为 `DSH-Spaces-0.3.1-arm64-mac.zip.blockmap`，内容及摘要不变。后续发布仍需检查这一名称对应关系。

| 主制品 | 字节 | SHA-256 |
| --- | ---: | --- |
| DSH-Spaces-Setup-0.3.1.exe | 96821619 | `4b99b7f19641f19bfac7318b84433e3311444877eadbce166f49c1d521133e46` |
| DSH-Spaces-0.3.1-arm64.dmg | 114883942 | `e6aa5217fe44d5c23d04fd9eda70e014f637b38aa94aa7f0458fabb18ab0ac4f` |
| DSH-Spaces-0.3.1-arm64-mac.zip | 114730962 | `20857c75c3ad85d9fb7173e0d369e1e28d1a7730e39ceb1678d254b0156a3bbc` |
| DSH-Spaces-0.3.1.AppImage | 122624711 | `42c8d785300516cd489a6873a4ba67f8213eba043910b8304c6783fcdcc4d883` |

从正式 Windows NSIS 附件提取程序，核验内置组件版本 0.3.1、schema 2、protocol 2 和文件摘要，再用临时 Home 运行真实 Electron/Chromium 流程。初始化、共享工作台、创建空间、跨客户端数据一致、活动任务一致均通过；桌面退出后，浏览器观察同一个任务完成且没有重发；Supervisor 进程保持不变，显式关闭服务后确认进程退出。验收脚本退出码为 0。

本机证据保留在 `.sandbox/release-031-published/verification.json`、`.sandbox/release-031-published-desktop/results.json`、对应截图及 `.sandbox/release-031-published-desktop.log`；正式 Windows 组件摘要为 `226355b468973a7f7397f39c6f6b4f4ad2cf008a20d618e3f9751265cc5aa8dc`。

验收未访问真实 `~/.dsh`。本次没有执行 NSIS 安装登记或卸载；macOS ARM64 和 Linux 仅有构建及附件校验，未做本机运行交互。桌面包未签名。此前完整功能验收范围见[合并执行记录](merge-execution.md)。
