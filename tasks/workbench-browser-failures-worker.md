# Workbench 异常切换 / 滚动会话保持验收脚本（叶子交接）

日期：2026-09-12。分支：`codex/spaces-pluginization`。HEAD `5911e60`。角色：Grok 独立验收脚本施工叶子。未 Git、未 build 正式产物、未启动真实 DSH/Chromium/浏览器、未 mmx、未碰生产 Home。只改派工允许的三个路径。

## 1. 结论及完成状态

已交付可被 root 在其他真实服务结束后**串行实跑**的浏览器异常切换脚本。默认复用 `.sandbox/workbench-product-themes/results.json` 为 pass 时的隔离 Home（从 JSON 读 path，必须落在该目录内；不硬编码 `home-C4wR8E`，拒绝 `~/.dsh`）。监督进程只用当前 `packages/supervisor/lib` 正式产物和 Home 私有 `toolchain.json` 里已有的 archive/runtime/snapshot 根。输出独立 `.sandbox/workbench-browser-failures`。

**本叶子完成的是脚本与夹具，不是真实验收。** 未跑 DSH/Playwright。`--self-check` 是静态检查。

`status=pass` 仅当四个实跑相位都 proved 且 `uncovered=[]`。有诚实未覆盖时为 `partial`（exit 0，`coverageComplete=false`），不得当成全覆盖。失败保留 `results.json`、脱敏 `supervisor.log`、截图。

## 2. 产物（绝对路径）

- `D:\0 code\dsh-spaces\scripts\verify-workbench-browser-failures.mjs`
- `D:\0 code\dsh-spaces\tests\fixtures\workbench-failures\hang-plugin\package.json`
- `D:\0 code\dsh-spaces\tests\fixtures\workbench-failures\hang-plugin\index.js`
- `D:\0 code\dsh-spaces\tests\fixtures\workbench-failures\hang-plugin\client.js`
- `D:\0 code\dsh-spaces\tests\fixtures\workbench-failures\hang-plugin\cordis.patch.yml`
- `D:\0 code\dsh-spaces\tests\fixtures\workbench-failures\hang-cli.mjs`
- `D:\0 code\dsh-spaces\tasks\workbench-browser-failures-worker.md`

未改产品源码、已有脚本、`package.json`/`lock`、主题 Home、旧录像或主题失败原证。

## 3. 设计要点（给 root 实跑）

启动/选择器对齐 `verify-workbench-product.mjs` 与 `verify-workbench-interactions.mjs`：bootstrap、clean cookie URL、`managerFrame` / `.dsh-wb-rail`、`aria-current`、`[contenteditable="true"]`、官方 Continue/稍后配置。不 import 会自动执行的 product/interactions。`import.meta.url` 入口守卫。全程 `owncleanup` finally：`controller.shutdown` → 关浏览器 → 只杀本脚本核实过的 instance pid → `stopOwned(supervisor)`。

不能把 hang-cli 当作监督 `--bin`：`bindSelectedCli` 要求真实 `@deepseek-ai/dsh` 的 `package.json`。启动超时改为对专用空间安装 `tests/fixtures/workbench-failures/hang-plugin`（host `apply()` 挂起且登记 SIGTERM / `dsh-spaces:stop`；client 保留 `data-dsh-boot`）。产品门禁不缩短：UI start 90s、handshake 45s、process ready 60s。

| 相位 | 做法 | 失败/未覆盖 |
| --- | --- | --- |
| session | 在竹青建足够多空会话使官方侧栏溢出，点选靠后会话、量真实 overflow 容器 `scrollTop`、填 contenteditable；竹青↔EternalNight 后会话/滚动/草稿保持。不调模型、不发消息、不在无溢出时改 scrollTop | 溢不出或草稿丢失 → fail |
| cookie | 对子 origin 用真实缺失/垃圾 cookie 打 `/` 与 `session/list`；清 Playwright 中该 `dsh-auth-*` 名（各 port 独立，不清外层）。要 401/非 ok 的 DSH 证据，不用 `route.fulfill` | 产品自动补发有效会话 → `uncovered`，不假 PASS |
| crash | 只杀本监督 `instances/*.json` 且 parent=监督 pid、创建时间匹配的进程。未就绪不抢焦点；已选崩溃给错误态，竹青仍可选 | 未就绪已变成 running/selected → 该子项 uncovered，仍测已选崩溃 |
| timeout | 安装 hang-plugin 后点「启动超时夹具」，等真实产品超时。原选择保持 | 插件装不上或空间仍提交为当前 → uncovered |
| last-click | 不重复 interactions 完整 lifecycle | `skipped[]` |

## 4. root 运行命令 / 预计时间

其他真实 DSH/Electron/维护必须先停。不要并行抢同一主题 Home。

```
node scripts/verify-workbench-browser-failures.mjs --self-check
node scripts/verify-workbench-browser-failures.mjs
node scripts/verify-workbench-browser-failures.mjs --phase session
node scripts/verify-workbench-browser-failures.mjs --phase cookie
node scripts/verify-workbench-browser-failures.mjs --phase crash
node scripts/verify-workbench-browser-failures.mjs --phase timeout
```

可选：`--output DIR`、`--home DIR`（仍须在 `.sandbox/workbench-product-themes` 内）。Playwright：`DSH_TEST_PLAYWRIGHT` 或默认 Codex runtime 路径。

入口：`.sandbox/workbench-browser-failures/results.json`。另有脱敏 `supervisor.log`、`screenshots/`、`self-check.json`。失败保留 Home/日志。

预计：监督冷启动 1–3 min；session 2–4 min；cookie 1 min；crash 2–4 min；timeout 最长约 90s+缓冲。全程约 **8–15 min**。timeout 单独约 2 min。

## 5. 本叶子验证

```
node --check scripts/verify-workbench-browser-failures.mjs
node scripts/verify-workbench-browser-failures.mjs --self-check
```

应覆盖：语法；import 本模块不启动服务；不 import product/interactions；无 `route.fulfill`；产品超时常量与 `store.ts`/`process-manager.ts` 一致；hang-plugin 含停机登记；hang-cli `--self-check`；拒绝生产 Home；主题 results 的 home 在隔离目录内。不启动监督/DSH/Chromium。

## 6. 未验证假设 / 风险

- 官方侧栏 overflow 祖先是否稳定可测，取决于 DSH DOM；溢不出则 session 相位 fail，不改 scroll 造假。
- 真实 DSH 在缺 cookie 时可能 303 补发新会话，cookie 相位会 uncovered。
- hang-plugin 若未能挡住 `dsh web:` / handshake，timeout 相位 uncovered。
- 崩溃只杀本监督登记进程；复用 Home 若已 `recovery-required` 或有他人残留，脚本失败且不猜 PID。
- 本脚本会在复用主题 Home 上创建 `crash-probe`、`hang-timeout` 及 overflow workspace/sessions，并可能向 `hub/plugins` 拷贝 hang tgz。不删竹青/EternalNight/XP，不碰旧主题失败截图。
- Windows 才做 parent/CreationDate 核对；非 Windows 会 fail crash 相位。
- 最后点击获胜未在本脚本重跑。

## 7. 需要整合的接口 / 下一步

无产品接口变更。root 在真实 runtime 升级与其他服务结束后串行执行上一节命令，以 `results.json` 的 `status`/`proved`/`uncovered`/`coverageComplete` 为验收入口。不要把本叶子 `--self-check` 写成用户目标已完成。
