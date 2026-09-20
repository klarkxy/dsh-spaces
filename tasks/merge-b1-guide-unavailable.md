# Guide 公开合同：`unavailable` 替换 `recoveryRequired`

公开 guide/hint/bootstrap/initialize/returnTarget DTO 不再带 `recoveryRequired`。本地身份/角色阻断用 **`unavailable: boolean`**，与服务 `WorkbenchState.availability` 枚举分开。内部 `identity.recoveryRequired` 仍作只读证据，只在 runtime 公开边界映射。

未改 bootstrap helper、endpoint、Node Supervisor、`packages/plugin/src/workbench`。未 Git。

## 行为

- `WorkbenchHostHint` / `WorkbenchGuideRole` / bootstrap / returnTarget / initialize：`unavailable`
- 身份损坏：`unavailable: true`，reasons 为错误详情；不提供恢复入口或接管
- 普通失败（未绑定 CLI、无服务、held lock）：`ok: false` 且 **`unavailable: false`**
- Guide UI：错误卡（blocked / role lookup failed / init-failed / enter-failed）只有详情和「复制详情」，没有 Retry、没有失败后再 Initialize/Start。**Initialize Spaces** 只在健康未初始化；**Enter workbench** 只在已知 manager 的正常进入。失败与首次启动分开。
- Manager root 仅 `role === "manager" && !unavailable`
- State fixture `owner.kind` 为 **`web`**（与 shared / 已修 schema 一致），不再用无效的 `supervisor`

## 测试

```
npx tsx --test tests/workbench-plugin.test.ts tests/workbench-forwarding-v2.test.ts
```

**31 pass / 0 fail。** 身份损坏 → `unavailable: true` 且不清锁；未绑定 CLI 的普通初始化失败 → `unavailable: false`；hint `unavailable: false` 才挂 manager root。v2 state `owner.kind: web`。
