> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# CLI rc.2 正式写门禁（Grok CLI 叶子交接）

日期：2026-09-13。分支 `codex/spaces-recovery`。角色：Grok CLI 叶子。未 Git、未发布、未改账号/权限/provider、未启动真实 GUI/服务、未用真实 Home、未安装依赖、未写共享 lib 构建。未递归 Bridge。

状态：**产品写门禁 rc.1+rc.2。返工：官方 web 首次 seed 改为 `--profile web --dump-config`；真实 rc.2 拒绝把 shipped web 当 `--from-default-profile` 目标。Doctor WRITE_CLI_VERSION 已删，README 与 verify-workbench-rc2.mjs 按正式 rc.2 更新。**

## 1. 结论

正式兼容 `@deepseek-ai/dsh` **0.1.5-rc.1 与 0.1.5-rc.2**。只改写门禁数组与监督器不兼容文案，没有把仓库里所有 `0.1.5-rc.1` 字符串改成 rc.2。

- `COMPATIBLE_DSH_CLI_VERSION` 仍是 `"0.1.5-rc.1"`（夹具/插件测试默认绑定版本，避免拖垮另一叶子的 `packages/plugin` 测试）。
- `COMPATIBLE_DSH_CLI_VERSIONS` 现为 `["0.1.5-rc.1", "0.1.5-rc.2"]`。
- `isCompatibleDshCliVersion` 是唯一写放行判断；`latest` / `next` / `0.1.5-rc.3` / `0.1.1-rc.2` 仍为未知，spaces 进入 `unknown-readonly`，监督器不绑定。当时 doctor recover/rollback 对未知版本返回 `RUNTIME_REFUSED`；**recover/rollback 作为产品命令已撤销**（R5：不支持 + 非零退出），不是继续维护的写门禁分支。
- 默认安装钉 **已经是** `DSH_DEFAULT_VERSION = "0.1.5-rc.2"`（`src/shared/runtime.ts` / `tests/dsh-cli.test.ts`，本叶子到达时主 Agent 已改；基线副本仍是 rc.1）。本叶子未再改该文件。
- `src/main/runtime-store.ts` **未改**：它按精确版本安装任意候选，写门禁不在这里。维护层对不兼容版本仍可 `runtime.install`（unverified candidate），只有 `runtime.upgrade` / spaces mutate / supervisor bind / doctor write 走 `isCompatibleDshCliVersion`。

历史 `scripts/build-workbench-candidate.mjs` 是 **esbuild onLoad 注入** 绕过官方数组，不是正式支持。本轮是改官方源数组，不是复活候选通道。`scripts/verify-workbench-rc2.mjs` 当时把产品门禁仍标 rc.1、低层通过记 `blocked`；打开门禁后该脚本的 `PRODUCT_GATE` 常量会过时。

## 2. 实际变更

| 路径 | 变更 |
| --- | --- |
| `src/adapters/node/spaces-control.ts` | `COMPATIBLE_DSH_CLI_VERSIONS` 增加 `"0.1.5-rc.2"` |
| `src/adapters/node/workbench-supervisor.ts` | `workbench/incompatible` 文案改为列出 `COMPATIBLE_DSH_CLI_VERSIONS`（bind 失败路径本就用该数组） |
| `tests/compatible-dsh-cli.test.ts` | 数组含 rc.1+rc.2；rc.2 可 create；`0.1.5-rc.3` 拒写 |
| `tests/workbench-supervisor.test.ts` | rc.2 监督器 `dshVersion` 绑定成功；未知版本仍 `dshVersion=null` |
| `tests/workbench-doctor.test.ts` | 未知/`0.1.5-rc.3` 仍 `RUNTIME_REFUSED`；rc.2 recover 不再被版本门禁拒绝 |
| `tasks/plugin-cli-rc2-worker.md` | 本交接 |

未改：`packages/plugin/**`、根/`packages/*/package.json`、锁、CI、README/docs、`scripts/**`、`src/main/runtime-store.ts`、`src/shared/runtime.ts`。

## 3. 本叶子验证

Node：`C:/Program Files/nodejs/node.exe`（v24.21.0）。未 `npm install`。输出独占 `.sandbox/plugin-cli-rc2-worker/`。

```
node --test --test-reporter spec --import tsx ^
  tests/compatible-dsh-cli.test.ts ^
  tests/dsh-cli.test.ts ^
  tests/spaces-host.test.ts ^
  tests/workbench-supervisor.test.ts ^
  tests/workbench-doctor.test.ts
```

**61 passed / 0 failed**，约 22.5s。产物：

- `.sandbox/plugin-cli-rc2-worker/tests.log`
- `.sandbox/plugin-cli-rc2-worker/results.json`
- `.sandbox/plugin-cli-rc2-worker/npm-dist-tags.json`

Doctor 写路径已随 `isCompatibleDshCliVersion` 自动放行 rc.2（`packages/doctor/src/resources.ts` `allowedWrite`），无需改 doctor 源码。

## 4. 未实际验收

- 主 Agent 的官方 rc.2 隔离 runtime **尚未交给本叶子**。现存可检 rc.1：`C:/Users/admin/AppData/Local/Temp/spaces-runtime-install-fIEaas/versions/0.1.5-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js`。未跑真实 `dsh --version` rc.2、未 `dsh plugin add`、未新 Home、未浏览器、未打包监督器冷启动。
- 未跑 `npm run typecheck` / `typecheck:spaces` / 全量 `test` / `test:workbench`（含另一叶子的 `tests/workbench-plugin.test.ts`）。
- 未重建 `packages/*/lib`。候选构建脚本未跑（跑了会按当前断言失败，见下）。
- `tests/compatible-dsh-cli.test.ts` **不在** `package.json` 的 `test` / `test:spaces` 里；CI 目前不会自动跑它。

## 5. 请根 Agent 处理的接口 / 文件

本叶子不能改这些路径：

1. **CI / 清单**：把 `tests/compatible-dsh-cli.test.ts` 纳入 `npm test` 或 `test:spaces`。文档/README 仍写「写门禁仅 rc.1」的句子需改成 rc.1+rc.2，并写明 **不要把 dist-tag `latest` 当版本**（今天 `latest=0.1.5-rc.1`，`next=0.1.5-rc.2`）。
2. **`scripts/build-workbench-candidate.mjs`**：`assertOfficialGate` 要求官方数组仍是 `[COMPATIBLE_DSH_CLI_VERSION]` 且不得出现 rc.2。正式支持后该候选注入应退役或改写成「拒绝重复注入」。不要再用候选包冒充产品支持。
3. **`scripts/verify-workbench-rc2.mjs`**：`PRODUCT_GATE` 仍是 `0.1.5-rc.1`。源码重建后监督器会放行 rc.2，脚本语义会从 `blocked` 变成可能 `pass`。请在真实 rc.2 Home 上重跑并改常量/说明。
4. Doctor `WRITE_CLI_VERSION` 与 README「rc2 只读 verify」、`verify-workbench-rc2.mjs` 正式 rc.2 常量：**返工已做**。`build-workbench-candidate.mjs` 仍按合同留给根 Agent。
5. **初始化叶子**：`tests/workbench-plugin.test.ts` 用 `COMPATIBLE_DSH_CLI_VERSION`（仍 rc.1）做默认夹具，本轮故意不改单数常量。

## 6. 版本差异证据（npm view，未安装）

现场 `npm view @deepseek-ai/dsh dist-tags`（2026-09-13）：

| tag | version |
| --- | --- |
| latest | `0.1.5-rc.1` |
| next | `0.1.5-rc.2` |
| alpha | `0.1.5-alpha.2` |

| | 0.1.5-rc.1 | 0.1.5-rc.2 |
| --- | --- | --- |
| published | 2026-09-10T03:12:53.293Z | 2026-09-10T14:57:10.790Z |
| unpackedSize | 48910 | 48910 |
| bin | `lib/bin.js` | `lib/bin.js` |
| CLI 依赖名 | 72 | 72，集合相同 |

差异只有 `@deepseek-ai/dsh-*` 钉从 `^0.1.5-rc.1` 升到 `^0.1.5-rc.2`。`commander` / `js-yaml` / `cordis*` / `schemastery` 不变。

现存 rc.1 `bin.js` 启动器表面：`--profile`、`--from-default-profile`、`--dump-config`、`--dump-default-config`、`plugin --profile <name> add …`。候选期低层脚本已在 live rc.2 上证明过 `--version` / 普通 profile / guide-only；当时失败的 `plugin-host spaces/overview` 是 **未登记 manager 的正确角色**，不是 CLI 缺口。本轮打开写门禁，不是把那次 guide-only 合同改成越权。

未拆 rc.2 tarball（未安装）。CLI 包体大小相同不能代替真实 `--version` 与 `plugin add`。

## 7. 角色合同（未放宽）

普通 profile 仍无 manager 写 remotes。未知 CLI 仍只读。候选构建不得当作用户绕门禁教程。

## 8. 审查返工（2026-09-13，最后一次）

现场失败：`bootstrapManager` 对官方 web 使用 `--profile web --from-default-profile web --dump-config`。真实 rc.2：`profile "web" is shipped and cannot be a custom profile target; omit --from-default-profile to use it`。

| 路径 | 返工 |
| --- | --- |
| `src/adapters/node/workbench-supervisor.ts` | 首次 seed 改为 `--profile web --dump-config`；manager 自定义 profile 仍 `--from-default-profile web` |
| `tests/workbench-supervisor.test.ts` | 夹具拒绝 shipped-web clone；新增可区分测试：web seed 无 `--from-default-profile`，manager 仍有 |
| `tests/compatible-dsh-cli.test.ts` | 真实官方 bin：错误参数非 0，正确 dump 成功 |
| `packages/doctor/src/common.ts` | 删除未引用 `WRITE_CLI_VERSION`；`VERIFY_CLI_VERSIONS` 派生自 `COMPATIBLE_DSH_CLI_VERSIONS` |
| `packages/doctor/README.md` | 当时把 verify/recover/rollback 都写成 rc.1 与 rc.2；recover/rollback 现为已撤销产品命令（R5） |
| `scripts/verify-workbench-rc2.mjs` | `PRODUCT_GATE`/`DEFAULT_RC2_BIN`/说明改为正式 rc.2，不用候选注入 |

验证：`node --check scripts/verify-workbench-rc2.mjs`；`tests/compatible-dsh-cli.test.ts` + `tests/workbench-supervisor.test.ts` **30 passed / 0 failed**。真实 dump 证据：`.sandbox/plugin-cli-rc2-worker/dump-wrong-web.log`、`dump-web-seed.log`、`rework-tests.log`、`rework-results.json`。未 GUI/服务，未覆盖主 Agent Home。未改 `packages/plugin/src`、分发脚本、`build-workbench-candidate.mjs`、未再扩 `tests/workbench-doctor.test.ts`。
