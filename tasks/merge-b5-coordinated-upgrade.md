# B5 CoordinatedUpgrade 提交失败留证

日期：2026-09-20。叶子只写：

- `src/main/coordinated-upgrade.ts`
- `tests/coordinated-upgrade.test.ts`
- `tasks/merge-b5-coordinated-upgrade.md`

未改 Supervisor / Host / shell / manifest / 锁、Git、公共 DTO。未读真实 `~/.dsh`。未跑全仓测试或构建。故障政策仍是 [let it crash](../docs/let-it-crash.md)。

本叶只去掉官方 DSH runtime 升级里**可达的自动回滚**。不是 B5 完成，也不是全部遗留恢复模块已清理。公开 `restore` / `recover` 仍为单一 unsupported 拒绝，外部 types 未改。

## 实际修改

`commitProfiles()` 在 staged→live rename 或 retarget 失败时不再调用 `restoreProfilesBackup()`（删新 live、把 backup 写回 live）。外层 `upgrade()` catch 仍不 rollback；提交阶段失败改看本次内存 `journalPhase`，不再用 `readJournal()?.phase` 把未知 journal 当成可清。

删除本文件无消费者的私有 `restoreProfilesBackup` / `rollbackSnapshot`。正常 stage / 安装仍用 copy、rename、retarget IO。

Journal：任意现存 `journal.json`（含未知 phase、损坏 JSON、symlink）都算未完成证据，新升级拒绝。`readJournal()` 对未知 schema 仍可返回 `undefined`，但 `writeJournal` 不得覆盖原字节。commit 开始后失败保留 committing journal、backup、snapshot 与已发布 live；提交前失败不切换 live/selected，只清本次未发布 stage。不能凭旧 journal 跨实例续跑或清理。

主跑曾 17/1：`failure before commit...` 在 `taskkill` 成功后立刻读 `child.exitCode`/`signalCode` 仍为 null。这是 Windows 上 ChildProcess 字段相对 OS 存活的观察竞态，不是停杀被放宽。测试改为：Node 已记录退出则通过；字段仍空则 `process.kill(pid, 0)` 必须 ESRCH，进程仍活则失败。

## 验证

```
npx tsx --test tests/coordinated-upgrade.test.ts
```

故障注入：

- `commit:backup`：原 live / selected 不变
- `commit:swap`：backup 留在 stage，不 restore 回 live
- `commit:retarget` / `commit:select`：新 live 与 backup 原现场保留，不 `select` / `selectExisting` 旧 runtime，不删新 live
- 原始注入错误保留；后续普通升级见 unfinished journal 拒绝、不 replay
- 未知 / 损坏 journal 原字节保留
- 原成功路径、snapshot 证据、web 隔离 dump、公开 restore/recover 拒绝仍覆盖
