## 当前有效合同（2026-09-15）

故障政策：[docs/let-it-crash.md](../docs/let-it-crash.md)。活动账本：[todo.md](todo.md)。

隔离、鉴权、单写者、原子写、错误报告，以及用户主动的启动、停止、重启、安装、卸载和配置，仍有效。救援入口、检查并恢复、恢复中断任务、配置恢复、整 Home 恢复、Doctor `unlock`/`recover`/`rollback`、失败回滚、失败重试和中断续接 **已撤销**，不是延期，不勾成已完成。剩余运行时工作见账本 R1–R6（pending）。下文是当时实施与验收记录，不是现行恢复门槛。

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# 工作台控制器（A1 叶子交接）

日期：2026-09-12。分支：`codex/spaces-pluginization`。角色：`executor_controller`。

结论：**本叶完成（含审计两处复现缺陷修正）。** 独立管理身份与长期运行权模块已落地并经隔离 Home 测试。这不是桌面/Web 接入完成，也不是监督进程完成。

## 产物

- `D:\0 code\dsh-spaces\src\adapters\node\home-controller.ts`
- `D:\0 code\dsh-spaces\tests\home-controller.test.ts`
- `D:\0 code\dsh-spaces\tasks\workbench-controller-worker.md`

未改其他源、manifest、公共 DTO、desktop 适配器、`package.json` 测试清单。未启动 DSH、未占浏览器、未读生产 `~/.dsh`。

## 签名（整合用）

```ts
new HomeController(home: string, options?: { pidAlive?: PidAliveFn; allowRealHome?: boolean })

ensureManager(): Promise<ManagerIdentity>          // { profileId, needsBootstrap }
roleOf(profileId: string): "manager" | "workspace" | "uninitialized"
inspect(): HomeControlInspect                      // 运行权，不是事务锁
acquire(kind: "desktop" | "web", endpoint?: string): HomeControlHandle
  // handle.owner; handle.release(): void
reclaimDead(): ReclaimDeadResult                   // 仅明确死 owner
```

`ensureManager` 因 `HomeOperationLock.run` 而为 async。其余为同步。调用方不能传入身份覆盖 manager。

## 状态布局

`{canonicalHome}/.dsh-spaces-control/`（**不在** `MANAGED_HOME_ENTRIES`）

- `manager.json` — 管理身份，独立于运行 owner；原子写
- `run/owner.json` — 运行权：exclusive mkdir + pid/nonce/startedAt/kind[/endpoint]
- `reclaim/` — `reclaimDead` 互斥守卫，避免 inspect-then-delete

事务锁仍是 `{canonicalHome}/.dsh-spaces-lock`。获取运行权**不持有**该锁。`ensureManager` 元数据写入走原锁短事务（label `ensure-manager`）。

## 行为要点

- 首选登记 `spaces-hub`，冲突则 `spaces-hub-2`…。查实际 `profiles/*` 目录名 + 已有登记，不看 package.json / 显示名。
- 名称占用跨平台一律大小写不敏感：`Spaces-Hub` 占住 `spaces-hub`，改选 `spaces-hub-2`，不接管 case alias。
- 不安装 profile。未落地时 `needsBootstrap: true`，`roleOf` 仍为 `"manager"`。
- 可重入仅限：尚无 `manager.json`（ENOENT）完成首次预约，或已有**有效**预约且尚未 bootstrap。损坏/截断/不可读/非法 ID/未知 schema 的 `manager.json` 进入恢复，保留原字节，禁止重建。
- `roleOf` 在身份损坏时拒绝猜测，不把坏记录当成未初始化。
- 活 PID → busy；不完整 / symlink 别名 / PID 复用歧义 → recovery/busy，不自动抢占。
- `reclaimDead` 只回收二次确认的死 owner（ESRCH + reclaim mkdir + nonce/pid 再读）。
- `endpoint` 只接受干净 `http://127.0.0.1[:port][/]`，拒绝 localhost/路径/query/凭据。
- 目录 symlink 与 realpath 别名视为 ambiguous，拒绝逃逸。
- 只允许匹配 nonce 的 handle 释放；过期 handle 不能清掉新 owner。

## 验证

```
npx tsx --test tests/home-controller.test.ts
npx tsc --noEmit --strict --skipLibCheck --module ESNext --moduleResolution bundler --target ES2022 --isolatedModules --allowImportingTsExtensions --esModuleInterop --types node src/adapters/node/home-controller.ts
```

- 审计修正后测试：**24 pass / 0 fail / 0 skip**。覆盖：重复初始化、名字冲突、已有工作目录不覆盖、Windows case alias（`Spaces-Hub` → `spaces-hub-2`）及目录/`manager.json` 字节不变、包名不猜测身份、损坏 `manager.json`（`{broken`/截断/未知 schema/非法 ID）进入恢复且保留字节、`roleOf` 拒猜、ENOENT 与有效预约可重入、ensureManager 持事务锁而 acquire 不持有、并发 acquire（两实例 + 真实子进程 + 同进程争用）、nonce 释放、活/死/不完整/reclaim 中/PID 复用/过期 startedAt、symlink 别名、并发 `reclaimDead`、endpoint 校验、控制目录不在 snapshot managed entries。
- 测试 Home 均为 `os.tmpdir()` 下 `dsh-spaces-control-*`。子进程仅本地 `tsx`，无外部网络。
- 独立 `tsc` 仅检查 `home-controller.ts` 及其导入，退出码 0。未跑全项目 `-p tsconfig.node.json`（A2 `src/adapters/node/workbench-jobs.ts` 施工中）。
- **未**接入 `package.json` 的 `test` / `test:spaces` 脚本（无清单所有权）。
- **未**跑快照 restore 实机；仅断言目录名不在 `MANAGED_HOME_ENTRIES`。
- **未**做桌面/Web/监督进程/真实 DSH 启动。

## 主 Agent 后续整合

1. 监督进程与桌面从 `src/adapters/node/home-controller.ts` 构造 `HomeController`，不要把运行权塞进 `HomeOperationLock.run` 长事务。
2. bootstrap 叶根据 `needsBootstrap` 安装 `profileId`；本叶不创建 `profiles/<id>`。
3. `needsBootstrap: false` 只表示预约名下已有目录，**不等于**已验证安装完成。若目录是预约后出现的既有普通 profile（非本次引导所建），调用方必须核对其实际安装/身份后再继续，不能据此覆盖插件或配置。本叶不另加状态机。
4. 损坏 `manager.json` 只进恢复，不要再次 `ensureManager` 指望它重建身份；运行权死 owner 走 `reclaimDead()`，不要 inspect 后直接删目录。
5. 把 `tests/home-controller.test.ts` 纳入测试脚本。
6. 同一 canonical Home 桌面/Web 互斥写控制：一端 `acquire` 成功，另一端只读直到 `release`。

## 风险

- 默认 `pidAlive` 对**其他**活 PID 无法移植地取进程启动时间，只能 fail-closed 当 alive。同 PID + 过期 `startedAt` 会标 ambiguous。测试缝 `pidAlive` 可注入 `"ambiguous"`。
- `ensureManager` 在事务锁被其他实例持有时抛 `HomeLockBusyError`（不排队）。
- Windows junction 可能不被 `isSymbolicLink()` 标出；realpath 与字面路径不一致时仍按 ambiguous 拒绝。
- 名称占用跨平台一律大小写不敏感：Linux 上 `Spaces-Hub` 与 `spaces-hub` 本可并存，本模块仍会改选 `spaces-hub-2`，避免 Windows 接管。
