## 当前有效合同（2026-09-15）

故障政策：[docs/let-it-crash.md](../docs/let-it-crash.md)。活动账本：[todo.md](todo.md)。

隔离、鉴权、单写者、原子写、错误报告，以及用户主动的启动、停止、重启、安装、卸载和配置，仍有效。救援入口、检查并恢复、恢复中断任务、配置恢复、整 Home 恢复、Doctor `unlock`/`recover`/`rollback`、失败回滚、失败重试和中断续接 **已撤销**，不是延期，不勾成已完成。剩余运行时工作见账本 R1–R6（pending）。下文是当时实施与验收记录，不是现行恢复门槛。

> 历史记录：以下内容描述当时实施与验收情况。涉及修复、恢复、回滚或救援的产品要求，已由 2026-09-15 的 [`docs/let-it-crash.md`](../docs/let-it-crash.md) 取代，不再作为当前施工与发布门槛。历史事实和原始证据不因此改写。
# Workbench supervisor（叶子交接）

日期：2026-09-12。分支：`codex/spaces-pluginization`。正式独立监督服务，不是 A0 HTTP 脚手架。

## 结论

`createWorkbenchSupervisor(options)` 拉起监听 `127.0.0.1` 的稳定入口、HomeController web 运行权、profile/view/lifecycle，以及合同 `WorkbenchApi`。C 维护层通过 `createMaintenance(ports)` 注入；未注入时 plugin/snapshot/runtime/config 返回 `workbench/maintenance`，没有本地占位实现。

未改 `src/shared/workbench.ts`、root `package.json`/`tsconfig`、A1/A2 源码、旧 plugin 入口、ProcessManager 本体。

## 产物

- `D:\0 code\dsh-spaces\src\adapters\node\workbench-supervisor.ts`
- `D:\0 code\dsh-spaces\src\adapters\node\workbench-http.ts`
- `D:\0 code\dsh-spaces\packages\supervisor\src\index.ts`
- `D:\0 code\dsh-spaces\packages\supervisor\package.json`
- `D:\0 code\dsh-spaces\packages\supervisor\README.md`
- `D:\0 code\dsh-spaces\tests\workbench-supervisor.test.ts`
- `D:\0 code\dsh-spaces\tasks\workbench-supervisor-worker.md`

## 启动 / attach

```ts
const handle = await createWorkbenchSupervisor({
  home, bin, nodeExe, port,
  controlToolRoot, supervisorAssetRoot,
  pluginArtifact, viewBridgeArtifact,
  snapshotWorkerFile, snapshotRoot,
});
handle.origin        // http://127.0.0.1:<port>
handle.bootstrapUrl  // Node-only 一次性引导，禁止进 DTO
handle.runtime       // WorkbenchApi + HTTP host
handle.server
await handle.close()
```

CLI：`packages/supervisor/src/index.ts` 支持 `--home --bin|--cli --node --port --control-tool-root --supervisor-asset-root --plugin-artifact --view-bridge-artifact --snapshot-worker --snapshot-root`。`--bin` 为规范名，`--cli` 为插件 bootstrap 兼容别名。`supervisorCliArgs` 仍输出 `--bin`。stdout 只打印 `origin=` 与 `bootstrap=`。

私密 `{home}/.dsh-spaces-control/endpoint.json` `{version:1,origin,bearer}` 与 `host.bearer` 一致，release 时只删本 endpoint。`POST /internal/bootstrap`（host bearer）签发一次性 `/bootstrap/<token>`，不把 bearer/DSH token 给浏览器。

默认 `createMaintenance` 组合真实 `WorkbenchMaintenance`；`snapshotWorkerFile` 默认 `packages/supervisor/lib/snapshot-worker.mjs`（由根构建，本叶未改 root manifests）。

## 行为摘要

- 先 listen，空闲则 `acquire("web", origin)` 再写 jobStore、装并**启动** manager；busy 只读入口，不装 manager、不建 jobStore。create 失败不 throw、不泄漏 HTTP/lease。
- stop 失败保留 lease/实例/HTTP，拒绝新维护；不吞 force-kill。close 先封 submit、drain 队列、再 stop、再放权。
- 默认组合 `WorkbenchMaintenance`；lifecycle plan 落盘 `lifecycle-plans/`，维护 plan 由 C 目录跨刷新 execute。
- recover(ctx) 只结算能证明的 snapshot/runtime 中断任务；mutation.json 不单独阻断 recover。
- `setSelectedDshResolver` / `setManagedCliPrefix` / `setToolchainRoot`；`currentRuntime` 走 `describeRuntime(readRuntimeRef)`；`reinitializeManager` 刷新 selected 并只重启 manager。
- CoordinatedUpgrade.profiles 含 web；stop 列表仍按 owned。
- 实例记录 `{control}/instances/`；冷启 dead 回收记录，alive/ambiguous 不 kill/adopt。
- 默认 snapshot 目录为 Home **兄弟** `{home}-snapshots`，不嵌套进 Home。
- `controller.acquire` 是 HTTP 侧唯一接管空闲权的写；轮询不抢占。
- `ensureManager` 预约名后检查真实安装：无 `@dsh-spaces/plugin` 的既有目录当 ordinary，不覆盖。
- 管理 profile：官方 base/web + Spaces 插件产物 + 视图桥。普通 create：base/web + 视图桥。
- CLI 绑定读 bin 旁 package.json，只放行 `0.1.5-rc.1`。NodeSpacesControl loader 来自真实 `--dump-config`，不造假 version。
- 停机：覆盖 `runtime.kill`，`kind=kill` 报错并保留实例，Web 不自动 force。
- 视图：启动/重启递增 generation。DTO：`origin` 为子进程干净 origin，`entryOrigin` 为监督稳定 origin，`entryPath=/view/<id>/<gen>` 仅 owned ready。子 DSH token 只在 Node 内兑换。env：`DSH_SPACES_VIEW_PARENT_ORIGIN|ID|GENERATION|CHANNEL`。管理进程 parent=稳定 origin，工作进程 parent=当前 manager origin。
- Cookie：`dsh-auth-<sha256(127.0.0.1:port)>` HttpOnly SameSite=Strict，303 `/`。Host bearer：`.dsh-spaces-control/host.bearer`。
- release/shutdown 不在 job handler 里 `await whenIdle`；终态落盘后再放权。shutdown 再关 HTTP。

## 验证

`npx tsx --test tests/workbench-supervisor.test.ts` — 15 pass（含根反例两条：init 后 manager=running；close 失败仍持有 run 权）。未改 ROOT 断言。未跑真实 DSH / 浏览器。

未启动真实 DSH / 浏览器 / Playwright。ProcessManager 用测试 HTTP fixture。

## 未覆盖 / 需要整合

- C `WorkbenchMaintenance` 未到，生产路径需注入或待 `workbench-maintenance.ts`。
- 根 build/manifests、Electron 接入、view-bridge 包与 host proxy 由后续叶使用本 CLI/API。
- 未跑真实 0.1.5-rc.1 DSH 双空间嵌入（A0 已证，主 Agent 串行验收）。
- B-UI `authorizedViewSrc` 把 `origin+entryPath` 拼到 child origin；监督页自身用同源 `/view/...`。工作空间 iframe 接线等 view-bridge。
