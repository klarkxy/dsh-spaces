# B 共享工作台 UI（Grok 施工叶）

2026-09-20。本叶只扩展 `packages/plugin/src/workbench/**` 与对应 UI/DOM 测试。不写 Git、不改 Host/remote/shared DTO/backend/renderer。

## 写入

| 路径 | 作用 |
|---|---|
| `packages/plugin/src/workbench/store.ts` | v2 `submit/preview` context、一次意图 `requestId`、脏草稿 observation、product 读写 |
| `packages/plugin/src/workbench/view-session.ts` | 消息/视图同时校验 epoch+spaceId+generation+channel+origin+source |
| `packages/plugin/src/workbench/components.tsx` / `product-ui.tsx` | 设置、目录/下载库、模板与分享、诊断；去掉 acquire/release |
| `packages/plugin/src/workbench/i18n.ts` / `persistence.ts` / `styles.ts` / `recovery.tsx` | 文案、客户端 locale/theme、无恢复入口 |
| `packages/plugin/src/workbench/llm/client.ts` / `space-binding.tsx` | `LlmSpaceObservation.serviceEpoch` |
| `tests/workbench-ui.test.tsx` / `tests/workbench-ui-dom.test.ts` / fixtures | v2+product 确定性端口 fixtures |
| `tests/llm-ui.test.tsx` / `tests/fixtures/llm-ui/host.tsx` | 现有 LLM fixtures 迁到 v2 |

## 行为

- `WorkbenchApp` 仍是浏览器与远程 manager page 的唯一 UI。业务只走传入的 `WorkbenchApi`。
- 刷新只 `state()`，不重放 submit。同一 pending 意图复用 `requestId`，重复点击忽略。
- 打开中的脏 Home 设置草稿不被 poll 覆盖；保存用草稿 observation。冲突只报错，不自动换成新 revision。
- locale/theme 只进客户端 persist（`selectedId`/`locale`/`theme`）。保存 Home 设置（端口/包来源/目录 URL）不重置它们。
- 目录本地 query、显式 `catalog.refresh`；下载走 job，已下载≠已安装；版本 `null` 显示未知。安装/移除仍走 server preview。
- 导出：`product share.export` → Blob 下载，不进 persist。导入：内存 base64 → preview → 确认只 submit `importId+name`；epoch 变化/TTL 过期不重发。
- 诊断只展示有界脱敏 log/`lastError`/备份；无恢复入口。`stop()` 只断开 client。停止整个服务是设置里的 `service.shutdown` preview。

## 续修（epoch query / 一次终态 / stop 作废）

- `authorizedViewSrc`：entryPath 仍只允许 path；src 只追加 `?epoch=` + `encodeURIComponent` 校验过的 64hex `view.serviceEpoch`。entryPath 自带 query（含 `?epoch=`）拒绝。缺/非 hex/大写 hex 拒绝。
- `onProductJob`：历史终态 job 首次 poll 只登记不触发读；每个 job id 副作用一次。settings 成功仅在草稿仍等于提交快照时落盘；保存后或等待中的新编辑保留。
- `stop()`：`cycle`/`stateGeneration` +1；state/detail/product/view 在 await 后若 cycle 变了不 patch。无重试。

```text
npx tsx --test tests/workbench-ui.test.tsx tests/llm-ui.test.tsx
50 pass / 0 fail

npx tsx --test tests/workbench-ui-dom.test.ts tests/llm-ui-dom.test.ts
3 pass / 0 fail
```

本轮新增/收紧：

- `authorized view src is origin+entryPath and rejects remote or token-like paths`
- `applyView rejects missing or non-hex serviceEpoch before minting src`
- `old-service view frames are rejected without serviceEpoch`
- `settings.update success then later dirty edit is not overwritten by polling the same terminal job`
- `edits made while settings.update is pending are kept when the old save succeeds`
- `stop() drops in-flight state and product responses`
- DOM `home navigation keeps the same iframe node and textarea draft`（fixture 缺/错 epoch → 403；合法 src 必须以 `?epoch=` 结束）

覆盖：脏草稿 context、缺/错 epoch 的 view src 与旧 frame 丢弃、导入 preview→确认仅一次、失败部分结果、设置不覆客户端偏好、`service.shutdown` 而非 acquire、settings 终态不覆盖后续脏编辑、stop 丢弃在途响应、LLM DOM 仍通过。

`npx tsc --noEmit -p tsconfig.spaces.json` 仍有 Host/maintenance 等后续叶错误；本叶 `packages/plugin/src/workbench/**` 未出现在报错里。

## DOM 限制（如实）

`tests/workbench-ui-dom.test.ts` 是 Playwright + 进程内可控 `WorkbenchApi` fixture，不是官方 CLI 或 Electron 真双端。主 Agent 仍需用官方 CLI + Electron 验收。Playwright 解析改为 `DSH_TEST_PLAYWRIGHT` 或仓库 `node_modules/playwright`（原硬编码 Codex cache 路径在本机不存在）。

## 接口缺口（主 Agent）

1. Host / HTTP / remote 仍是旧 `submit/preview` 签名，且无 `product()`。本叶只适配浏览器真实调用形状；连上会编译失败，直到 Host 叶接入。
2. Supervisor 尚未把 `product(request)` 转到 `WorkbenchProductService.read`，写命令尚未进现有 job 后 `execute`。
3. JobStore `publicResult`/`parseStrictResult` 仍可能丢掉 `job.result.product`；失败 job 仍可能清掉部分结果。UI 已能显示该字段，但后台不返回则看不到。
4. `workbench-maintenance` 预览计划仍缺 `serviceEpoch` / `stateRevision`。
5. `src/renderer` 的 `SpaceSharePanel` 未动。桌面壳切到本共享 UI 是后续叶。
6. 已安装列表仍读现有 `api.plugins()`；目录/下载库走 `product`。若 Host 去掉 `plugins()`，需主 Agent 定合同。
7. 未改 `src/shared/workbench-product.ts`。未发明第二套 WorkbenchApi。
