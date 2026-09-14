# Workbench rc.2 兼容性验证脚本（唯一审查重试交接）

日期：2026-09-12。分支：`codex/spaces-pluginization`。角色 executor。未 Git、未改产品门禁/源码/锁文件、未跑真实 DSH/浏览器/服务。只写本叶子两个文件。

状态：**脚本已按现场失败与新角色合同修正，证据未重跑。不宣称 rc.2 产品支持。**

## 结论

root 初跑 `.sandbox/workbench-rc2-root.log`：`--version`、官方 web、两个普通 profile 启动/桥注入/typed RPC 全过；在 `plugin-host spaces/overview` 失败。

该失败符合新架构，不是产品缺口：`SpacesPlugin` 只在 `HomeController.roleOf(当前 profile) === manager` 时注册 `spaces` 与 `workbench` 写 Remote。CLI 装了完整插件、但未登记管理身份的 `plugin-host` **本应 guide-only**。`gateway/service-unavailable` / `active Service "spaces" is unavailable` 是正确角色，不能再要求旧 spaces 服务存在。本轮按该合同改断言：要真实 `workbenchGuide/role`，禁止管理写入，禁止嵌套空间栏。这是角色正确性，不是放宽管理权。

HTTP `fetchDocument` + typed RPC **不是** Chromium/DOM 验收。脚本现用独立实验父页 + 真实 Chromium 加载两个普通 DSH iframe，校验 parent origin / channel / generation / 来源。该父页明确不是正式 workbench。

当前写门禁仍是 `0.1.5-rc.1`。低层通过仍标 `blocked` / `fullProductValidated=false`。

**本叶子未执行真实 DSH/Chromium/监督。** 原失败报告保留在 root 日志与原 `results.json`。新默认输出目录 `.sandbox/workbench-rc2-retry`，避免覆盖初跑失败产物。

## 产物

- `D:\0 code\dsh-spaces\scripts\verify-workbench-rc2.mjs`
- `D:\0 code\dsh-spaces\tasks\workbench-rc2-worker.md`

未改产品源码、`COMPATIBLE_DSH_CLI_VERSION`、doctor、锁文件、其它验收脚本。未导入 `verify-workbench-product.mjs`。

## 原失败（保留，勿删）

- `D:\0 code\dsh-spaces\.sandbox\workbench-rc2-root.log`
- `D:\0 code\dsh-spaces\.sandbox\workbench-rc2\results.json`（`status=fail`，`startedAt=2026-09-12T13:11:02.568Z`）

```
FAIL plugin-host spaces/overview RPC rejected: {"code":"gateway/service-unavailable","message":"typert gateway: spaces/overview: active Service \"spaces\" is unavailable",...}
```

已过项（初跑）：live `0.1.5-rc.2`、打包 tarball、官方 web 种子、产品门禁拒绝 manager、`coding`/`notes` 仅 lightbridge、双端口启动、文档桥 hint、普通 profile `session/list`。

## 用法

```
node scripts/verify-workbench-rc2.mjs
node scripts/verify-workbench-rc2.mjs --output D:\path\out --home D:\path\isolated-home
```

默认输出 `.sandbox/workbench-rc2-retry`（不覆盖初跑 `.sandbox/workbench-rc2`）。

| 项 | 说明 |
| --- | --- |
| `DSH_TEST_RC2_BIN` / `DSH_TEST_BIN` | 真实 rc.2 `bin.js` |
| `DSH_TEST_PLAYWRIGHT` / `DSH_TEST_PLAYWRIGHT_MODULE` | Playwright `index.mjs`；缺则失败，不 skip Chromium |
| cleanup | 只停本脚本 spawn 的 PID 与本脚本起的实验父页/浏览器 |

## 覆盖（待 root 实跑）

- live `--version` 精确 rc.2；产品监督拒绝仍 `productSupported=false`
- 普通 `coding`/`notes`：仅 view-bridge；HTTP typed RPC 标明不是浏览器验收
- **plugin-host guide-only（按现场+源码）**：`workbenchGuide/role` 成功且 `role` 为 `workspace` 或 `uninitialized`，绝不是 `manager`；`spaces/overview`、`spaces/create`、`workbench/submit`、`workbench/state` 必须不可用；不得创建 `must-not-exist`。若这些管理 RPC 成功，脚本 **FAIL**（那是越权，不是兼容）。
- **Chromium 实验父页**（文案：not the official DSH Spaces workbench）：两个普通 DSH iframe，真实 parent origin + 每空间独立 generation/channel；父页只接受 `source=dsh-spaces-view` 且 origin/spaceId/generation/channel 全匹配；同源伪造握手必须记入 rejected；两帧 `state=ready`。截图 + `browser-errors.json`。
- Chromium 打开 plugin-host：`.dsh-wb-rail` 为 0。
- 低层全过且门禁仍拒绝 → `status=blocked`，exit 2，`fullProductValidated=false`

## 退出码

| 码 | status | 含义 |
| --- | --- | --- |
| 0 | `pass` | 产品监督实际放行 rc.2 manager。不是改门禁。 |
| 2 | `blocked` | 低层+Chromium 实验通过，产品写仍 rc.1，完整产品未验收。 |
| 1 | `fail` | 版本不对、guide-only 合同破了、Chromium 握手失败、或脚本错误。 |

`blocked` ≠ 支持。

## 未覆盖 / 未验证

- 本叶子未跑真实 DSH / Chromium / 监督（root 正在其它实测）
- 正式 workbench 产品页、主题、维护/升级、桌面双端、生产 `~/.dsh`
- 未放宽 `COMPATIBLE_DSH_CLI_VERSION`

## 角色合同（源码）

`packages/plugin/src/host/plugin.ts`：始终注册 `WorkbenchGuideHost`；仅 `shouldRegisterManager`（`role===manager` 且已确认且非 recovery）才注册 `WorkbenchManagerHost` 与 `SpacesHost`。`tests/workbench-plugin.test.ts` 覆盖 ordinary 只有 guide。客户端 `packages/plugin/src/client/index.tsx`：非 manager 只提供返回工作台，不占 `root`、不画第二栏。

## 本叶子验证

- `node --check scripts/verify-workbench-rc2.mjs`
- 静态 import：不启动 DSH/监督/Chromium
- 未跑真实服务，未声称产品通过
