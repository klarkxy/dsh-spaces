# 工作台 UI 叶子交接（B-UI，审计重试）

状态：针对根作者 6 条反例的最小修正已落地。仍未接入 plugin client / host / 真实 DSH。2026-09-12。

## 结论

已修：iframe 树常驻、请求目标与已提交选择分离、创建不自动切换、entryOrigin≠child origin、ref 及时绑定 contentWindow、openIndependent 重新 view()。不是产品完成。

## 产物

- `D:\0 code\dsh-spaces\packages\plugin\src\workbench\**`（仅此模块）
- `D:\0 code\dsh-spaces\tests\workbench-ui.test.tsx`（27）
- `D:\0 code\dsh-spaces\tests\workbench-ui-dom.test.ts`（Playwright 最小 DOM）
- `D:\0 code\dsh-spaces\.sandbox\workbench-ui-audit\`（host.tsx / child.html / report.md）
- 本文件

## 反例对应

1. `WorkbenchView` 始终挂 `WorkspaceFrames`；首页/boot 错误只盖层，不卸 iframe。key=`spaceId:generation`，仅 generation 变销毁。DOM 测试：同一节点 + textarea 草稿。
2. `pendingId` vs `selected`（committed）。最后点击更新 pending；ready 才 commit+persist。失败/超时保留原 committed。首页立即提交。点停止空间会 `space.start` 并等待 ready。只读不 start。
3. `space.create` 成功只设 `createdNotice`（已创建 / 进入空间），即时与 poll 到的 succeeded job 一样，不改 selected。
4. `authorizedViewSrc` 用 `entryOrigin+entryPath`；`origin` 仅 postMessage。两 origin 必须是干净 `http(s)://127.0.0.1[:port]`，互不相同；entryPath 禁 `//`、`\`、query。
5. iframe `ref` 立即登记 `contentWindow`，`onLoad` 再绑一次（重定向后）。校验未放宽。
6. 去首页/设置/轮询失败不拆 frame。`openIndependent` 再调 `api.view`，不用已消费 src。

## 验证

- `npx tsx --test tests/workbench-ui.test.tsx` → 27 pass
- `npx tsx --test tests/workbench-ui-dom.test.ts` → 1 pass（chromium headless，动态端口，无 DSH）
- workbench 源文件 `tsc --strict` 通过

未做：真实 DSH 集成、client 接线、拖拽排序。

## 接入

```ts
createElement(WorkbenchApp, { api })
createElement(RecoverySurface, { api })
```

`WorkbenchView.entryOrigin` 已在 `src/shared/workbench.ts`。监督进程签发的 view 必须带互异的 supervisor/child origin。
