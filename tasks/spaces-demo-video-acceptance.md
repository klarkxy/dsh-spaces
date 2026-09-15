> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# DSH Spaces 使用介绍首版试录

2026-09-12，分支 `codex/spaces-pluginization`。按用户要求制作一版可观看的介绍视频，不设固定时长；实际成片 138.27 秒（约 2 分 18 秒），1920×1080，H.264 + AAC，8,523,248 字节。

## 成片与可编辑素材

- 成片：`.sandbox/spaces-demo-delivery/DSH-Spaces-first-cut.mp4`。
- 本地分章播放器：`.sandbox/spaces-demo-delivery/index.html`。
- 独立字幕：`.sandbox/spaces-demo-delivery/DSH-Spaces-zh.srt`。
- 独立配音：`.sandbox/spaces-demo-delivery/DSH-Spaces-narration.mp3`。
- 剪辑清单：`.sandbox/spaces-demo-delivery/edit-manifest.json`，记录每章源文件、入出点、速度调整和最终起点。
- 原始分章录像：`.sandbox/spaces-demo-video/chapters/*.webm`；原始配音及 MiniMax 字幕：`.sandbox/spaces-demo-audio/`。

| 起点 | 内容 |
| --- | --- |
| 00:00 | 从原生 DSH Web 打开 Spaces，查看列表和宿主 |
| 00:20 | 实际创建演示空间并验证隔离 |
| 00:44 | 查看各空间插件，切换英文和中文 |
| 01:07 | EternalNight 壁纸与 Spaces，说明对比度问题 |
| 01:27 | XP 桌面进入聊天窗口，说明 Spaces 入口限制 |
| 01:53 | Catppuccin 实际失败页与当前兼容边界 |

## 施工与独立验收

Grok 负责录制脚本及实际操作录像；任务 `task_39f02d8ad4`，Bridge 回执为 `grok-4.6 / medium`。Codex 负责解说内容、本机 mmx 调用、合成与独立检查。Bridge 的共享目录变更列表会包含同时发生的主 Agent 编辑，不能据此把配音和合成脚本归为 Grok 所写。

录像来自专用 Home 中真实运行的 CLI `0.1.5-rc.1` / SDK `0.1.5-rc.2`。通过 UI 创建 `video-demo-080906`，显示名 `演示空间 080906`；主 Agent 查看实际成功与隔离验证截图。XP 根页面和 iframe 的首次配置弹层均通过正常按钮处理后补录，没有输入 API key、发送模型消息或修改生产 Home。

本机 `mmx-cli 1.0.25` 使用原有 MiniMax 配置，`speech-2.8-hd`、`Chinese (Mandarin)_Gentleman` 音色、1.05 倍语速生成配音。初始 `auth status` 把请求失败显示成未登录，后续实际 quota、voices 和语音请求成功，未重新登录或修改认证文件。API key 未传给工作子代理。

主 Agent 已检查六章真实录像的阶段截图和最终视频逐章抽帧，确认中文标题/字幕可见、无遮挡的 XP 聊天窗口、创建和验证成功画面。最终 MP4 在 Chromium 中实际加载并播放，1920×1080、138.267 秒，无媒体错误；全文件音视频解码退出码 0，错误日志为空。六段 MP3 的时长、编码和采样率已核对，首段音量检查未发现削波或长静音。自动播放检查为静音模式，没有完成整段人工听审。

字幕使用 MiniMax 返回的粗粒度时间戳，按文本长度拆成易读短句；它是首版近似对齐，不是逐字强制对齐。短章做适度慢放并停留真实末帧以容纳解说，原始录像仍保留。当前版本保留全界面，部分按钮文字较小，后续可按观看反馈增加局部放大、调整语速和缩短失败页说明。

## 复跑

录制入口：`scripts/record-spaces-demo.mjs`（Node 22.18+ 或 24+）。它依赖已建立的专用主题 Home；完整复跑会通过 UI 新建一个演示空间。仅补章可设置 `DSH_TEST_DEMO_CHAPTERS`，详见 worker 记录。

合成入口：`scripts/assemble-spaces-demo.mjs`。配音稿：`tasks/spaces-demo-narration.json`。修改配音稿后需用本机 mmx 重新生成对应章节 MP3/SRT，再合成。合成脚本本身不调用模型。

完整 FFmpeg 便携构建来自 [FFmpeg 官方下载页](https://ffmpeg.org/download.html) 所列的 [gyan.dev Windows 构建](https://www.gyan.dev/ffmpeg/builds/)，下载 SHA256 `fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9` 与发布方校验值一致，存放在 `.sandbox/spaces-demo-tools/`，未安装到系统。可通过 `DEMO_FFMPEG_DIR` 指定含 ffmpeg.exe / ffprobe.exe 的目录。

此轮未修改产品功能、提交推送或发布视频；录制服务已关闭，隔离 Home 和剪辑素材保留。媒体在本地忽略目录，不随 Git 自动分发。
