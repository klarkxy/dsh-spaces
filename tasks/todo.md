# DSH Spaces 维护待办

> 只列当前仍需跟踪的事项。完整日期日志和已关闭条目在 [tasks/archive](archive/README.md)，不要在这里追加长日志。

## 2026-11-14 推送前审查

- [x] 修正宿主状态字段、Desktop 启动范围、异常退出与密钥日志、模型路由替换、插件部分结果和界面刷新；复用 dsh-plugins 发布目录并核对 14 个 npm bundle。全量检查通过，最终补丁验证见 [审查记录](archive/review-20261114.md)；真实宿主待验事项保持下列状态。

## 本地诊断轮换日志

- [x] 实现本地 `debug` / `info` / `error` / `fault` JSONL 日志，位于 Home 的 `.dsh-spaces-control/logs/`，按 7 天/100 MiB 轮换并清理归档，分发构建默认从 `info` 开始。不自动恢复或重启。
- [x] 修复正式 `~/.dsh` 下诊断日志误触发真实 Home 拒绝保护：为 `RotatingDiagnosticLogger`、宿主插件/启动引导及 Supervisor CLI 入口透传 `allowRealHome`，保持未确认宿主身份不落盘与默认测试保护不变。
- [ ] 在真实 Desktop 中验收日志落盘、宿主日志导出和进程故障留痕；隔离自动化与发布预检不等同于实机验收。

## 发布与真实宿主验收

- [x] 主插件改名为 `dsh-spaces`：代码与文档已统一，旧包继续受保护，换名走显式卸载/安装；完整检查与官方 CLI 双 profile 换名验证通过，见 [改名记录](archive/package-name-20261114.md)。

- [x] 公共插件目录由本仓库维护，开放独立作者贡献，支持按 npm 包名安装和版本限定的实测说明。见 [实施记录](archive/community-catalog-publishing-20261114.md)。
- [x] 清理当前发布流程并统一 Git 源码构建安装说明，保留目录与本地打包；完整检查中的浏览器禁用端口问题已修正，受影响组 27/27 通过。见 [清理记录](archive/git-install-cleanup-20261114.md)。
- [ ] npm 发布暂缓，后续另行安排；当前使用 Git 源码构建的插件包。原方案和恢复工作所需指针见 [历史发布准备](../docs/archive/npm-publishing-20261114.md)，不作为当前安装或验收前提。

- [ ] dsh² 个人工作宇宙后续验收：八空间/十三次插件安装完成，六个前端可展示，两组合加载失败；实机素材已交付。仍需定位 `settingsScope`、pixel-whale 模块注册、长期门户超时及基础测试 45 个失败条目；主空间总控/模型同步本轮未验。见 [实机记录](archive/dsh2-personal-web-20261110.md)，不视为全量通过。

- [ ] 最终 0.5.0 制品验收：按错误页现有预览/确认流程完成一次真实服务重启（旧 space-control bundle 清理后的实际服务重启仍未执行）。见 [归档记录](archive/todo-2026-11.md) 2026-11-09 管理空间残留旧 space-control bundle。
- [ ] 最终 0.5.0 制品验收：真实 Desktop 加载后的删除/新建验收；失败空间与作业保留，不自动补配置或重放。见 [归档记录](archive/todo-2026-11.md) 2026-11-09 新空间无模型与自定义图标同屏报插件路径错误。
- [ ] 主空间模型配置一次性同步（删除 `@dsh-spaces/llm-bridge` 与实时 LLM 委派）：原有一次性同步已完成隔离 `dsh web` 验收；批次 1 的运行中免停机同步、下一次请求生效和摘要预览仍需在真实 Desktop 与隔离实例实测，旧空间首次启动卸载退役包同样待验。
- [ ] 空间注意光晕：三种空间栏按 `dsh-spaces:space-attention` 通道投影待审批/待提问状态；已有空间的 view-bridge 需按新组件组重新对齐才会上报（此前为 `unknown`、无光晕），真实 Desktop 尚未实测。
- [ ] 真实 Desktop EXE 与 `cordis` 会话内的 `spaces_plan` / `spaces_execute` / `spaces_ui_*` 审批端到端尚未实测。见 [归档记录](archive/todo-2026-11.md) 2026-11-09 主空间空间总控插件设计。
- [ ] `plugin.live.*` 对真实子 DSH 进程（真实 cookie 交换 + 真实 `pluginManager`）的端到端冒烟尚未执行。见 [归档记录](archive/todo-2026-11.md) 2026-11-09 主空间空间总控插件设计。

## 2026-11-10 文案与文档维护态收敛

- [x] 文案修正与润色：修正 Desktop 服务操作提示 `serviceMainSpaceNote`、工作台设置页 `settings.shutdownVsExit`、`errors.profileExists`、Creator 工具 `modelSource` 描述及 `spaces_inspect` `model` 区段描述中残留的旧模型委派与旧退出语义。
- [x] 文档维护态归档与对齐：将空间总控三份早期设计原稿归档至 `docs/archive/space-control-*-20261109.md`，重写 [docs/space-control-design.md](../docs/space-control-design.md) 为现行维护态契约；对齐 [REQUIREMENTS.md](../REQUIREMENTS.md)、[README.md](../README.md)、[CHANGELOG.md](../CHANGELOG.md)、[docs/workbench.md](../docs/workbench.md)、[docs/releases/v0.5.0.md](../docs/releases/v0.5.0.md)、[tasks/merge-contract-v2.md](merge-contract-v2.md)、[tasks/workbench-contract.md](workbench-contract.md) 与包内文档，清理现行文档中的未跟踪本地沙箱路径引用。

- [x] 按用户要求修订 `AGENTS.md` 的真实 `.dsh` 边界：允许只读诊断，直接写入需明确授权，正常授权启动及应用自身的正常运行写入不算违规；开发与测试继续使用隔离 Home。

## Spaces 易用性整改后续批次

- [ ] 每个空间的“打开 Desktop 时启动”：已完成代码与隔离自动化验证，真实 Desktop 待验。默认关闭；开启的空间在管理服务就绪后各自启动一次，失败不重试。
- [x] 批次 2（免停机插件、目标空间计划校验与按空间排队，已完成代码与自动化验证，真实宿主待验）：运行中空间的插件安装/移除/启停改为经子空间 `pluginManager` 免停机应用，需重启时提示用户选择“立即重启”或“稍后自行重启”；工作台空间级计划改为只校验目标空间指纹与代次并在入队时核验 TTL（`/control` 全库修订约束保持不变）；工作台忙碌状态改为按受影响空间计算，无关空间可提交排队并展示“排队中”。
- [x] 批次 3（设置页 6 项人性化收敛，已完成代码与自动化验证，真实宿主待验）：包来源与目录地址移至“常规”并补齐未保存状态判断；插件目录按用途分类、提供一键安装与就地选版本、收敛已装插件移除菜单；空间列表行点击直达详情并收纳排序菜单，内部 ID 下放“高级”、仅在检测到误装管理包时显示清理入口、补齐诊断手动重新读取与删除空间时的数据清理勾选项；新建空间改为显示名称优先并自动生成标识、提供创建后直接启动开关与折叠高级选项；封存期间导入提示与选择器统一面向 `.dshspace` 且保存本机模板简化为单一名称；常见任务进度中文化并补充备份离线目录说明。
- [x] 批次 4（设置页结构与入口收敛，已完成代码与自动化验证，真实宿主待验）：统一空间右键与行尾 `⋯` 菜单（空间设置、启停重启、导出分享文件、存为模板、上下移动、重命名、换图标、删除）并移除空间详情页重复导出卡片；Desktop 原生空间栏右键新增“打开空间设置”直达目标空间详情；新建空间对话框整合“空白 / 从模板 / 从文件导入”三模式，“模板”页收敛为已存本机模板的使用与删除；设置页左侧导航收敛为“空间 / 模板 / 通用 / 维护”四项，低频服务配置收入“通用 → 高级”折叠区，状态、任务、备份、运行时、日志与停止服务合并至“维护”。
- [x] 界面文案精简与润色（已完成代码与自动化验证，真实宿主待验）：移除 Desktop 侧边栏说明弹窗及服务确认冗余附注，移除工作台待机页、新建空间、模型卡片、插件区、诊断区、模板页与维护页中的重复说明段落，统一并收紧中英文提示、状态与错误措辞。
- [x] 维护子页签与原生视觉收敛（已完成代码与自动化验证，真实宿主待验）：“维护”页拆分为“状态与任务 / 备份 / DSH 版本 / 服务”四个横向子页签并去重空状态重复按钮；空间详情返回改为无框 `←` 图标按钮，“预览切换/安装/删除”精简为“切换/安装/删除”；工作台移除多余圆角卡片、紫色渐变与发光阴影，改用 `0.5px` 细分割线扁平分组与官方 `--dsw-*` 原生主题变量。
- [ ] 后续状态与反馈细化（待评估）：进一步细分读取失败、写入失败、重启失败与旧版 API 不支持颗粒度。

## 已跟踪问题

- [ ] 并发 lease 回收用例曾在 `reclaim` 路径竞争期间触发 `assertMissingEntry` 安全拒绝，后续完整检查通过；未修改锁策略，仍需单独评估该计时敏感用例。见 [改名验证记录](archive/package-name-20261114.md)。

- [ ] 官方 Desktop 的本机认证 Cookie 累积可使欢迎页请求返回 HTTP 431，却显示 `Web authentication failed`。2026-11-10 已备份并定向清理 71 个无监听端口的旧 Cookie；隔离同目录 431→200 对照通过，真实 `.dsh` 未写、日常启动未代验，官方累积机制未改。见 [诊断与处置记录](archive/desktop-auth-cookie-20261110.md)。
- [ ] 首次管理页导航/35 秒就绪超时根因未确认；不将后续成功样本视为修复。见 [归档记录](archive/todo-2026-11.md) 2026-11-02 首次导航诊断、2026-11-02 前一轮首次管理页超时、2026-11-02 Desktop 后台启动条目。
- [ ] `MAIN_REGISTRATION_REFUSED:400` 原始根因未确定；补丁加载后的实际拒绝码仍待确认。见 [归档记录](archive/todo-2026-11.md) 2026-11-08 Desktop 主空间注册 400 诊断。
- [ ] `attachReady` 监听器失败后本纪元控制工具不可用，`workbench/unavailable` 无法区分“未接入”和“不可用”。见 [归档记录](archive/todo-2026-11.md) 2026-11-09 主空间空间总控插件设计。
- [ ] 长时间 UI 探针中的浏览器侧 DNS 停顿、`read.deadline`、`portal/transport-failed` 仍未归因。见 [归档记录](archive/todo-2026-11.md) 旧阶段仍未关闭的条目（2026-10-15、2026-10-14）。
- [ ] 负载下的计时敏感用例（launch token、端口分配、`workbench-plugin` portal startup observation “unavailable” 变体）仍可能偶发失败，根因未查；`dashboard-supervisor` 测试已不存在，blueprint `native.test.mjs` 现先等待 `listening` 再读端口，未做负载复测。另有 Linux `taskkill` 挂起记录。见 [归档记录](archive/todo-2026-11.md) 2026-10-12 清理与结构拆分、2026-10-09 精简 MVP。
- [ ] Web 拒绝嵌入提示不完整：实际页面主要为浏览器破损图标和通用预览文案。见 [归档记录](archive/todo-2026-11.md) 旧阶段仍未关闭的条目（2026-10-09）。
- [ ] Terminal Space 尚未实施，另行设计与授权。见 [归档记录](archive/todo-2026-11.md) 旧阶段仍未关闭的条目（2026-10-09）。
