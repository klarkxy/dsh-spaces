> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# Spaces 使用介绍录像（叶子交接）

日期：2026-09-12。分支 `codex/spaces-pluginization`。Grok 施工，主 Agent 编排验收。本叶只新增录制脚本、本记录和 `.sandbox/spaces-demo-video/**`；未改产品源码、既有验收脚本、包清单或 Git。未调用 mmx / 配音。未碰生产 `~/.dsh`，未输入 API key，未发模型消息。

专用 Home：`.sandbox/spaces-themes-acceptance/home`（保留，未删除重建）。通过 Spaces UI 创建唯一演示空间 `video-demo-080906`（显示名 `演示空间 080906`），隔离验证通过。

## 结论

六章均为 Playwright Chromium 真实打开裸 DSH Web 的 `recordVideo` 1920×1080 webm，不是截图拼片或模拟安装。Host 串行启动；每章 `finally` 关 context 落盘视频；子进程 `taskkill /T` 后端口已关。URL token 已 redact。

复跑：

```
"D:/Program Files/nodejs/node.exe" scripts/record-spaces-demo.mjs
```

只补某一章：`DSH_TEST_DEMO_CHAPTERS=05-xp-desktop-session`（会与已有 `results.json` 合并，不再新建 profile）。

## 章节

| 章 | 文件 | 字节 | 时长 | trimStartSec | trimEndSec | 状态 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 竹青欢迎 + Spaces 列表/宿主 | `.sandbox/spaces-demo-video/chapters/01-zhongguo-welcome-spaces.webm` | 491716 | 13.72s | 4.115 | 13.805 | recorded |
| 2 UI 创建并验证隔离 | `.sandbox/spaces-demo-video/chapters/02-zhongguo-create-verify.webm` | 1018674 | 21.32s | 4.063 | 21.081 | recorded |
| 3 主题 profile 插件清单 + 中英 | `.sandbox/spaces-demo-video/chapters/03-zhongguo-plugins-i18n.webm` | 1320234 | 30.60s | 4.079 | 26.933 | recorded |
| 4 EternalNight 壁纸 + Spaces | `.sandbox/spaces-demo-video/chapters/04-eternalnight-wallpaper-spaces.webm` | 1047417 | 14.00s | 4.203 | 14.180 | recorded |
| 5 XP 桌面 → 空 workspace iframe | `.sandbox/spaces-demo-video/chapters/05-xp-desktop-session.webm` | 3774480 | 32.56s | 5.202 | 31.304 | recorded |
| 6 Catppuccin 真实失败页 | `.sandbox/spaces-demo-video/chapters/06-catppuccin-failure.webm` | 63903 | 4.32s | 1.513 | 4.639 | recorded（限制素材） |

完整 marks / 截图路径：`.sandbox/spaces-demo-video/results.json`、`timeline.json`、`marks/*.png`。

## 创建 profile

- name：`video-demo-080906`
- displayName：`演示空间 080906`
- 路径：`.sandbox/spaces-themes-acceptance/home/profiles/video-demo-080906`
- UI 创建成功；点「验证隔离」后文案为「隔离与当前组合配置一致。」
- 诊断里仍有 `SNAPSHOTS_UNAVAILABLE` / `ISOLATION_FILE_ONLY`（未配 snapshotRoot），与验收矩阵一致，不是失败。

## 操作时刻（相对各章视频起点）

**01** goto 0.318 → welcome-new-session 4.129（竹青 `rgb(239,248,241)`）→ spaces-list-host 9.676（`theme-zhongguo` + 宿主）。列表截图拍到详情仍在加载；片尾 hold 可看到列表本身。

**02** goto 0.274 → spaces-before-create 5.231 → form-filled 7.618 → create-clicked 8.887 → create-success 10.862 → verify-passed 16.960。

**03** goto 0.293 → host 插件（`dsh-theme-plugin@0.3.3`）6.751 → `theme-eternalnight` 插件 12.232 → English 17.526 → 中文 22.806。

**04** goto 0.279 → wallpaper-welcome 4.220（官方 `/dsh-theme/assets/import-images/default.png`）→ Spaces 10.074。

**05** goto 0.321 → 根页稍后配置后 xp-desktop 5.208 → 双击工作区 11.161 → 文件夹 15.094 → 新建会话 18.937 → iframe 欢迎（xp-empty-workspace，无侧栏「空间」）22.067 → 观察不可达 26.722。根页面「空间」按钮 `box.x=-9987`（侧栏被桌面主题移出视口）；iframe 内「空间」不可见。未 force 点击，未改产品 CSS。

**06** goto 0.285 → Failed to load plugins 1.513，停留约 3s。错误为缺少 `@deepseek-ai/dsh-client-runtime/client`。

## 错误 / 未录项

- `results.json`：`status=recorded`，`errors=[]`，`unrecorded=[]`。
- 第 5 章第一次因根页 API Key 遮罩失败（桌面已出现就提前结束 skip）；脚本改为先点「稍后配置」，并在 iframe 新会话里再点一次。当前 `05-*.webm` 是成功 take，覆盖了失败片。
- 未录：安装过程、Electron、配音、模型回复、生产 Home。Catppuccin 没有成功 Mocha 界面（已知客户端失败，按计划只录失败页）。

## 主 Agent

- 配音与合成用上述 webm + `trimStartSec`/`trimEndSec`；不要把 onboarding / API key 弹层当正片。
- 不要把 XP / Catppuccin 限制做成「已修好」。
- 日志里的本地 URL 不代表 Host 仍在跑。
