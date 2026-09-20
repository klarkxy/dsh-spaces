# 合并执行与验收记录

2026-09-20 开始。计划：[spaces-merge-convergence.md](../docs/plans/spaces-merge-convergence.md)。活动状态只在 [todo.md](todo.md) 维护。

## 基线

- 分支 `codex/spaces-reconcile`，基于 `c22c47fd37629e3bb852f7702d68624d3a73453d`。
- 工作树 `.sandbox/worktrees/spaces-reconcile`；原主工作树 `main@1f339ac` 保留。
- 原始提交备份标签：`pre-reconcile-main-20260920`、`pre-reconcile-pluginization-20260920`。
- 原 stash 对象 `7ecafc6a8f5563130e4465b8b3f69c208235f1a5` 保留，未应用。
- `npm ci --no-audit --no-fund` 完成；Node/Web/Spaces 三组类型检查已通过。其余构建和测试进行中，日志在集成工作树 `.sandbox/merge-baseline/`。
- 基线测试去除脚本间重复文件，并以 `--test-concurrency=1` 串行运行；包括未接入默认入口的 `workbench-package-upgrade.test.ts`。尚未宣称整体通过。

## 首批 Grok 审计

| 分区 | 路径数 | Task ID | 写入范围 |
|---|---:|---|---|
| 后台与领域 | 68 | `task_f591f56977` | `tasks/merge-audit/runtime.json`、`.md` |
| 界面、分发与测试 | 125 | `task_584a9baf84` | `tasks/merge-audit/interfaces.json`、`.md` |
| 文档与历史 | 86 | `task_12665db697` | `tasks/merge-audit/evidence.json`、`.md` |

三个任务共用冻结的 main/old/imported 提交，各路径恰有一个审计所有者；产品源码只读。所有 Grok 调用均省略 model/effort 覆盖。主 Agent 负责核对报告完整性、缺失候选、真实 diff 与验收，不以 worker 完成状态代替审计结论。

## 验收限制

本文件尚未记录任何新产品能力通过。单测、真实 CLI、浏览器、Electron 和最终安装包证据分别登记；未跑即未跑。测试只用一次性 Home，不触碰真实 `~/.dsh`。

## A0/A1 验收

三个分区合计 279 行，逐行字段/引用/路径集合通过主 Agent 校验；另有 3 条 old→imported 差异不在 old→main 集合，托盘与进程测试已与旧分支字节相同，ControllerStatus 在旧分支和当前主线均不存在。合计 282 个并集路径无待归类项。

初判 242 已覆盖、33 被后续政策替代、4 遗漏。4 项均为文档/验收脚本：正常备份说明及演示源台词、失效的接管徽章等待、rc2 脚本的个人机器路径；Grok 修正后主 Agent 读回并做 JSON/语法检查。未把静态脚本检查声称为真实 UI 通过。总表：[acceptance.json](merge-audit/acceptance.json)。

完整基线 641 tests：638 pass、2 fail、1 skip。两处失败均为 Windows 测试移植问题；修正后主 Agent 独立复跑两文件，8/8 pass、0 skip（含先前失败的两项）。未无理由重跑其余 633 项。三组类型检查和两种构建均通过。可选官方 CLI 实测、真实浏览器与安装包启动仍未跑。

首次受限沙箱运行因 taskkill 被拒绝未正常结束，已核实测试主进程身份并清理整棵所属进程树。上述 641 项来自具备测试子进程管理权限的第二次运行，不能引用首次部分输出作为通过。

另发现主线 `withMaintenance` 在部分失败后仍调用 reinitializeManager；B2/B5 将删除该可达的失败重启/补装链，并加真实故障验证。历史“产品路径已符合”文字和当前绿测不能覆盖这个缺口。
