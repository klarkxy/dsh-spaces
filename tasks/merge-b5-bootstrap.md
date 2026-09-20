# B5 bootstrap 消费 v2 组件清单

2026-09-20。没有独立的 `supervisor-bootstrap.test.ts`。现有 bootstrap 套件在 **`tests/workbench-plugin.test.ts`**（夹在 plugin/guide/view-bridge 用例里）。本叶按该文件更新，没有另开测试文件。

写入：

- `packages/plugin/src/host/supervisor-bootstrap.ts`
- `tests/workbench-plugin.test.ts`
- `tasks/merge-b5-bootstrap.md`

未改 Git、`package.json`、build-spaces、core Supervisor、`parseSupervisorArgs` / `SUPERVISOR_CLI_FLAGS` 表、launcher。未读真实 `~/.dsh`。未跑 `build:spaces`。

选择模块 `src/adapters/node/component-selection.ts` 按合同由 lockworker 实现。bootstrap **只 import** 其三个导出。本叶曾需要该文件才能加载；当前实现含 cold-start 预约检查，后续以其为准，bootstrap 不再改它。

## 行为

健康 attach 只读返回，不 stage、不改 pointer。`blocked` / `stale` 原样失败，不 cold start。

显式 cold start：

1. 校验 argv 绑定的 CLI、`execPath`、Home 为真实目录、toolsRoot 在 Home 外。
2. `readSelectedComponentPayload`：有 pointer 则权威使用，包括失败升级之后；**不**再用当前 bundled 覆盖。
3. pointer 损坏：失败，不回退 bundled，原文件保留。仅 ENOENT 视为缺 pointer。
4. 缺 pointer：在现有 `toolsRoot/coldstart.lock` 预约内 `validateComponentPayload` → `stageComponentPayload` → `selectComponentPayload`。
5. 选中组入口 `lib/supervisor/index.js`、worker `lib/supervisor/snapshot-worker.mjs`。`npm pack` 的 plugin / view-bridge 来自 **selected 完整 package**（`selected.packageRoot` 与 `selected.payloadRootLib/view-bridge`），不是源树。
6. argv 增加字面量 `--component-payload <selected.payloadRootLib>`。未写入 `SUPERVISOR_CLI_FLAGS`（等主 Agent 接到 `parseSupervisorArgs`）。

## 给主 Agent 的 import / flag

```ts
import {
  bootstrapSupervisor,
  COMPONENT_PAYLOAD_ARGV_FLAG, // "--component-payload"
  SUPERVISOR_CLI_FLAGS,        // 未改；不含 component-payload
} from "packages/plugin/src/host/supervisor-bootstrap";

import {
  stageComponentPayload,
  readSelectedComponentPayload,
  selectComponentPayload,
} from "src/adapters/node/component-selection";

import {
  validateComponentPayload,
  COMPONENT_PAYLOAD_ENTRIES,
} from "src/adapters/node/component-payload";
```

Cold-start 子进程 argv（在现有 home/bin/node/plugin/view/control/worker 之后）：

```text
--component-payload <selected.payloadRootLib>
```

`parseSupervisorArgs` 仍不认识该 flag。Supervisor CLI 接线后才能真正读它。spawn `cwd` 为 `selected.payloadRootLib/supervisor`，`entry` 为该组 `lib/supervisor/index.js`。

成功结果的 `payloadDir` 是 **selected.payloadRootLib**。健康 attach 仍返回调用方的源 `payloadRoot`（只读，不 stage）。

## Home 内源包

`validateComponentPayload` 拒绝真实 `~/.dsh` 下的 package root。`stageComponentPayload` 再拒绝 **当前 Home 内** 的源。桌面/开发 payload（`packages/plugin/lib` 或日后 `resources/spaces-payload/lib`）在 Home 外，可以 stage。

官方 `dsh plugin --profile web add` 把插件装进 Home 的 profile 树。若 bootstrap 的 `payloadRoot` 指向该安装，stage 会按合同失败。标准安装的可用源应是 Home 外的不可变拷贝（或桌面 resources），不能把 Home 内 plugin 树当 staging source。测试用临时 Home + Home 外 dummy 包，这是允许的。

## 实测

没有独立 bootstrap 文件。命令：

```text
npx tsx --test --test-concurrency=1 tests/workbench-plugin.test.ts
```

**25 pass / 0 fail / 0 skip**（含新增：v1 清单失败、pointer 权威、损坏 pointer 不回退；原 cold-start / 缺 payload / ordinary 不启动 / stale 不覆盖）。

并行跑全文件会抢 HomeController handle，需 `--test-concurrency=1`。未跑 `build:spaces`。`tests/workbench-endpoint-v2.test.ts` 里 **stale 不 cold-start** 通过；其余 attach/schema 失败属 B1，本叶未改那些文件。
