## 当前有效合同（2026-09-15）

故障政策：[docs/let-it-crash.md](../docs/let-it-crash.md)。活动账本：[todo.md](todo.md)。

隔离、鉴权、单写者、原子写、错误报告，以及用户主动的启动、停止、重启、安装、卸载和配置，仍有效。救援入口、检查并恢复、恢复中断任务、配置恢复、整 Home 恢复、Doctor `unlock`/`recover`/`rollback`、失败回滚、失败重试和中断续接 **已撤销**，不是延期，不勾成已完成。剩余运行时工作见账本 R1–R6（pending）。下文是当时实施与验收记录，不是现行恢复门槛。

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# 标准插件安装与最新 CLI（2026-09-13）

目标：用户经官方 dsh plugin --profile web add 安装预构建 Spaces 包，在普通 Web 中点“初始化 Spaces”，即可创建独立管理空间并进入工作台；不要求用户手动传 Home、CLI、tarball、worker 等内部路径。保留独立 supervisor、共享核心、单 Home 单写者与稳定入口。稳定救援入口作为产品能力 **已撤销**。初始化失败结束该次请求并说明原因，下次打开不自动补装、重建或续接。

基线：C:/0 code/DSH Space，codex/spaces-recovery，HEAD dfe9ae0 加当前未提交恢复代码。原改动和用户两个 tgz 不得覆盖删除。源快照保存 .sandbox/plugin-standard-install/baseline/。

官方 npm 现场核实 latest=0.1.5-rc.1、next=0.1.5-rc.2（最新发布）。本轮新增 rc.2 正式适配，保留 rc.1；不将“更改允许版本”当兼容验收。CLI 依赖/SDK 组合现场读取真实安装。

## 接口决策

1. 普通 profile 继续无 manager 写 remotes，不更改其 role 来绕过权限。新增 guide.initialize() 为显式、无路径参数初始化动作；页面加载/role/bootstrap 查询不应自动启动 supervisor。
2. initialize 只接受已确认 Home/profile 身份、无损坏状态；复用现有 attach/lease/manager allocator，不偷取活跃控制权，不覆盖普通空间，不强停未知进程。已有 supervisor 则附着；已有 manager 但已停止则在明确动作后重启同一管理环境。
3. 从已安装包内置 payload 定位 supervisor/view-bridge/worker，复制到 Home 外工具目录。初始化结果沿用安全 loopback handoff；重复点击合并，同 Home 重入不创建多个管理器。生产 Home 操作需实际用户点击授权，不能靠浏览器任意路径或全局关闭 Home 防护。
4. 前端保持普通 DSH 页面和插件共存，仅管理 profile 使用工作台根视图。提示初始化/进入工作台、初始化中的进度与失败原因；中英文。失败可重试作为产品入口 **已撤销**；用户再次点击是新请求。
5. 发布 npm 预构建包，完整 exports/bundle/client/README/license/repository/keywords；保留 scoped 包与 monorepo，GitHub 根目录不冒充可安装插件。pnpm 命令作用户入口，已有 npm 锁和安装体系不顺手重构。

## 分工与顺序

- Grok CLI 叶子：src/adapters/node/spaces-control.ts、workbench-supervisor.ts 的兼容门禁，src/main/runtime-store.ts 等版本默认的必要集中适配，匹配测试与独立任务记录。不可修改 packages/plugin 或 workflow/package manifests，需改依赖时报主 Agent。
- Grok 初始化叶子：packages/plugin/src、相关 tests/workbench-plugin.test.ts 等插件测试；初始化所需 supervisor 接口变化先报主 Agent（CLI 叶子正使用）。不修改根依赖/锁/CI。
- Codex：根计划与基线、准确运行时安装、依赖/打包/CI 分发整合、真实验收；分发实施后续另派 Grok，避免共享 manifest 冲突。

## 验收

- rc.1 与 rc.2 精确版本、未知版本拒写；类型/构建/聚焦回归。
- 使用无用户数据、无模型调用的新 Home，官方 CLI 标准 add 预构建包；普通 Web 出现初始化入口；点击成功创建并进入管理器；创建/切换/停止空间。
- 双击/刷新/第二浏览器与已有控制者不产生第二 manager；损坏身份、不兼容 CLI、失败安装可见且不误报完成。
- 打包内容不依赖源码 checkout，不含本地凭据、.sandbox 或嵌套 tgz；重启和卸载普通入口后生命周期可解释。
- CI 与实际目标版本一致；准备发布与目录收录材料。外部 npm 发布需账号/包命名权及最终产物核验，不能以本地打包成功冒充已上线。

## 本轮实施与验收

Grok 分别交付 CLI 适配、初始化入口、打包与安装验收脚本。Codex 独立审查后修复初始化过早返回、并发调用共享一次性令牌、身份失效后的冷启动、失败信息不显示，以及测试中错误地连带终止 supervisor 等问题。初始化叶子一次定向返工未完成，后续修复由 Codex 接管。原用户 tarball 和已有恢复改动保留。

最终实现：普通 Web 标准安装后显示初始化入口；只有用户明确点击才允许初始化。管理器由 supervisor 唯一分配，初始化等到真实 manager 运行才返回成功；并发调用共享启动但分别发放单次入口。过期的动态恢复提示随实际状态清除，活跃控制者、未知 CLI 和损坏身份仍拒绝不安全的写入。

代码验证：

- Node `24.21.0`；官方 CLI 实际执行版本 rc.1 / rc.2，SDK peers 实际解析 rc.2。
- node/web/spaces 类型检查通过；插件全套构建和 Electron 构建通过。
- 初始化相关 `workbench-plugin` 22/22；监督进程最终回归 27/27；DSH CLI 3/3。
- 原默认沙箱中的跨进程恢复测试遇到 EPERM；在允许真实子进程的环境复测监督进程和 doctor 两文件，39/39 通过。没有把默认沙箱失败计作通过。
- rc.2 最终真实验收：`.sandbox/plugin-standard-install/rc2-visible/results.json`。标准 add、普通 Web 初始化、唯一 manager、创建空间、真实 iframe 握手及显示、再次进入、Web 重启和 remove 均通过。pageErrors 为空，测试端口全部关闭。
- rc.1 最终同样通过真实可见 iframe 全流程：`.sandbox/plugin-standard-install/rc1-visible/results.json`。pageErrors 为空，测试端口全部关闭。两个版本使用同一 tarball，SHA-256 为 `10f6bfef73898bd7e83141dab6079d881854f8ec3d05cb276b198dcb95afd2b0`。
- 独立审查者复核确认失效 profile 不冷启，以及动态提示消退/重现和独立诊断保留均正确；本轮最后 diff 检查通过。

CI 已增加两版本的真实浏览器安装矩阵及打包产物检查；本地验证通过不代表 GitHub Actions 已运行（本轮尚未推送）。手动分发 workflow 仅产生待审查 tarball，不创建桌面版本或自动发布 npm。

## 外部分发和保留边界

`@dsh-spaces/plugin@0.2.0` 尚未发布，现场 npm 登录检查为 `ENEEDAUTH`。元数据与[社区提交材料](plugin-community-submission.md)已准备，公开包名安装和社区搜索要在发布、目录收录后另行读回验收。当前可以使用本地 tarball；未提交、推送、打标签或创建 release。

本轮验证了最新 CLI 上的标准插件安装与旧版本兼容，不覆盖历史上尚未验收完的 manager 自升级、所有崩溃注入及整 Home 回滚矩阵。不会把这些历史未完成项标成完成。
