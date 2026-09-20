# Interfaces 语义审计（A1）

组：`interfaces`。对照：`old=51911e481961408ad77758b0123653c0fc1e2bdd`，`imported=1f339acc4c616ed634760f2735823f5ce83b9cd3`，`main=c22c47fd37629e3bb852f7702d68624d3a73453d`。输入 125 条路径全部有结论，无 pending。A1 审计当时只读 Git 对象。随后仅静态修补两个证据脚本和本 md；未 merge、未改产品合同、未跑整套历史 UI 脚本。

## 怎么判

旧树与导入点有 91/125 条 blob 相同；导入点是 `1f339ac Restore Spaces workbench and standard DSH plugin installation`，旧分支另有 16 个独有提交（HEAD `51911e4` 含包升级验证与托盘隐藏）。主线在导入后再做 let it crash、latest 渠道、全局 LLM、模板/分享/批量。恢复/接管/永久 CLI 白名单按现行政策记 **superseded**；标准安装、精确版本、正常快照创建/删除、安装 worker、包升级成功路径、LLM 打包记 **already-covered**。只有旧分支仍有价值且当前树没接上的意图才是 **missing**。B 阶段合同/分发欠账写入 `baselineRisks`，不当成旧分支补丁。

## 需要移植的候选（A 阶段 missing）

JSON 结论未改，仍记这两条为 missing。随后只对这两个脚本做了静态修补，没有重跑真实 UI/CLI 证据，也没有改 `interfaces.json`。

1. **`scripts/verify-workbench-dual-control.mjs`**
   旧 `51911e4` 断言：Web 持有 Home 时桌面不得出现「接管/Take over/移交/Hand off」。导入点改成等待「只读 — Web 工作台正在控制此 Home」，主线 `d267a20` 删掉了 `ControllerStatus` 徽章。静态修补：删除该徽章 `waitFor`；按按钮 role 断言当前桌面没有接管/移交按钮；保留 IPC `ownerKind=web` / `writable===false`、manager 不进普通轨、写 IPC 拒绝等实际检查。截图只记录当前外观，不声称只读徽章或整段 UI 已通过。

2. **`scripts/verify-workbench-rc2.mjs`**（只改默认 CLI 路径，不写回白名单）
   默认 bin 改回仓库隔离树 `.sandbox/spaces-unknown-cli/.../lib/bin.js`；缺失则清楚失败，并要求 `DSH_TEST_RC2_BIN` 或 `DSH_TEST_BIN`。仍是官方 0.1.5-rc.2 历史证据脚本。顶部原「产品写门含 rc.1 和 rc.2」已标明失效，只作历史测试版本说明。未改产品 latest 渠道策略，也未迁移其他脚本里的个人路径。

## 计数

从 `tasks/merge-audit/interfaces.json` 每一行的 `decision` 重算，与 `summary.counts` 一致。较早草稿 107/16 作废，不以它为准。

| decision | 条数 |
|---|---|
| already-covered | 111 |
| superseded | 12 |
| missing | 2 |
| 合计 | 125 |

superseded 12 条：`packages/plugin/src/workbench/recovery.tsx`，`src/renderer/src/App.tsx`，`src/renderer/src/components/MaintenanceDialog.tsx`，`src/renderer/src/recovery.ts`，`tests/coordinated-upgrade.test.ts`，`tests/frontend-recovery.test.ts`，`tests/maintenance-responsiveness.test.ts`，`tests/spaces-doctor.test.ts`，`tests/workbench-doctor.test.ts`，`tests/workbench-jobs.test.ts`，`tests/workbench-maintenance.test.ts`，`tests/workbench-supervisor.test.ts`。

主线新增 UI（模型中心、Space 绑定、分享面板、创建时共享连接）、标准安装脚本/CI job、llm-bridge 打进 `pack-spaces-plugin` / `build-spaces`、包升级成功路径 UI 与单测，均已在当前树。旧恢复成功断言已改成 `unsupported`/`forbidden`。

## B 阶段欠账（不是旧分支遗漏）

- `tests/workbench-package-upgrade.test.ts` 未进入 `package.json` 的 `test` / `test:workbench` / CI。旧 `51911e4` 同样没挂脚本，只加了 `test:workbench:recovery`。计划 B5 已要求显式接入。
- `.github/workflows/plugin-distribution.yml:30-33` 只核对 plugin/view-bridge 版本；`scripts/pack-spaces-plugin.mjs` 已打包 llm-bridge。属 B5 分发清单，不是旧文件。
- 工作台 `RecoverySurface` 仍有 acquire 文案（`recovery.tsx` / `workbench/i18n.ts`）；指南 `GUIDE_COPY` 仍写 “Recovery required”。属 B1/B4 合同清理。
- `tests/workbench-maintenance.test.ts` 有一条标题仍写 “manager config restore reinitializes…”，正文已断言 `forbidden`。
- 若干历史验收脚本（含本叶 rc2/dual-control）仍硬编码 `C:/Users/admin/...`；旧树同样有一批，不整批当遗漏。

## 保护项（后续改造不得拆掉）

let it crash；全局 LLM；模板/分享/批量；latest 渠道但执行精确版本；标准预构建插件安装。`electron.vite.config.ts` 与 `package.json` asarUnpack 仍打包 `snapshot-worker`；`scripts/build-spaces.mjs:65` 仍把 worker 打进 supervisor。这是运行时安装 IO，不是恢复产品。`plugin-restore-point` 测的是写入范围记录，不是快照恢复。

## 未做

没有改 `interfaces.json` 结论、其他源码、manifest、锁文件或 Git。没有执行 merge、真实 Home、凭据读取、整套历史 UI/CLI 证据脚本或运行验收。对本叶两个脚本只做了 `node --check` 和受 `invoked` 守卫的模块加载；那不是 dual-control / rc2 真实运行通过。协调者负责新阶段验收。
