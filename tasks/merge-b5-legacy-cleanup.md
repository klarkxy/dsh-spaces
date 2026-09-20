# B5 bounded leftover removal (desktop writers and dead restore)

日期：2026-09-20。叶子只清理桌面壳已不再拥有后台之后的无生产消费者路径。不是 B5 完成，也不是制品/升级/快照 worker 清理。

未改 `src/main/index.ts`、Supervisor、`src/shared/workbench.ts`、snapshot-store/executor、构建脚本、`package.json`。未读真实 `~/.dsh`。未跑全仓测试、构建或 runtime install。故障政策仍是 [let it crash](../docs/let-it-crash.md)。正常快照创建/列表/删除和 snapshot-worker 运行时安装仍为产品要求，本叶未动。

脚本跟进只写 `scripts/validate-llm-secrets.mjs`、`scripts/verify-plugin-install-write-scope.mjs` 和本报告。

## 导入确认

生产源码中，下列模块除桶文件外没有调用方：

- `src/main/desktop-llm.ts`
- `src/adapters/desktop/controller.ts`
- `src/adapters/desktop/home-control.ts`
- `src/adapters/desktop/graceful-kill.ts`

`src/shared/restore-selected.ts`、`src/core/application/restore-session.ts`、`src/core/ports/restore.ts`、`src/main/restore-session.ts`、`src/main/plugin-restore-point.ts` 的调用方原为自身测试与两个过时脚本；脚本已在跟进中去掉已删 helper。

`src/adapters/desktop/control-residue.ts` 与 `src/adapters/desktop/service-client.ts` 仍被 runtime/shell 使用，保持原文件。桶文件 `src/adapters/desktop/index.ts` 只保留 `inspectControlResidue` / `inspectHomeToolchain`（`src/main/index.ts` 从该桶导入）。

`FULL_SPACES_PACKAGE` / `isFullSpacesManagerSpec` / `isUnresolvedPluginAlias` 的现行生产消费者只有三个：`src/main/space-share.ts`、`src/core/application/space-recipe.ts`、`src/adapters/node/workbench-products.ts`。已抽到 `src/shared/plugin-spec.ts`，只改这三处导入。`workbench-maintenance.ts` 仍用自己的 `FULL_SPACES_PACKAGE` 常量，本叶未改。

## 删除的文件

| 路径 | 原因 |
|---|---|
| `src/main/desktop-llm.ts` | 桌面合成 `llm.apply` succeeded job；壳已不装配 |
| `src/adapters/desktop/controller.ts` | 旧桌面写者；无生产调用 |
| `src/adapters/desktop/home-control.ts` | 仅被已删 controller / 旧测试使用 |
| `src/adapters/desktop/graceful-kill.ts` | 仅桶再导出 |
| `src/shared/desktop-controller.ts` | 死 DTO/IPC；插件身份已抽出 |
| `src/shared/restore-selected.ts` | 旧渲染器选中视图；无生产调用 |
| `src/core/application/restore-session.ts` | 死恢复编排 |
| `src/core/ports/restore.ts` | 仅服务 RestoreSession |
| `src/main/restore-session.ts` | 对 core RestoreSession 的 Node 包装 |
| `src/main/plugin-restore-point.ts` | 无产品调用方 |
| `tests/desktop-controller.test.ts` | 唯一主题是已删 controller（有效断言已搬家，见下） |
| `tests/restore-selected.test.ts` | 唯一主题是已删选中视图 helper |
| `tests/restore-session.test.ts` | 唯一主题是已删 restore 编排；会驱动 snapshot restore，本叶不删 snapshot-store |
| `tests/plugin-restore-point.test.ts` | 唯一主题是已删 restore-point schema |

`packages/core/src/index.ts` 与 `packages/core/lib/index.d.ts` 去掉 `restore-session` / `ports/restore` 再导出。`packages/core/lib/index.js` 仍是上次 `build:spaces` 产物，要等主 Agent 重建才会从 bundle 去掉 restore 实现。

## 证据处置（未整份盲删）

| 原断言 | 处置 |
|---|---|
| 死/活/未知所有者不被抢占；`reclaimDead` 不自动接管 | **保留** `tests/home-controller.test.ts`（未改该文件） |
| `MaintenanceGate` + `HomeOperationLock` 串行、失败释放 | **改写**进 `tests/spaces-lock.test.ts`，不再经过 `createDesktopHomeControl` |
| 截断/未完成 job 为残留且不改写原字节 | **搬到** `tests/cooperative-children.test.ts`（`inspectControlResidue`） |
| 死实例记录不拦、活残留仍拦、原字节不变 | **搬到** `tests/cooperative-children.test.ts` |
| 未完成 mutation journal 被报告且不改写 | **搬到** `tests/cooperative-children.test.ts`（只读残留扫描仍是生产路径：shell `publicReasons`） |
| home-control 在 journal 存在时拒绝 mutate / `snapshot-restore` | **退役**：该写路径已删。snapshot restore 产品拒绝仍在 maintenance（他叶） |
| 旧 `DESKTOP_WRITE_IPC_CHANNELS` 含 `llmCredential`、不含 `llm` | **替换**为现行封闭 `DESKTOP_SHELL_IPC` 边界，见 `tests/llm-secret-leaks.test.ts`（不是旧 bypass 列表） |
| job/catalog/operations 不落活密钥 | **保留** `tests/llm-secret-leaks.test.ts` |
| `isFullSpacesManagerSpec` / 未解析 alias / 不全量安装 manager | **搬到** `tests/space-recipe.test.ts`；download 拒绝 `npm:` alias 加在 `tests/workbench-products.test.ts`；既有 `tests/space-share.test.ts` “import does not auto-install the full Spaces manager” 仍在 |
| 只读启动不写 Home / 不 bootstrap / 不 recover | **退役** DesktopController 路径。壳侧负向装配锁仍在 `tests/frontend-recovery.test.ts`（本叶未改） |
| plugin-restore-point 排除 sessions/storages/credentials | **退役**（恢复点 schema 已删）。`tests/write-paths.test.ts` 仍锁 `profiles/web` 写入 |
| RestoreSession 注入 runtime descriptor | **退役**（恢复编排已删）。`tests/spaces-core.test.ts` 去掉该用例和 restore 源文件清单 |

未改、仍承担有效锁/残留/秘密覆盖的套件：`tests/home-controller.test.ts`、`tests/spaces-lock.test.ts`、`tests/cooperative-children.test.ts`、`tests/llm-secret-leaks.test.ts`、`tests/space-recipe.test.ts`、`tests/space-share.test.ts`、`tests/workbench-products.test.ts`、`tests/spaces-core.test.ts`、`tests/write-paths.test.ts`、`tests/frontend-recovery.test.ts`。

## Grep

生产/测试 `.ts/.tsx/.js/.mjs` 中，已删模块的剩余引用只剩 `tests/frontend-recovery.test.ts` 的负向断言（`createDesktopLlmHost` / `createDesktopController` 不在 `src/main/index.ts`，仍成立）。两个过时脚本已改，不再导入已删路径。

`plugin-spec` 生产导入仅 space-share / space-recipe / workbench-products。

## 选定测试（清理叶）

```
npx tsx --test --test-concurrency=1 tests/llm-secret-leaks.test.ts tests/spaces-core.test.ts tests/spaces-lock.test.ts tests/cooperative-children.test.ts tests/space-recipe.test.ts tests/space-share.test.ts tests/workbench-products.test.ts
```

**89 pass / 0 fail / 0 skip。** 未跑全仓、`npm test`（其文件列表仍含已删测试）、typecheck、构建、snapshot 或 runtime install。

## 脚本跟进（仅两脚本 + 本报告）

未改 `package.json`、构建、desktop 源码或其他 worker 路径。未读真实 `~/.dsh`。未跑官方 CLI 实测、npm pack 发布或全量 write-scope 实验。

### `scripts/validate-llm-secrets.mjs`

扫描现行 Supervisor / Host / jobs / shared shell / 凭据通道，去掉已删 `desktop-controller` / `desktop-llm` 和旧 write IPC 必须含 `llmCredential` 的期待。

SECRET_SCAN：llm 域/服务/存储、`llm-host`、`workbench-jobs`、`workbench-http`（Node + Host）、`workbench-supervisor`、`llm-api`、`desktop-shell`、preload、llm-bridge、Host `workbench-manager`、工作台 llm UI。

保留：`sk-` 活密钥、jobs/operations 秘密 denylist、share `SPACES_LLM_` + `sk-`、recovery 产品词。新增：凭据方法仍是 `saveConnectionWithCredential`；Supervisor/Host HTTP/Remote 仍有 `llmCredential`；`DESKTOP_SHELL_IPC` 通道名不含 llm/credential/secret；preload 只 invoke `DESKTOP_SHELL_IPC`。

```
node scripts/validate-llm-secrets.mjs
```

**PASS  llm secret and recovery-product scan**

### `scripts/verify-plugin-install-write-scope.mjs`

去掉 `plugin-restore-point`。测量分类改成本脚本 `classifyWritePath`。preflight 用无秘密 64-hex hash manifest，排除 sessions/storages/web/credentials。完整实验（未在本叶跑）仍测 add/remove 写入范围，并把 `restore-point.json` 换成 `write-scope-manifest.json`；拷回只做 baseline digest 比对，不是产品恢复。web 的 sessions/storages 标记必须不被安装写入。

```
node --import tsx scripts/verify-plugin-install-write-scope.mjs --preflight
```

**PASS** disposable Home 必选且拒绝真实 Home；classifier/manifest 不含 session/storage/web/credential 路径。

## 主 Agent 后续

- `package.json` 的 `test` / `test:workbench` 仍列出 `restore-selected`、`plugin-restore-point`、`restore-session`、`desktop-controller`。
- `npm run build:spaces` 才会刷新 `packages/core/lib/index.js` 和 core 声明拷贝。
- 完整 write-scope 实验仍要官方 CLI + 隔离 Home，不是本叶。

## Primary default-suite 两测修复（仅测试 + 本报告）

Primary `npm test` 249 pass / 2 fail。本跟进只改 `tests/coordinated-upgrade.test.ts`、`tests/sample-plugins.test.ts` 和本报告。未改 production、maintenance.ts、core、Git、真实 Home。未重跑全仓。

1. `interrupted snapshot restore is not recovered by CoordinatedUpgrade`：不再调用 `SnapshotStore.restore`（现已 unsupported，无法制造 interrupted journal）。改为写入现行 `parsePending` / `parseJournal` 可接受的历史 `pending-restore.json` + `.dsh-spaces-restore/journal.json` 原字节。`recover` 拒绝后 pending/journal 原字节仍在、`pendingRestore()`/`restoreJournal()` 仍可读、live profile 与 runtime pointer 未写、后续 `upgrade` 仍因未完成 restore 证据拒绝。
2. sample-plugins maintenance ports 缺 v2 `observation()`，preview 在 `storeable` 包成 `workbench/failed`。ports 增加固定 64-hex `serviceEpoch`/`expectedRevision`。打包插件 A 成功 / B crash 仍可加载 A / C broken 部分失败（notes 失败、lab 未装）仍覆盖。

```
npx tsx --test --test-concurrency=1 tests/coordinated-upgrade.test.ts tests/sample-plugins.test.ts
```

**20 pass / 0 fail / 0 skip**（upgrade 18 + sample-plugins 2）。
