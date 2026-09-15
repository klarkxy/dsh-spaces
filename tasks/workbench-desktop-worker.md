## 当前有效合同（2026-09-15）

故障政策：[docs/let-it-crash.md](../docs/let-it-crash.md)。活动账本：[todo.md](todo.md)。

隔离、鉴权、单写者、原子写、错误报告，以及用户主动的启动、停止、重启、安装、卸载和配置，仍有效。救援入口、检查并恢复、恢复中断任务、配置恢复、整 Home 恢复、Doctor `unlock`/`recover`/`rollback`、失败回滚、失败重试和中断续接 **已撤销**，不是延期，不勾成已完成。剩余运行时工作见账本 R1–R6（pending）。下文是当时实施与验收记录，不是现行恢复门槛。

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# 桌面独占运行权（desktop-controller 审计重试交接）

日期：2026-09-12。分支：`codex/spaces-pluginization`。角色：`executor` / `workbench-desktop-controller`。

结论：**审计重试完成。** ROOT 两条反例现为 PASS。仍不是正式 Electron/DSH 双端验收。

## 产物

- `D:\0 code\dsh-spaces\src\shared\desktop-controller.ts`
- `D:\0 code\dsh-spaces\src\adapters\desktop\controller.ts`
- `D:\0 code\dsh-spaces\src\adapters\desktop\control-residue.ts`
- `D:\0 code\dsh-spaces\src\adapters\desktop\graceful-kill.ts`
- `D:\0 code\dsh-spaces\src\adapters\desktop\index.ts`
- `D:\0 code\dsh-spaces\src\main\index.ts`
- `D:\0 code\dsh-spaces\src\preload\index.ts`
- `D:\0 code\dsh-spaces\src\renderer\src\App.tsx`
- `D:\0 code\dsh-spaces\src\renderer\src\components\ControllerStatus.tsx`
- `D:\0 code\dsh-spaces\tests\desktop-controller.test.ts`
- `D:\0 code\dsh-spaces\tasks\workbench-desktop-worker.md`

未改其他作者文件、翻译索引、manifests、ViewManager/ProcessManager 源码、监督/维护模块。未 Git/push。未启动 Electron/DSH。

## 审计对应

1. `writable`/`assertWritable`/`mutate`/`runMaintenance` 每次重读 manager 身份与控制目录残留。损坏 `manager.json` 不 `ensureManager`（不会另起新名字）。已缓存 `managerProfileId` 失效即阻断。
2. 放行前只读扫描 `jobs`（queued/running/recovery-required、截断、未知 schema fail-closed）、`instances`（任意遗留即阻断、不杀 PID）、`.dsh-spaces-upgrade/journal.json`、`.dsh-spaces-mutation.json`。不实例化 JobStore 执行器，不改 jobs。
3. `acquire` IPC：`acquireExplicit` 只拿 lease 并封写，然后 `admitWrites`（身份/残留/toolchain 判定 + 刷新 settings/source/portRange/current bin）成功才 `admitted`。`control/toolchain.json` 用 `readRuntimeRef` 核对真实 bin 版本；核对失败拒绝写，不回落到旧 userData bin、不覆盖该记录。
4. 管理 profile 的任意插件安装/开关/移除走服务端拒绝。`setSpacePlugin`/`removePlugin` 以 library `packageName` 为准；无元数据的 tarball / `npm:`/`node:`/`file:` 别名 fail-closed。
5. 只读且未 onboarded 显示只读概览，不弹写引导。移交先 `previewControllerRelease` 列出将停空间，renderer 确认后才 release。held+recovery 文案为「保留控制权等待恢复」，不是「未取得运行权」。72px 栏与 32px 标题栏几何未改。
6. 恢复态仍可 quit/release 停本桌面实例。移交 `stopOwned` 将 `allowForceKill=false`，ProcessManager 默认的 term-then-F 在移交路径会失败并保留 lease。未引入自动 F。

## 验证

```
npx tsx --test tests/desktop-controller.test.ts
npx tsc --noEmit --strict --skipLibCheck --module ESNext --moduleResolution bundler --target ES2022 --isolatedModules --allowImportingTsExtensions --esModuleInterop --types node src/shared/desktop-controller.ts src/adapters/desktop/controller.ts src/adapters/desktop/control-residue.ts src/adapters/desktop/graceful-kill.ts src/adapters/desktop/home-control.ts src/adapters/desktop/index.ts src/preload/index.ts src/main/index.ts
npx tsc --noEmit -p tsconfig.web.json
```

- 测试：**14 pass / 0 fail**，含未改断言的两条 ROOT 反例（`mutate`/`runMaintenance` 真实拒绝，jobs 字节不变）。
- web tsc 通过。本叶 node 文件独立 tsc 通过。
- 未跑真实 Electron/DSH。

## 根作者

- 跨端运行时目录合同未统一：有经过 `readRuntimeRef` 验证的 `{home}/.dsh-spaces-control/toolchain.json` 时只把它当 current bin；缺失时仍用桌面 userData runtimes。**未宣称跨端升级验证通过。**
- 强制结束仍需主 Agent 后续明确授权；本叶移交只 graceful。
- 正式双端 Electron 验收仍待根作者串行运行。
