# A1 语义审计：evidence 组

组：`evidence`（文档/任务/包 README，86 条）。只读三向查证。未 merge、未改产品、未跑测试或 npm 安装。

## 引用

| 名 | SHA |
|---|---|
| main / 工作树 HEAD | `c22c47fd37629e3bb852f7702d68624d3a73453d` |
| 旧分支 pluginization | `51911e481961408ad77758b0123653c0fc1e2bdd` |
| 导入点 | `1f339acc4c616ed634760f2735823f5ce83b9cd3` |
| 共同祖先 | `dfe9ae0ed760ee1e6fe9e9d9e5d057e9451981b7` |

机器可读行：[`evidence.json`](evidence.json)。输入路径集与输出 86 行一一对应，`status` 原样取自 `.sandbox/merge-audit-inputs/evidence.json`（相对 old→main）。

## 方法

对每条路径核对 blob：旧、导入、当前。

- 多数任务/历史文件 **旧 == 导入**，差异来自导入后 32 个主线提交（`e5e4079` let it crash、`ee26d4c` latest、全局 LLM、模板/分享/批量、`c39b3ef` 0.3.0）。
- 11 条旧≠导入：`README.md`、`docs/workbench.md`、三个包 README、`tasks/plan.md`、`tasks/todo.md`、以及若干 markdown 换行。导入点已写入标准预构建安装与 rc.2，不是旧分支独占功能。
- 14 条主线新增、9 条导入点新增：旧分支没有对等文件。
- 旧 16 个提交 **不是** main 祖先；文档意图按内容比，不按 cherry-pick 那 16 个 SHA。

政策：现行故障合同是 [`docs/let-it-crash.md`](../../docs/let-it-crash.md)（不恢复/回滚/抢锁/重放）。必须保护：全局 LLM、templates/share/batch、latest 渠道但执行精确版本、标准预构建插件安装。正常备份创建/查看/删除和安装 worker 不因 snapshot 文件名报废。B 阶段架构债（acquire 协议、桌面第二写者、包升级测试入口、升级交接）不记成 A1 旧分支补丁。

## 结论摘要

| 决策 | 条数 | 含义 |
|---|---|---|
| already-covered | 68 | 旧有效非恢复意图已在当前（或主线后续能力，无旧对等遗漏） |
| superseded | 16 | 旧把恢复/回滚/救援写成现行需求，已被 let it crash 取代；历史事实未删 |
| missing | 2 | 仍有价值的旧用户意图被主线 D 阶段连恢复一起删掉 |

**没有**需要从旧分支整文件移植的恢复合同、Doctor recover、救援页或永久 CLI 白名单。

### 需要补的两处（不是 merge 旧文）

1. **`docs/workbench.md`**  
   监督 flag、view-bridge、误装卸载、双端、jobs 不重放、批量首失败、`--snapshot-worker` 作为运行时安装 IO，都在。  
   缺口：用户主动 **创建/列出/删除备份** 从指南消失，只剩“写入快照文件不是恢复承诺”（约 L99）。运行时仍有 `runSnapshotCreate`（`src/adapters/node/workbench-maintenance.ts:1206-1219`）和 `snapshots.create` / `snapshots.delete`（`packages/plugin/src/workbench/i18n.ts:156-160`）。  
   补丁：在现行 let it crash 下写备份管理，明确不是 `snapshot.restore`。不要从旧 `56ba211` 带回 config restore / doctor recover。顺带处理 L231 仍写 rc.1/rc.2 门禁、与 README latest 不一致。

2. **`tasks/workbench-demo-narration.json`**  
   04 段旧文有“插件、**备份**和运行时维护”，主线改成只报错、不救援，正确去掉“快照恢复影响整个 Home”。备份被一并删掉。只改 04 段加回创建/查看/删除备份，不恢复旧恢复句。

### 已覆盖的后续能力（主线新增，不要用旧树覆盖）

- `docs/let-it-crash.md`、`AGENTS.md`、`dsh-spaces-let-it-crash-plan.md`、`tasks/q-coverage.md`
- 全局 LLM：`docs/plans/global-llm-connections.md`、`docs/compat/*`、`tasks/global-llm.md`、`packages/llm-bridge/README.md`（A25 keyless **未交付**）
- 标准安装：`docs/plugin-standard-install.md`（导入点已有，主线改 latest）
- 模板/分享/批量：`tasks/plugin-management/plan.md`（`c31547d`、`6f13271`）
- `--snapshot-worker` 仍写在 `packages/supervisor/README.md:11,106` 与 `README.md:80`

### 被现行政策替代、不要搬回

Doctor `unlock`/`recover`/`rollback` 产品入口、recovery-only 模式、job 恢复 FSM、0.2.0 恢复卖点、09-08 计划里的升级失败回写旧环境、插件 README 旧 Recovery 节、演示里的整 Home 恢复。历史数字（179/135 PASS 等）保留为当时事实，不是本叶或现行门槛。

## 导航冲突（指出，本叶不改）

| 位置 | 冲突 |
|---|---|
| `tasks/todo.md:5` vs `:51` | 产品路径已符合 vs R 节仍写完成前不得声明 |
| `docs/let-it-crash.md:15` vs `:77` | 同上 |
| `tasks/plan.md:7-9`、`handoff-2026-09-14.md:5,11` | 仍写 R1–R6 待实施 / 白名单未实施；`todo.md:53-67` 与 `ee26d4c` 已勾 latest |
| `tasks/workbench-contract.md:5`、`pluginization-core.md:7`、`workbench-audit.md:5`、`let-it-crash-d-delivery.md:12` | 仍写 R pending |
| `tasks/releases/v0.3.0.md:16` | 发版当时白名单口径，被后来的 latest 提交取代，不宜改写成 0.3.0 当时已无白名单 |
| `src/shared/workbench.ts:76` | 仍有 `recoveryRequired`（B1，不是 A1 移植旧恢复页） |

根 `TODO.md` 已声明唯一账本是 `tasks/todo.md`，但 `IMPLEMENTATION_PLAN.md` / `tasks/plan.md` 仍交叉引用。

## 分类说明（避免按文件名套话）

- **主线新增 A**：无旧意图；行内写清它承接的后续能力（故障政策、LLM、Q 覆盖、0.3.0）。
- **历史 worker 且旧==导入**：只加了 let-it-crash 盖章或把恢复从“未做后续”改成“已撤销”。当时未跑/FAIL/Windows-only 句子还在，没有写成这次通过。
- **旧≠导入的 11 条**：导入点改的是标准安装、rc.2、换行；当前再叠加 let it crash / latest。插件 README 的架构节在导入点已被标准安装指南替换，角色分流改由 `docs/workbench.md` 承接。

完整逐路径 `oldIntent` / `currentEvidence` / `reason` / `verification` 见 JSON。同类文档引用了同一政策段落实处（例如 `docs/let-it-crash.md:15-20,70`），但每条都绑了该文件自己的段落或提交。

## 本叶未做

没有 `git merge` / checkout / commit；没有 `npm ci`、测试、浏览器、打包；没有读真实 `~/.dsh` 或凭据。历史验收次数和 q-coverage 未跑项都不能当作本轮通过。
