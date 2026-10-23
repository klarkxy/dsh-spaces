# Node 24 与官方 Desktop 浏览器空间验收

日期：2026-10-20。范围：让 Spaces 兼容当前官方 Desktop 的 Node 24，并按用户追加授权适配 Browser Space。没有提交、推送、发布、替换官方应用或迁移真实 Home。

## 结果与交付

- 支持 Node `>=24.21.0 <25.0.0 || >=26.0.0 <27.0.0`。最低 24.21 对应本机官方安装版实际运行时；不泛称所有 Node 24 均受支持。
- 本机安装版官方 Windows Desktop `0.2.1-rc.2`：Electron `44.7.0`、Node `24.21.0`、Chromium `152.0.7977.130`。Playwright 启动的是原安装 EXE，`app.isPackaged === true`，没有自制 Electron 壳、伪造桥或替换 ASAR。
- 官方 Desktop 使用 Electron 自身作为 Node，以 `ELECTRON_RUN_AS_NODE=1` 启动其桌面 Host；系统 PATH 上的 Node 26 不会替换该运行时。此次适配 Spaces，无需修改官方运行时。
- 最终包：`.sandbox/node24-desktop-20261020/artifacts-accepted/dsh-spaces-plugin-0.4.0.tgz`。
- SHA-256：`21498f0bd2433636e20eff172ec6ba18b5911731d303b731aac46dc85e02ffcf`。
- 六组件 digest：`1cb27a72f406948ab915092eb818345308a0525924d6a3e7be900aeaecca58b6`。
- 最终包已由安装版 Desktop 自带 CLI 安装到全新 `desktop-run-8/home`，并核对实际安装的客户端、Host、Supervisor、manifest 和桥接清单与构建字节一致。证据：`desktop-run-8/loaded-payload.json`、`package-accepted.log`。

本记录中的相对证据路径均位于 `.sandbox/node24-desktop-20261020/`。该目录为本地验收产物，不是发布渠道。

## 改动

1. 运行时守卫、十个包的 engines、发行验证脚本和工具链发现统一接受上述范围；已有受支持的 Node 24 工具链会保留，新安装工具链仍默认 Node 26.10.0。`@types/node` 对齐 24.x，以便类型检查发现对较新 API 的误用。CI 的 Windows 和 portable host 增加 24.21 / 26.10 矩阵；未声称远程 CI 已执行。
2. 官方 Desktop 最外层插件使用已有 `dshDesktop.browser.acquire/release` 创建网页 guest。管理页仍处于原认证来源链中，网页不放进不支持嵌套 webview 的内层 guest。
3. Browser 复用现有 child → manager 校验和视口裁剪。native portal 只接收已注册 manager 的 Window/origin，校验 epoch、空间、generation 和运行状态；封闭、有界、规范编码的 fragment 携带 HTTP(S) 展示请求及匹配 requestId 的 URL/title 观察。没有新增管理 RPC、任意脚本执行或特权 guest preload。
4. 标签保留实际 guest；页内导航不会被最初的打开地址覆盖。快速切换使用最新展示请求，迟到结果不能覆盖新选择。隐藏后短租约释放 guest；下一次展示使用新的分区身份。失败标签在本次宿主生命周期内不会再次申请 guest，切回失败标签立即隐藏旧页。
5. 实测另发现创建成功提示被 native 设置页遮挡，修正提示位置和选中空间时的设置页显示条件，使“进入空间”可直接点击。新增真实 DOM 回归。

## 实际官方 Desktop

### 普通空间、重启和重开

`desktop-run-7` 在全新隔离 Home 中完成实际 UI：初始化 → 创建普通空间 → 创建提示“进入空间” → 安装/启动 → 呈现 WebUI → 设置中预览并确认重启 → 再次进入。全部管理作业 succeeded，generation `1 → 3`，serviceEpoch 保持一致。

正常退出桌面窗口、再次打开后，继续连接原 Supervisor `64724`，manager generation 1、普通空间 generation 3、Browser generation 1 均保持；作业 ID 不变，没有重放任务。再次进入普通空间显示实际 WebUI。随后通过高级设置预览并确认停止服务，端点和实例记录正常退出，桌面进程 exit 0。

证据：`desktop-run-7/05-created-state.json`、`06-started-state.json`、`07-restarted-state.json`、`15-reopen-proof.json`、`15-reopened-ordinary-aria.txt`、`16-shutdown-proof.json`、`14-first-exit.json`、`desktop-exit.json`。

该完整流程的包为 `6664e8e…`；最终包随后仅追加 Browser 失败标签隐藏处理，普通空间及重开代码没有再改变。最终包的 Browser 专项在另一个全新 Home 验收，不能把两个包描述成同一份字节。

### 原生 Browser 与释放

`desktop-run-7` 和最终包的 `desktop-run-8` 均通过：UI 创建 Browser 预设 → 自动安装预设插件 → 明确进入 → 地址栏打开本机 HTTP 测试页。测试页同时带 `X-Frame-Options: DENY` 和 `frame-ancestors 'none'`，仍作为原生主文档实际呈现。

- A/B/A 切换保留两个页面的独立输入内容，服务端没有因普通切换再次收到 A/B 主文档请求。
- 页内链接 `/a → /linked` 后，标签标题及地址占位同步为实际页面，原始 requestedUrl 保持不变。
- 实际 guest 的 `sandbox/contextIsolation/webSecurity` 为 true，`nodeIntegration/webviewTag` 为 false；页面中的 `process`、`require`、`dshDesktop` 均 undefined。
- 切回默认空间，两个 guest 在实测约 **2080 ms** 后销毁。返回 Browser 时分区身份已改变，页面从原始打开地址重新呈现，输入值为初始值。
- 官方 lease API 释放网页 guest，但其分区存储在 Desktop 进程内保留到应用退出；因此不声称立即擦除存储，也不承诺长期离开后的登录或页面状态。

证据：`desktop-run-7/10-aba.json`、`11-browser-proof.json`、`12-browser-release.json`、`13-browser-return.json`；最终包：`desktop-run-8/06-happy-proof.json`、`06-native-browser.png`。

### 最终包的实际导航失败

在 `desktop-run-8` 明确打开 Chromium 禁止端口地址 `http://127.0.0.1:9/`，得到实际 `did-fail-load` **-312**。页面显示 `Native Browser is unavailable.`，失败 guest 被释放。

随后选择健康 B，再选择失败标签：旧 B 页立即隐藏，失败标签不重新申请 guest。继续观察 3 秒，主进程诊断只记录一个 WebContents ID 的一次导航和一次失败，没有新增导航。没有重试、重启、回退或恢复。其它空间服务仍 ready，管理作业 succeeded。

最后通过 UI 正常停止服务，端点不存在、instances 为空、网页 guest 为 0、桌面进程 exit 0。证据：`desktop-run-8/07-failure-proof.json`、`08-runtime-proof.json`、`09-shutdown-proof.json`、`desktop-exit.json`。

## 自动检查

执行了清单检查、三组类型检查、构建、八个规定测试组、额外 Chromium 界面测试和包预检。Dashboard 使用已安装的官方 `@deepseek-ai/dsh@0.2.1-rc.2` SDK 树。Windows 检查均使用仓库外临时目录。

| 规定测试组 | Node 24.21 通过 | Node 26.10 通过 | 各自跳过 |
| --- | ---: | ---: | ---: |
| test | 266 | 266 | 0 |
| test:spaces | 148 | 148 | 1 |
| test:workbench | 519 | 519 | 2 |
| test:workbench:recovery | 31 | 31 | 0 |
| test:llm | 99 | 99 | 0 |
| test:blueprints | 326 | 326 | 4 |
| test:browser | 11 | 11 | 0 |
| test:dashboard | 200 | 200 | 1 |
| 合计 | **1600** | **1600** | **8** |

额外 `test:workbench:browser` 两个版本均 **12/12**。跳过为现有平台、权限或条件分支，不能计作已执行通过。逐组日志与汇总：`summary-node24.json`、`summary-node26.json`。

以上为本轮完整检查与相关改动后复验的汇总，不是一次命令的单一输出。最后的失败标签隐藏修正后，两版本各重新执行 **19/19** native 专项，并重新通过类型、构建、包预检和最终包实际 Desktop 验收；未再次重复所有无关组。日志：`native-final24.log`、`native-final26.log`、`checks-accepted26/`。

## 失败证据与验证限制

- 原 Node 26 独占守卫导致的激活失败是真实问题。Browser 未适配的现场保留在 `desktop-run-5`：页面报告 unavailable，测试站未收到请求；没有在该失败 Home 内恢复 Browser。后续产品修正均使用新 Home。
- 初期有测试环境原生工具写权限、esbuild 版本错配、截图超时和自动化过早关闭等失败，原目录及日志保留。Windows 原生工具使用 SHA 相同的仓库外副本，没有改 ACL 或产品失败策略。实际 UI 证据与这些测试环境问题分开记录。
- 测试 fixture 的长连接跨短生命周期端口问题在 fixture 中关闭连接；不改产品传输。后来并发执行两套工作台测试时，一轮模拟 manager 提前退出；共享固定端口范围存在竞争可能，不能仅凭错误断言根因。失败保留于 `checks-browser-final24/`，取消该并发后全新串行 Home 的工作台 **519 通过 / 2 跳过**，记录于 `checks-browser-serial24/`。
- Playwright 在不同 Electron webview 间输入时需要显式聚焦对应外层 guest，再点击输入框。未切换焦点的自动化输入曾落到另一个视图，导致等待超时；请求记录证明当时没有打开新标签，也没有产品作业或导航失败。最终验证校验输入实际落点再提交。
- 未使用密钥、登录凭据或进行模型调用，因此不把普通 WebUI 呈现描述成真实模型推理通过；也不声称原会话草稿、所有网站、多平台、长期运行或第三方原生宿主已验收。
- 所有实际验收使用隔离 Home。最终 Home 的 `profiles/web`、根 `sessions`、根 `storages` 均不存在。没有读写真实 `~/.dsh`、安装到日常使用的 Home，或更改官方安装文件。
- 开始时已有 81 项脏/未跟踪文件；范围外基线没有变化。最终 333 个产品源文件冻结后未变，安装内容与构建匹配。官方 EXE / ASAR 的前后 SHA 相同。最终系统只读检查未发现本任务遗留进程、跟踪 PID 或监听端口。证据：`preservation-audit-final.json`、`source-freeze-browser.json`、`process-audit.json`。

可复用本次 UI 验证的本地助手：`desktop-session.mjs`、`prepare-desktop.mjs`、`install-desktop.mjs`、`browser-acceptance.mjs`。它们位于忽略的验收目录，不是产品恢复入口；每次开发验证应明确指定新的隔离 Home，不能复用失败现场。
