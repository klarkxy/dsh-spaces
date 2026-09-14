# 裸 DSH Web 多主题验收

日期：2026-09-12。分支 `codex/spaces-pluginization`，本轮起点 `646f2ac4c4b0a46244f16447acb5ab76cd68ffa2`。实际验证已执行：4 个真实主题分别安装到独立 profile，其中 3 个呈现了不同界面，2 个能从界面进入 Spaces；并非全部兼容。

Grok 负责候选主题核实、验收脚本施工及依赖安装顺序试验（`task_0c828b8e39`、`task_1e2375d69a` / `sess_b91f17aa60`，Bridge 回执为 Grok 4.6 / medium）。Codex 负责实际串行运行、脚本审计修正、截图审查、隔离检查和最终结论。全部使用专用测试 Home；不用 Electron、不输入 API key、不调用模型、不改生产配置。

## 实际结果

| 主题 / 安装版本 | 独立 profile | 裸 Web 聊天界面 | Spaces 界面及视觉审查 |
| --- | --- | --- | --- |
| [中国传统色](https://github.com/nevertoday/dsh-theme-plugin) `dsh-theme-plugin@0.3.3`，竹青浅色 | `theme-zhongguo` | 通过：浅绿纸色，官方 `#theme=zhuqing-light` | 通过：原生 token 同时作用于侧栏和面板；文字清晰 |
| [EternalNight](https://github.com/EternalNight996/dsh-theme) `@eternalnight/dsh-theme@0.5.1` | `theme-eternalnight` | 壁纸实际加载；深色欢迎文字落在深色图上，存在对比度缺陷 | 入口与面板通过；面板采用浅色侧栏 token，阅读正常，未显示聊天壁纸 |
| [Windows XP](https://github.com/SamizuHM/dsh-client-ui-theme-xp) `dsh-client-ui-theme-xp@0.1.1` | `theme-xp` | 通过：真实桌面、任务栏、工作区窗口；新建会话在同源 iframe 中显示 | 不通过：桌面拦截根页面 Spaces 按钮，iframe 侧栏被隐藏；Host RPC 正常不能替代界面可用 |
| [Catppuccin](https://github.com/zhijun-dai/Catppuccin-dsh-theme) `dsh-catppuccin@0.2.3` | `theme-catppuccin` | 不通过：客户端模块表缺少 `@deepseek-ai/dsh-client-runtime/client`，显示插件加载失败 | Host/RPC 在调整安装顺序后正常，但整个客户端仍不能加载，未获得 Mocha 成功截图 |

截图均来自 Playwright 实际打开的裸 DSH Web，主 Agent 已逐张查看。没有注入替代主题 CSS、强制点击被遮挡按钮或伪造主题成功状态。XP 新建的是专用空目录中的空会话，未发送提示词。

## 截图

竹青聊天与 Spaces：

![竹青聊天](../.sandbox/spaces-themes-acceptance/zhongguo/chat.png)
![竹青 Spaces](../.sandbox/spaces-themes-acceptance/zhongguo/spaces.png)

EternalNight 聊天与 Spaces（最终复开）：

![EternalNight 聊天](../.sandbox/spaces-themes-acceptance/eternalnight/chat.png)
![EternalNight Spaces](../.sandbox/spaces-themes-acceptance/eternalnight/spaces.png)

XP 已进入官方聊天，但 Spaces 入口被遮挡：

![XP 聊天](../.sandbox/spaces-themes-acceptance/xp/chat.png)

Catppuccin 的真实失败页：

![Catppuccin 加载失败](../.sandbox/spaces-themes-acceptance/catppuccin/failure.png)

## 安装与隔离证据

- 运行 CLI `0.1.5-rc.1` / SDK `0.1.5-rc.2`，每个主题通过正式 `dsh plugin add` 安装其发布版本；Spaces 使用实际分发 tarball，自动 bundle 启用。正式安装和浏览器验收在同一 profile 完成。
- Spaces tarball SHA256：`cdf22eea35eb074c3e948fd595dbda2840ceef968950169bad4c0912d51fee1b`。Windows 路径含空格问题通过复制相同字节到安全临时路径处理。
- Home：`.sandbox/spaces-themes-acceptance/home`。四个主题 profile 的直接依赖各自只有 Spaces 和自己的主题；继承官方 base/web bundles。`web`、`notes` 无主题或 Spaces 依赖。最终逐个读取清单并断言，结果存于 `final-profile-matrix.json`。
- 安装时验证 session/storage 配置隔离；运行时核对主题和 Spaces 的启用清单、准确的 `hostSpaceId`、其他 profile 可见。此轮没有执行模型消息与消息数据隔离验收。
- 安装竹青主题后，以保留 Home 模式重新启动 EternalNight；自己的壁纸、Host 身份、Spaces 入口仍正常，页面错误为 0，未出现 XP 标记。竹青背景 token 为 `rgb(239,248,241)`。未发现本轮主题配置跨 profile 污染。
- 所有测试 Host 已停止，最终复查端口关闭。Home、锁文件、已安装包与截图保留；截图中的本地地址不代表服务仍运行。

## 发现的兼容风险

Catppuccin 的旧 SDK peers 与当前预发布 SDK 不兼容。最初先装主题并启用自动 peers，旧 `typert-protocol@0.1.0-rc.8` 被提升，导致 Spaces Host 缺少 `RemoteError` 导出。先装 Spaces，再按主题默认方式安装可保持协议依赖 `0.1.5-rc.2`，但不能修复 Catppuccin 的客户端接口问题。依赖实验见 [Grok 记录](pluginization-theme-compatibility.md)。因此“CLI 安装成功”不能等同于主题兼容。

XP 接管根界面并隐藏嵌入界面的侧栏，实际破坏加法式面板入口。需要先确定这类桌面主题应提供怎样的插件入口，再单独适配；本轮没有修改第三方主题或 Spaces 产品代码来掩盖结果。EternalNight 的欢迎区文字对比度也应保留为视觉缺陷。

## 可复跑入口与限制

`scripts/verify-spaces-themes.mjs` 使用 Node 22.18+ 或 24+。默认重建它专用的测试 Home，依次检查四个候选；已知 Catppuccin / XP 不兼容会让全矩阵退出码为 1，不能报告全绿。

- `DSH_TEST_BIN`：实际 DSH CLI 入口；`DSH_TEST_PLUGIN_TGZ`：要验收的 Spaces tarball。
- `DSH_TEST_PLAYWRIGHT_MODULE`：Playwright **包目录**，不要填 `index.mjs` 文件路径。
- `DSH_TEST_THEMES_REUSE=1`：保留现有测试 Home；`DSH_TEST_THEME_IDS=eternalnight`：只复开指定主题，结果写 `results-selected.json`。浏览器使用新 context，验证安装和默认外观，未验证同一浏览器跨端口共享主题偏好。
- 最终结果：`.sandbox/spaces-themes-acceptance/results.json`（前三候选）、`results-zhongguo.json`、`results-revisit.json`、`final-profile-matrix.json`。完整复跑脚本的默认矩阵已包含四个候选。
- 日志：`.sandbox/pluginization-theme-zhongguo.log`、`.sandbox/pluginization-theme-revisit.log`；各主题目录保留截图，主题 Host / 安装日志位于验收目录。复开会覆盖该主题当前日志和截图。
- 脚本语法检查、导入无启动副作用、四个 profile 单主题断言、干净 web/notes 对照、监听端口与关闭端口的判别均通过。此轮仅新增验收工具和记录，未重跑产品全量单测。

本次仅验证上述版本、Windows 下的裸 Web 和 Chromium 桌面视口。没有验证实际模型回复、移动端、其他浏览器或新版主题；未发布、推送或修改生产 Home。截图在本地忽略目录，Git 记录保留脚本和结论，复跑可重新生成。
