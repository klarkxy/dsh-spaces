# B5 Node 模块迁移脚本（准备叶）

> 本文件保留准备叶交付时的记录。主 Agent 后续已执行迁移，类型与相关回归结果见 [合并执行与验收记录](merge-execution.md)。

2026-09-20。本叶只新增脚本和本报告。未 `--apply`，未改产品源码。主 Agent 在全部路径所有者释放后执行。

## 命令

```text
node .sandbox/migrate-node-modules.mjs
node .sandbox/migrate-node-modules.mjs --apply
node .sandbox/migrate-node-modules.mjs --self-test
```

默认 dry-run：打印 moves/deletes/rewrites，目标已存在则失败并退出 1。只认 cwd 工作树。无 Git。单文件 rename，不删目录树。

`--apply` 仅主 Agent 显式执行。

## 稳定映射

`src/main/<name>` → `src/adapters/node/<name>`（文件名不变）：

atomic.ts, toolchain.ts, terminate-process.ts, space-templates.ts, space-share.ts, space-share-zip.ts, snapshot-worker.ts, snapshot-store.ts, snapshot-executor.ts, runtime-store.ts, runtime-descriptor.ts, profile-registry.ts, process-manager.ts, plugin-ops.ts, plugin-library.ts, plugin-catalog.ts, patch-writer.ts, package-source.ts, owned-process-record.ts, hub-settings.ts, home-guard.ts, dsh-endpoint.ts, dsh-cli.ts, diagnostics.ts, create-profile.ts, coordinated-upgrade.ts, seed-plugin-catalog.json

另：`src/adapters/desktop/control-residue.ts` → `src/adapters/node/control-residue.ts`。`desktop/index.ts` 改为再导出 node 副本。

## 留下的 main（OS 壳）

index.ts, tray.ts, view-manager.ts, native-theme.ts, updater.ts, dsh-home.ts, desktop-shell-protocol.ts, desktop-shell-runtime.ts

## 删除（apply 时）

独立复查无产品消费者：

- `src/main/space-icon.ts`（Electron 选图；`src/shared/space-icon.ts` 与快照模块不删）
- `src/main/onboarding.ts`
- `src/main/smoke.ts`

`src/main/maintenance-gate.ts` 只是 core 再导出。消费者改为 `src/core/application/maintenance-gate.ts`，然后删包装。

## 改写规则

TypeScript `createSourceFile` 取字符串字面量（含 no-substitution template）。

- 相对 specifier（仅 `./` 与 `../`）：按原文件解析；目标若迁移则改成指向新位置；被迁移文件自身的相对路径按新目录重算（`../shared` → `../../shared`）。扩展名/是否带 `index` 保持原风格。单独的 `"."` / `".."` 不当 specifier。
- 整段 posix：`src/main/foo.ts` → `src/adapters/node/foo.ts`（含 `join(root,'src/main/foo.ts')`）。
- `join(..., "src", "main", "<moved file>")` 把 `"main"` 改成 `"adapters/node"`。
- 不改 docs、`*.md`、`tasks/merge-audit/**`、merge-preparation JSON、历史文案。不扫 `node_modules` / `lib` / `out` / `.sandbox`。

## 本机校验（无产品写入）

```text
node .sandbox/migrate-node-modules.mjs --self-test
self-test ok

node .sandbox/migrate-node-modules.mjs
mode: dry-run
moves: 28
deletes: 4
rewriteCount: 291
collisions: none
residual-refs: none
dry-run: no files written
```

scratch 覆盖：迁移、相对路径重算、同目录 import、路径字面量、join 分段、dead delete、maintenance-gate 改 core、docs 不动、目标碰撞失败。

## apply 后主 Agent

1. 路径所有者已释放后再 `--apply`。
2. 重建 `packages/*/lib`（扫描排除了生成物；旧 lib 里仍有 `src/main/...` 直到 rebuild）。
3. `tsconfig.node.json` 已包含 `src/main/**` 与 `src/adapters/**`，不必为映射改 glob。
4. `electron.vite.config.ts` 入口仍是 `src/main/index.ts`。
5. 若有人在 apply 后新加 `src/main/<moved>` 引用，用脚本 residual 段再扫。
