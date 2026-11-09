# 2026-11-09 新空间无模型与「插件 spec 不合法」

## 用户现场（限定只读授权）

用户提供模型下拉“暂无可用模型”以及 `space-dsbot` 的插件页错误“插件 spec 不合法：[path]”，图标已显示。经用户明确授权，仅检查最近一小时作业的时间、阶段、状态、错误，及 `space-dsbot` 的 package.json / llm-policy.json；未读取聊天、密钥或模型连接配置，未修改真实 Home。

本地时间 Asia/Shanghai：

| 时间 | 已观察事实 |
|---|---|
| 11-08 23:24:31 / 44 / 52 | 三个 plan.execute 作业在 delete 阶段成功结束 |
| 11-08 23:25:32–23:27:02 | `space.create space-ds-bot` 失败于 view-bridge，错误为插件 spec 不合法：[path] |
| 11-09 00:08:19–00:08:32 | 上轮恢复源码之后，`space.start space-ds-bot` 成功 |
| 11-09 00:09:40–00:09:41 | stop 计划成功 |
| 11-09 00:09:50.944–00:09:51.050 | delete 计划成功；两个 bridge 源码目录 LastWriteTime 均为 00:09:51，随后发现为空 |
| 11-09 00:10:27 | `space.create space-dsbot` 失败于 view-bridge，同一错误 |
| 11-09 00:10:33 | `space.start space-dsbot` 失败，同一错误 |

`space-dsbot` 插件清单只有官方 base/web-app，dependencies 为空，模型继承标记文件不存在。旧 `space-ds-bot` 的模型问题与失败创建的阶段一致：普通创建在安装 view-bridge 之后才写 main 模型策略；恢复源码后单独启动不会补写失败作业未完成的策略。没有把“旧全局 LLM 功能退役”误判为“官方本地模型不可配置”，没有据此修改 facade/模型路由。

图标校验与 pluginSpecInvalid 无代码交集。实际错误来自 `pluginLinkDirectory` 对缺失开发组件 manifest 的拒绝，而非自定义图标格式。

## 处理范围

- 用户上一轮已确认 bridge 源码是误删，并授权找回。再次恢复到上一轮核对过的源码状态，另外保留独立普通目录快照：[restored-source](../.sandbox/model-icon-20261109/restored-source/)。不含 junction，不修改真实 profile。
- 删除空间的 profile/hub 路径改用显式不跟随链接的遍历：使用既有 native-identity-aware lstat 识别 Windows 目录别名，只删除链接入口，不递归进入其目标。Windows 原生 lstat 报 directory 的别名使用非递归 rmdir；正常符号链接用 unlink。无失败重试、自动恢复或删除失败证据。
- 开发组件缺失的创建前拒绝已实施：检查源码目录、manifest 名称、main 构建入口和 bundle patch，普通创建与 Creator 在注册空间前执行。componentAligned 先检查源，再解析链接，避免 dangling link 被误当作仅未对齐。保持打包部署中可选组件的既有语义，不隐式重装，也不补写已有失败空间的策略。
- 同时发现仓库 `node_modules/@klarkxy/dsh-dev-index` 也是空目录，修改时间同为 00:09:51。从 `.sandbox/registration-after-reopen-20261108/file-probe/node_modules/@klarkxy/dsh-dev-index` 的独立普通目录副本恢复原已声明版本 0.2.8，29 个文件逐一 SHA256 一致。另两个独立发行包测试安装副本的清单和大小也一致；没有执行安装脚本，没有改变依赖版本、manifest/lockfile 或真实 profile。

## 已完成探针与限制

- Node 26.10 与宿主捆绑 Node 24.21 的原生 rmSync/rm，在隔离同盘/跨盘场景中均未复现源码目标被清空。不能宣称已复现用户 Desktop 内原始误删机制。
- 普通进程中的官方 plugin manager + pnpm 10.29.2 连续增加三个本地假插件，目标均保留。首轮末尾 remove 误带安装专用 flags 而失败，随后仅修正探针参数，用全新场景验证；没有重放实际作业。
- 沙箱内相同官方安装流程也未删除目标；观察到原生 lstat 把 junction 报为 directory，pnpm 会把链接移到 .ignored，但目标仍完整。该观察不能单独证明 pnpm 是误删者。
- 原始删除的明确现场证据是成功 delete 作业与两个源码目录清空时间吻合，代码路径为 `SupervisorPlans.execute(space.delete)` → `ProfileRegistry.removeOfficialProfile/removeHubData`。隔离普通 Node 与实际 Desktop 行为的差异仍须保留为限制。
- 新显式不跟随链接实现已在 Node 24.21 的跨盘场景通过，包括沙箱将 junction 错认成 directory 的情形，外部哨兵保留。证据 [junction-MmbBy3/result.json](../.sandbox/model-icon-20261109/junction-MmbBy3/result.json)。最初用 unlink 处理这种目录别名被沙箱拒绝；普通进程验证正常 symlink 后，按实际类型选择单次非递归目录入口删除，原拒绝现场保留。
- 误用 Desktop EXE 的 run-as-node 探针没有生成结果，未计入验证。

## SDK 依据

目标仍为 DSH 0.2.2-rc.1；沿用本会话已加载的 Cordis 开发技能与版本匹配 SDK。运行时 Inspect 已读取 llm 的 registerAdapter/listProviders/listModels 契约；[官方插件市场文档](https://deepseek-harness.github.io/deepseek-harness/en/guide/plugin-market.md)只作管理行为参考。新增文件删除和预检不新增 DSH Service/Event API。

## 最终验证

首轮完整检查 [checks-TUdBGi/result.json](../.sandbox/checks-TUdBGi/result.json) 保留原始失败状态：11/14 组通过。类型三组、构建、Spaces（114 通过/1 跳过）、recovery（28/28）、LLM（52/52）、Blueprint（216 通过/4 跳过）、Browser（18/18）和包预检通过。基础组 244 通过/1 个端口分配失败；workbench 799 通过/4 失败/2 跳过（已知主题 token、dangling-link 预检顺序遗漏、空 dev-index 的两项），DOM 19 通过/6 个此前选择器失败。

修正预检顺序并恢复依赖后，最终 [verify-eZXg2W/result.json](../.sandbox/model-icon-20261109/verify-eZXg2W/result.json) **6/6 步通过**：

- typecheck:spaces、typecheck:tests、最终 build、包预检通过；最终 Supervisor bundle 已包含新删除方法与预检。
- 定向回归 **54/54**：profile 删除外部源码哨兵、开发组件校验、普通与 Creator 缺组件时无注册/策略副作用、dev-index 预装，以及真实上传 PNG + main 模型策略同时保存。
- 端口失败的原单测单独诊断 **1/1** 通过，未修改端口代码，不能据此把初次完整检查改记为通过。
- 模型目录的进程内 SDK 原型 **7/7**（stub transport），确认 main 继承、本地 adapter、空目录及拒绝情况；不是外部模型调用验收。调查报告中早期“永久空模型”的措辞已加主线程更正。

没有重跑整套以掩盖首轮失败，没有修改既有主题 token 或浏览器选择器测试。本轮未提交、未发布、未自动重启真实服务、未补写真实空间策略、未重放失败创建。用户需要正常退出并重开加载新构建；旧失败空间保持原状态，可用一个新名称通过正常创建流程验证。实际 Desktop 上原误删机制未被隔离复现，新删除路径实际用户验收仍待。

