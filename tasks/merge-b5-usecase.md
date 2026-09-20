# B5 usecase：pack 全组 + 升级交接

2026-09-20。未改 Git、`package.json`、build、core Supervisor、`parseSupervisorArgs`、`tests/workbench-plugin.test.ts`（Host worker）。未读真实 `~/.dsh`。未跑全局 build。

写入：

- `packages/plugin/src/host/supervisor-pack.ts`
- `packages/plugin/src/host/supervisor-bootstrap.ts`
- `src/adapters/node/workbench-package-upgrade.ts`
- `tests/workbench-package-upgrade.test.ts`
- `tests/supervisor-pack.test.ts`
- `tasks/merge-b5-usecase.md`

## Pack / bootstrap

`packLocalArtifacts` 增加可选 `llmBridgeRoot`。提供时打 `@dsh-spaces/llm-bridge`，返回 `llmBridgeArtifact`。省略时仍只打 plugin + view-bridge。

bootstrap 从 **selected** `lib/llm-bridge` 传入 `llmBridgeRoot`，argv 增加已有 CLI 字面量：

```text
--llm-bridge-artifact <packed.llmBridgeArtifact>
```

已写入 `SUPERVISOR_CLI_FLAGS.llmBridgeArtifact`（与 `parseSupervisorArgs` 现有 flag 对齐）。`--component-payload` 仍是独立字面量。

标准安装的 first cold source **可以在临时 Home 内**（`profiles/web/node_modules/@dsh-spaces/plugin/lib`）。这不是产品限制。stage 源检查由 launcher worker 修；manifest 对授权真实 Home 的放行由主 Agent 修。本叶测试用临时 Home，不碰 `~/.dsh`。

## WorkbenchPackageUpgrade

```ts
type WorkbenchPackageHandoffInput = {
  planId: string;
  snapshotId: string;
  payload: ValidatedComponentPayload;
};
type WorkbenchPackageHandoff = (
  input: WorkbenchPackageHandoffInput,
  ctx: WorkbenchJobContext,
) => Promise<void>;

options.toolsRoot?: string
options.handoff?: WorkbenchPackageHandoff
```

`execute` 在任何 stop/写 marker 之前要求 `toolsRoot` + `handoff`，否则 `unavailable`。预览仍是精确 version + 归档 digest。

候选 plugin 归档必须含完整 v2 清单：逐件读 **清单声明的每个文件字节**，核对 sha256/size，并读各组件 `package.json` 身份。不只查 3 个 supervisor 文件，也不只信清单上的 label。缺/篡改 worker 或 llm-bridge：`describe()` 为 `undefined`，`execute` `invalid-input`，不 stop。

安装 plugin+view 之后：`validateComponentPayload(installed @dsh-spaces/plugin/lib)` → `stageComponentPayload(home, toolsRoot, installedLib)` → 与候选归档文件哈希比对 → `handoff({ planId, snapshotId, payload: staged })`。**不**调用 `reinitializeManager`。无回滚。失败保留快照/部分安装/marker 或 abandoned 回执。`recover` 仍 unsupported。

`reinitializeManager` 仍留在 options 上，避免 Supervisor 构造裂开。主 Agent 应改成传入 `toolsRoot` 与 launcher `handoff`，并在 runtime release 上做正常旧进程停机，而不是旧 manager 再拉起。

## 实测

```text
npx tsx --test --test-concurrency=1 tests/workbench-package-upgrade.test.ts tests/supervisor-pack.test.ts
```

- upgrade：**19 pass**（含缺 port 不 stop、缺 llm/篡改 worker 不 stop、成功 handoff digest、无 reinitialize）
- pack/bootstrap：**5 pass**（llm 全组 pack、省略 llm、错误包名、`--llm-bridge-artifact`、Home 内标准安装源可 stage）

未跑 `build:spaces` 或全仓测试。
