# Workbench 双端运行权接续验收脚本（叶子交接）

日期：2026-09-12。分支：`codex/spaces-pluginization`。角色 executor / Grok high。未 Git、未跑真实 DSH/Electron/Chromium。只改本叶子两个文件。

## 结论

已准备可复跑的 Desktop/Web 双端运行权接续真实验收脚本。优先 `DSH_TEST_PACKAGED_EXE` 实际分发 exe；未传则用当前 `out/main` 开发 Electron，并在 stdout/`results.json` 标明**非分发**。独立新 Home + userData，空 session、不配 key、不调模型。监督与桌面共用 Home 私有 `.dsh-spaces-control/toolchain.json` 的 runtime/snapshot/toolchain 根。cleanup 只停本脚本 spawn 的 supervisor 树和本脚本启动的 Electron；未知/生产进程不 kill。不 mock `window.dshSpaces`。

**本叶子未执行真实 DSH/浏览器/Electron。** `results.json` 要等主 Agent 串行跑完才有 pass/fail。

## 产物

- `D:\0 code\dsh-spaces\scripts\verify-workbench-dual-control.mjs`
- `D:\0 code\dsh-spaces\tasks\workbench-dual-control-worker.md`

未改产品源码、根 build/manifest、锁文件、已有真实验收脚本（含 `verify-spaces-desktop.mjs`、`verify-workbench-product.mjs`、`verify-spaces-distribution.mjs`、`verify-workbench-maintenance-product.mjs`）或其它任务文件。

## 用法

```
node scripts/verify-workbench-dual-control.mjs
node scripts/verify-workbench-dual-control.mjs --output D:\path\out --home D:\path\isolated-home
```

| 项 | 说明 |
| --- | --- |
| `--home` | 隔离 Home；默认在 output 下 `home-*` |
| `--output` | 默认 `.sandbox/workbench-dual-control` |
| `DSH_TEST_PACKAGED_EXE` | 优先实际分发/解包 exe（需有 sibling `resources/app.asar`，不是 NSIS Setup） |
| `DSH_TEST_BIN` | 真实 DSH `bin.js`，版本必须是 `0.1.5-rc.1` |
| `DSH_TEST_PLAYWRIGHT` 或 `DSH_TEST_PLAYWRIGHT_MODULE` | Playwright `index.mjs` 或包目录（需要 chromium + `_electron`） |
| `DSH_TEST_OUTPUT` / `DSH_TEST_HOME` / `DSH_TEST_PNPM_CJS` | 覆盖输出、Home、pnpm |

入口产物：`.sandbox/workbench-dual-control/results.json`。另有脱敏 `supervisor.log`、`seed.log`、`screenshots/`。失败保留 Home 与日志，不删旧录像/主题 Home。

Electron 环境**不**设 `DSH_SPACES_TOOLCHAIN`，避免测试对外部 toolchain 目录的初始化被当成产品无写证明。资源根在启动监督后、启动桌面前写入 Home 私有 `toolchain.json`，再对 Home 配置/数据做 hash。

## 覆盖（脚本已写，待主 Agent 实跑）

- CLI 精确 `0.1.5-rc.1`，不是则失败；不放宽门禁、不改版本
- 打包 supervisor 真实 manager + 普通 `coding`（无完整 Spaces 插件，有 view-bridge）
- Home `toolchain.json` 的 runtimeRoot/snapshotRoot/toolchainRoot 等于本测试预备目录，桌面与 Web 同根
- 关浏览器后监督、manager、普通空间、稳定入口仍可查询（等 2s 再读，不只看进程还在）
- 同 Home 打开 Electron：IPC `getControllerState` 只读 `ownerKind=web`；UI 只读文案截图
- 真实 IPC `startProfile` / `updateMeta` / `createProfile` / `saveSettings` 被拒；拒写前后 Home 配置/数据 hash 不变
- manager 不出现在桌面 `listProfiles` 与普通 rail
- Web `preview` + `plan.execute` `controller.release`；job 成功或 release 后 job API 失联时，用 state + lease（无 pid/nonce）共同证明已无 owner
- 桌面显式 `acquireController` 后可启动普通空间并更新显示名+图标，磁盘读回；Web 普通写与 `controller.acquire` 被拒
- 桌面显式 `releaseController` 停止自己的普通实例（含端口关闭）并放掉 lease
- Web 显式 `controller.acquire` 恢复控制，可 `space.update` 并读回；资源根仍指向同一 `toolchain.json`
- 全程同一 Home 只有一个 writable owner；状态 DTO 不含 pid/nonce/token/cookie/bearer
- stdout/日志脱敏；bootstrap 仅内部 Cookie 交换

## 未覆盖

- 真实 DSH / Chromium / Electron 生命周期（本叶子禁止跑）
- 生产 `~/.dsh`、模型调用、主题视觉、维护/快照/runtime 升级
- rc2 写路径/兼容（脚本遇非 rc1 直接失败）
- NSIS 安装器静默安装；未传 `DSH_TEST_PACKAGED_EXE` 时明确记为 unpackaged `out/main`，不算分发证明
- doctor CLI、损坏 journal 恢复、失败注入

## 主 Agent 需知情：运行时缺口怎么报

原 API 缺失时脚本失败并写 `gaps[]`，**不会** mock `window.dshSpaces`。请按错误原文修生产代码，不要改本脚本放宽断言。

已知需实跑才能证实的点：

- 桌面 `acquireController` 若只拿到 lease 但 `admitWrites` 因 instances/jobs 残留拒绝，会以 `desktop acquired the lease but writes were not admitted: …` 失败（生产准入缺口，不是 skip）
- `controller.release` 后 `job()` 可能 `workbench/read-only`；脚本把这当成失联并改用 state/lease，两者都不到才超时失败
- 监督 CLI 无 `--runtime-root`，`runtimeRoot` 回落到 `--control-tool-root`（与现网 product 脚本相同）

## 本叶子验证

- `node --check scripts/verify-workbench-dual-control.mjs`：语法
- 静态 import 该模块：不启动 supervisor/Electron（`import.meta.url` 入口守卫）
- 未跑真实 DSH、Playwright、Electron、pnpm install
