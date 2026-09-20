# Runtime 合并前语义审计

组：`runtime`。工作树 `HEAD=c22c47fd37629e3bb852f7702d68624d3a73453d`。只读三向查证，未改产品、未 checkout/commit/merge、未跑测试、未 npm 安装。

逐路径记录见 [runtime.json](runtime.json)。输入 `.sandbox/merge-audit-inputs/runtime.json` 的 68 条路径各一行，无 pending。

## 引用

| 名 | SHA |
|---|---|
| main / HEAD | `c22c47fd37629e3bb852f7702d68624d3a73453d` |
| 旧分支 pluginization | `51911e481961408ad77758b0123653c0fc1e2bdd` |
| 导入点 | `1f339acc4c616ed634760f2735823f5ce83b9cd3` |
| 共同祖先（背景） | `dfe9ae0ed760ee1e6fe9e9d9e5d057e9451981b7` |

## 方法

对每个输入路径取三向 blob，再按组 `git diff`：

- 旧 → 导入：11 个路径内容不同（OI!）。其余旧与导入相同，或两边都不存在。
- 导入 → 当前：主线 32 个提交（let it crash、latest 渠道、全局 LLM、分享/模板/批量、托盘隐藏、死实例记录）。
- 旧 → 当前：判断旧意图是否仍有价值且被 main 漏掉。

不按文件状态或标题自动套结论。恢复相关只在执行链仍可达、或主线缺少等价拒绝时才可能记 missing。正常备份/安装 worker/LLM 启动快照不因 `snapshot` 名字当作已废弃。

## 计数

| 结论 | 条数 |
|---|---|
| already-covered | 63 |
| superseded | 5 |
| missing | 0 |
| 合计 | 68 |

**没有 A 阶段移植候选。** `summary.missingItems` 为空。

## 旧与导入真正分叉的 11 条

这些是旧分支相对导入点仍不同的 runtime 文件。当前 HEAD 的处理：

| 路径 | 旧相对导入 | 当前 |
|---|---|---|
| `packages/doctor/src/common.ts` | 硬编码 rc.1 写版本 | 白名单已删，精确版本校验 |
| `packages/plugin/src/host/plugin.ts` | 注释较弱 | 导入点注释保留：ordinary 不自动冷启动 |
| `packages/plugin/src/host/runtime.ts` | 无显式 initialize；uninitialized 可冷启动 | 导入点 initialize + 仅 manager 冷启动；主线改精确版本检查 |
| `packages/plugin/src/host/workbench-guide.ts` | 无 initialize Remote | 导入点已加，主线相同 |
| `packages/plugin/src/host/workbench-schemas.ts` | 无 initialize schema | 导入点已加；主线再加 LLM schema |
| `src/adapters/desktop/control-residue.ts` | pidAlive 忽略死实例 | 导入点曾去掉 pidAlive（过拦）；**c22c47f 已接回** |
| `src/adapters/desktop/controller.ts` | acquireOnStart/Explicit 可 reclaimDead | 启动与显式接管都不 reclaim；residue 用 pidAlive |
| `src/adapters/node/spaces-control.ts` | CLI 仅 rc.1 | latest 渠道 + 精确版本；创建空间仍从 web 克隆 |
| `src/adapters/node/workbench-supervisor.ts` | web 种子带 `--from-default-profile web` | 导入点去掉 web 自克隆；derivedRecoveryReasons 保留；LLM apply 走真实 job |
| `src/main/index.ts` | 托盘 conceal + 通知 | 导入点简化 hide；**fd3bd9c 已接回 concealWindowToTray** |
| `src/shared/runtime.ts` | 默认 rc.1 | `DSH_DEFAULT_CHANNEL=latest`，执行钉死精确版本 |

旧分支顶端 `51911e4`（包升级、校验、托盘隐藏）和 `6247b22`（维护子进程身份）里仍有价值的非恢复意图，要么早已在导入树，要么被上述主线提交接回。旧 `reclaimDead`、Doctor recover、job `recovery-required` FSM 按现行政策视为替代，不移植。

## 被现行策略替代（5）

这些旧意图不能搬进主线：

1. `packages/doctor/src/common.ts` — CLI 写/校验白名单。
2. `packages/doctor/src/index.ts` — 把 unlock/recover/rollback 接到旧实现。
3. `packages/doctor/src/recover.ts` — 离线恢复/回滚实现；入口已不调用。
4. `src/adapters/desktop/home-control.ts` — `snapshot-restore` 例外并 unlink mutation journal。
5. `src/main/diagnostics.ts` — `restoreBackup` 执行链（备份列表仍保留）。

`src/main/plugin-restore-point.ts` 是主线新增、仅测试引用的类型模块，记 already-covered（无旧遗漏），B5 可删，不得新接为恢复入口。

Doctor 的 `doctor`/`verify`、备份查看、正常升级提交前失败丢弃 stage，仍记在 already-covered 的相邻文件里。

## 主线新增（status A）

33 个路径在旧分支和导入点都不存在。它们承接全局 LLM、分享/模板/批量，不是旧遗漏。

- **全局 LLM**：`packages/llm-bridge/**`、`src/adapters/node/llm-*`、`src/core/application/global-llm-*`、`src/core/domain/llm-*`、`src/core/ports/llm-*`、`src/shared/llm-api.ts`。打包见 `scripts/pack-spaces-plugin.mjs`，测试见 `tests/llm-*.ts`。
- **LLM 启动快照**：`src/adapters/node/llm-snapshot.ts` 写入冻结配置，由 `ProcessManager.extraEnv` 注入。不是整 Home restore。
- **分享/模板/批量**：`src/main/space-share.ts` 导入三分状态；`src/main/space-templates.ts` 与 `src/shared/batch.ts` 首项失败结束批次。
- **桌面 LLM**：`src/main/desktop-llm.ts` 是主线后增分叉，见下方 B 阶段风险。

## 必须保护、且当前已在树上的规则

对照 `docs/let-it-crash.md`、`tasks/todo.md`、`docs/plans/spaces-merge-convergence.md`：

- 不恢复 / 不回滚 / 不抢锁 / 不重放：jobs 中断记 failed；`settleRecovery` 与 `recovery.resume` 拒绝；Doctor 公开恢复命令 unsupported。
- 全局 LLM：Supervisor 装配真实 apply job；凭据走专用方法。
- 模板 / 分享 / 批量：见上。
- latest 渠道、执行精确版本：`src/shared/runtime.ts`、`spaces-control.isCompatibleDshCliVersion`、`plugin-ops.pinDownloadMeta`。
- 标准预构建插件安装与显式 `initialize`：host runtime/guide。
- 正常快照创建/查看/删除与安装 worker：`workbench-maintenance` 执行 `snapshot.create`/`delete`；`index.ts` 仍把 `snapshot-worker.mjs` 交给 RuntimeStore/SnapshotExecutor。

## A 阶段遗漏 vs B 阶段欠账

本叶 **没有** 需要从旧分支打补丁的 missing。下列是计划 B 段要改的主线现状，不要写成“旧分支没合进来”：

1. **LLM job/generation 分叉（B2/B4）**
   桌面 `generationOf: () => 0`，`desktop-llm.submitApply` 合成 `succeeded` job。Supervisor 使用 `generations` 并 `jobs.submit(llm.apply)`。
2. **桌面仍是第二写者（B4）**
   `src/main/index.ts` 继续装配 registry/process/runtime/upgrade。
3. **合同仍混着恢复符号（B1）**
   `WorkbenchCommand` 仍有 `recovery.resume`；计划类型仍有 `snapshot.restore`/`config.restore`；IPC 名仍有 `restoreSnapshot`。执行层已 forbidden/unsupported。
4. **未接线历史模块（B5）**
   `packages/doctor/src/recover.ts`、maintenance 私有 restore 函数、upgrade 私有 `rollbackSnapshot`。
5. **c22c47f 不能被导入点覆盖**
   若有人用 `1f339ac` 的 `control-residue` 做 ours/theirs，会死实例记录再次误拦。

`HomeController.reclaimDead` 仍在 `src/adapters/node/home-controller.ts`（本叶路径外）。桌面 controller 已不调用。不得经旧分支重新接到 `acquireOnStart` / `acquireExplicit`。

## 验证范围

本叶用 blob 哈希、分组 diff、当前源码行号和已存在测试名做静态查证。关联测试包括但不限于：

- `tests/desktop-controller.test.ts`（死实例不拦、活残留仍拦）
- `tests/process-manager.test.ts`（托盘 conceal）
- `tests/workbench-jobs.test.ts`（settleRecovery unsupported）
- `tests/workbench-maintenance.test.ts`（snapshot create；restore forbidden）
- `tests/workbench-plugin.test.ts`（initialize）
- `tests/compatible-dsh-cli.test.ts`（无 `COMPATIBLE_DSH_CLI_VERSIONS` 白名单）
- `tests/llm-*.ts` / `scripts/pack-spaces-plugin.mjs`（llm-bridge）

**没有实际 merge，没有运行验收，没有 `npm ci` / 整套测试。** 协调者正在建立依赖与基线。历史测试通过次数不能当作本次证据。
