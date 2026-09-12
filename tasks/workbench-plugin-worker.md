# 工作台插件角色/桥 叶子交接（workbench-plugin-roles-bridge）

状态：审计重试接线已落地。2026-09-12。未 Git、未发版、未启动真实 DSH/浏览器。未改 UI 包、Node 监督/维护、shared、manifest/lockfile/build。

## 结论

角色分流仍按 `HomeController.roleOf(确认后的当前 profile)`。本轮把启动、附着、返回入口和视图桥接到可运行行为，不再把缺口写成「待根接线」。

## 实际接线

**1. 冷启动 CLI + 本地 tarball**

复制 `lib/supervisor/{index.js,snapshot-worker.mjs,manifest.json}` 到 Home 外 `{dirname(home)}/.dsh-spaces-tools/{version}-{digest}/`。再用当前已安装插件包与 `lib/view-bridge` 做 `npm pack --ignore-scripts --json --pack-destination <toolsRoot>/artifacts`（不写回 plugin 目录，拒绝已含 tgz 的源）。argv（非 shell）：

```
--home --bin --node --plugin-artifact --view-bridge-artifact --control-tool-root --snapshot-worker [--snapshot-root]
```

npm 先找当前 Node 相邻 `node_modules/npm/bin/npm-cli.js`，否则 `setToolchainRoot(toolsRoot)` 后 `npmCliJs`/`ensureNode`（toolchain 固定在 Home 外）。pack/启动超时 240s。`snapshotRoot` 从 Host config 传入，若落在 profiles/hub/sessions/storages 等被恢复替换目录则拒绝。

**2. 先认证附着，再决定是否冷启动**

读 `endpoint.json` 后必须 private bearer `POST /api/workbench/state`，且 `HomeController.inspect()`：同 origin 且 alive、非 ambiguous。managerApi 每次先 ping，不重复 pack。stale/foreign/dead/ambiguous **不清锁、不杀 PID、不覆盖 endpoint**。仅 manager/uninitialized 允许冷启动；workspace 误装只附着已有工作台。并发复用按 Home 的 inflight Promise + `toolsRoot/coldstart.lock` mkdir。

**3. returnTarget**

`POST /internal/bootstrap`（bearer）→ `{url}` 校验为同 origin `/bootstrap/<token>`。浏览器导航该一次性路径；GET 换 HttpOnly cookie 后 303 `/`。DTO 不含 host bearer/DSH token。另有 DSH 认证路由 `GET /dsh-spaces/handoff` → 303 同一引导 URL。无 endpoint 时先 bootstrap；manager 停机仍可从原安装 profile 回稳定入口。

**4. view-bridge**

不占用 `root`。ready 条件：`[data-dsh-boot]` 从父容器移除 **且** 有真实 child DOM，**且** `connection.state` 为 `connected`。订阅 state，disconnected 后再 connected 可再次 ready。不调用 `connection.start()`。roster/超时保持 failed。无 env 无副作用。`tapIndex` disposer 走 `ctx.effect`。

**5. Parent ping（桥侧已实现，根可选接线）**

父页向 iframe `contentWindow` 发：

```
{ source: "dsh-spaces-view-parent", type: "ping", spaceId, generation, channel }
```

必须同 origin + 同 window。桥重发最后一次 ready/failed/disconnected。父侧已保留 disconnected iframe，不必改 UI 包。

**6. allowRealHome**

插件 Host `allowRealHome=true`。监督 CLI **没有** `--allow-real-home`。生产 guard 需根作者从插件传播到监督进程。本叶子测试一律隔离 tmp Home，不读生产 `~/.dsh`。

**7. Schema**

catalogId 允许 `@scope/name`，拒绝 file/git/shell。icon 上限 `MAX_SPACE_ICON_DATA_URL_CHARS`。兼容 `spaces/overview|detail` 只代理监督只读 API，`canCreate/canVerify=false`，**不再 new NodeSpacesControl**。

## 验证

```
npx tsx --test tests/workbench-plugin.test.ts
```

**15 pass**（含 CLI flags、ping 附着、foreign stale 不覆盖、ordinary 不第二控制器、handoff cookie 303、boot 手交接 + connection 循环、@scope catalogId、snapshotRoot 拒绝）。另跑 `tests/spaces-host.test.ts` + `tests/spaces-panel.test.tsx` 全过。

未做：完整 DSH/浏览器验收、真实 npm pack 全量插件（单测 stub pack；根做打包实测）。

## 根作者剩余

- 生产把 allowRealHome/guard 传入监督（CLI 现无 flag）。
- 可选：iframe `load`/ref 绑定后发 parent ping。
- 监督进程自身健康与打包安装到专用 profile / 普通 space。
