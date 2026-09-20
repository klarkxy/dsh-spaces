# B5 运行锁交接原语

日期：2026-09-20。叶子只写：

- `src/adapters/node/home-controller.ts`
- `tests/home-controller.test.ts`
- `tasks/merge-b5-lock-transfer.md`

未改 `home-operation-lock.ts`、Git、公共 DTO、Supervisor / 启动器接线。未读真实 `~/.dsh`。故障政策仍是 [let it crash](../docs/let-it-crash.md)。

本叶是 HomeController 的**正常受控交接原语**，不是 B5 完成，也不是 launcher 接线。

## 接口

```ts
homeControlDigest(home, options?) → digestHomeIdentity(canonicalHome(home, options))

transferToLauncher({ nonce, binding, launcher? }): Promise<HomeControlHandoffToken>
authorizeHandoff({ token, target: { pid, startedAt } }): Promise<HomeControlHandoffToken>
acceptHandoff({ token, kind, endpoint? }): Promise<HomeControlHandle>
```

`HomeControlHandoffBinding`：`homeDigest` / `serviceEpoch` / `artifactDigest` 均为 64hex；`handoffId` 为 `[A-Za-z0-9._:-]{8,128}`。

`homeDigest` 必须等于协议 `digestHomeIdentity(canonical)`（`dsh-spaces-home-v1:` 前缀）。`serviceEpoch` 必须等于 `deriveServiceEpoch(当前 owner.nonce)`（`dsh-spaces-epoch-v1:` 前缀）。nonce/PID 通过后、替换 owner 前比较；不匹配 `binding-mismatch`，原字节不变。

Token 含 `secret`；`inspect()` 的 `handoff` 证据不含 secret / original.nonce。`acquire` 全程 busy。handoff 期间 `release` 拒绝。`reclaimDead` 对交接记录返回 `{ reclaimed: false, reason: "handoff" }`。

同一 `run/` 原子替换 owner。`HomeOperationLock.run("control-handoff")` 只包住单次写。写失败保留旧 owner 或明确 incomplete。v2 / 未知 version 损坏记录 inspect `held/ambiguous`，原字节不动。旧无 version owner 仍可读。

调用方负责停机确认和把 token 交给本机 launcher；目标 pid/startedAt 由 launcher 进程给出。本叶不接线产品升级。

## 验证

```text
npx tsc --noEmit --strict --skipLibCheck --module ESNext --moduleResolution bundler --target ES2022 --isolatedModules --allowImportingTsExtensions --esModuleInterop --types node src/adapters/node/home-controller.ts tests/home-controller.test.ts
npx tsx --test tests/home-controller.test.ts
```

P2 修正后：**33 pass / 0 fail**（含真实子进程竞争、旧 release / reclaim 拒绝）。新增：

- `homeControlDigest` 与 `digestHomeIdentity` 同 Home 相等，且不等于 `sha256(canonical)`
- 伪造 64hex `serviceEpoch`（`00`.repeat(32)）→ `binding-mismatch`，owner 字节不变
- 非 64hex epoch（`epoch-test-1`）输入 `invalid-token`；磁盘上该格式的 v2 记录 held/ambiguous

Astra 曾对三个 atomic rename 失败阶段注入 EIO：无空窗、不删锁。launcher 接线由主 Agent 另发合同。
