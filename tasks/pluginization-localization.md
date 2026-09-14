# 插件前端本地化（zh / en）

范围：`packages/plugin/src/client/**`、`tests/spaces-panel.test.tsx`、本文件。未改共享 DTO、后端、包元数据或验收脚本。

## Locale 选取（实际 SDK，未虚构 ctx 服务）

查过 SDK `0.1.5-rc.2`：

- 侧栏真实调用 `ctx.locale.register(NS, { zh, en })` 与 `ctx.locale.subscribe`（`dsh-client-ui-sidebar/lib/client.js`，inject 含 `"locale"`）。
- 槽位可声明 `locale:`，由 `LocaleFace.bind(ns)` 注入 `t`；缺 locale face 时装配抛错。
- 本仓库 `node_modules/@deepseek-ai` **没有** locale 插件包，本插件 `inject` 仍是 `["slots", "connection"]`，`package.json` `dsh.client.inject` 也不含 locale（包元数据由主 Agent 独占）。

因此 **不** 注入/调用 `ctx.locale`，不给槽位加 `locale:`。

实际选取：

1. 面板内可见切换：页头 **中文 | English**（`aria-pressed`，`aria-label` 为「语言」/「Language」）。
2. 首次进入：`navigator.languages[0]` → `navigator.language` → `Intl.DateTimeFormat().resolvedOptions().locale`；`zh*` 为中文，否则英文。
3. 侧栏标签是 thunk，按浏览器语言读一次；页内切换不会通知宿主侧栏（没有 locale subscribe）。

入口：`packages/plugin/src/client/i18n.ts`（`inferSpacesLocale`、`MESSAGES`、`ACCEPTANCE_LABELS`、`localizeSafeText`）。根节点 `data-locale` / `lang`。

## 覆盖

翻译：按钮、状态、表单、空态、aria 标签、能力模式与原因、诊断说明、验证结果、Host 拒绝、安全/通用错误。

不翻译：空间 `displayName` / `id`、插件名、快照 id、版本号、诊断 **code**、时间戳。

后端英文：稳定 error code（`spaces/host-denied` 等）或 `PUBLIC_ERROR` / `DIAGNOSTIC` / 验证结果的有限英文表。未知文本一律换成通用错误，不把路径/token 显示出来。

未改：Host 拒绝、`canCreate`/`canVerify` 必须 `=== true`、overview/detail/verify 代际丢弃旧响应。

## 验收脚本可用标签

从 `ACCEPTANCE_LABELS` 读取，或按下表：

| key | en | zh |
| --- | --- | --- |
| panelTitle | Spaces | 空间 |
| refresh | Refresh | 刷新 |
| language | Language | 语言 |
| loading | Loading spaces… | 正在加载空间… |
| empty | No spaces yet. Create one above to get started. | 还没有空间。请先在上方创建一个。 |
| host | Host | 宿主 |
| running | Running | 运行中 |
| create | Create | 创建 |
| createDenied | Creation is not available in the current mode. | 当前模式不可创建。 |
| verify | Verify isolation | 验证隔离 |
| hostLocked | The host space cannot be verified or modified from here. | 宿主空间不能在此验证或修改。 |
| verifyDenied | Verification is not available in the current mode. | 当前模式不可验证。 |
| lastCheckPassed | Last isolation check passed | 最近一次隔离检查通过 |
| lastCheckFailed | Last isolation check failed | 最近一次隔离检查失败 |
| genericError | The Spaces service request failed. Try again later. | Spaces 服务请求失败，请稍后重试。 |
| hostDenied | The current host space cannot be modified this way. | 当前宿主空间不能这样修改。 |
| modeFull | Verified — creation and verification available | 已验证 — 可创建和验证 |
| modeReadonly | Unknown runtime — read-only | 未知运行时 — 只读 |

切换按钮字面量固定为 `中文` / `English`。根节点：`data-locale="zh"|"en"`，`lang="zh-CN"|"en"`。
