# 基础闸门 A0 交接（executor_foundation）

日期：2026-09-12。分支 `codex/spaces-pluginization`。叶子未改产品源码、未改既有主题/分发脚本、未碰生产 `~/.dsh`、未调模型。

## 结论

**基础闸门通过（exit 0）。** 两份普通 profile 不装 `@dsh-spaces/plugin`，官方 CLI 分别安装竹青与 EternalNight；真实 DSH Web 跑在独立端口；实验入口用左右 72px 外层导航 iframe 嵌入官方 DSH。启动 token 只在服务端换成 `dsh-auth-*` HttpOnly Cookie，浏览器 DTO / iframe `src` / storage / 请求 URL / frame URL 均无原始 `token=`。停管理进程后入口仍显示救援视图，工作空间进程仍在。入口/管理 HTTP **是实验脚手架，不是产品实现**；工作空间界面是官方 DSH，未 mock。

可实现：上游文档无 `X-Frame-Options`、无 `frame-ancestors`；Cookie 名=`dsh-auth-`+base64url(sha256(authority))，HttpOnly、SameSite=Strict、Path=/、无 Secure；错 Origin 的 `/api` 返回 403 `forbidden`。不必关上游 auth，也不必做任意 URL 代理。产品侧建议继续服务端换票 + 子 origin 干净跳转；Electron 可用 `cookies.set`，不必照搬本实验的 HTML 引导页。

## 产物

- `D:\0 code\dsh-spaces\scripts\verify-workbench-foundation.mjs`
- `D:\0 code\dsh-spaces\tasks\workbench-foundation-worker.md`
- Home：`D:\0 code\dsh-spaces\.sandbox\workbench-foundation\home`
- 结果：`D:\0 code\dsh-spaces\.sandbox\workbench-foundation\results.json`
- 上游探测：`D:\0 code\dsh-spaces\.sandbox\workbench-foundation\auth-probe.json`
- 截图：
  - `...\zhuqing-draft.png`（浅绿竹青，草稿 `workbench-draft-zhuqing`，未发送）
  - `...\eternalnight-draft.png`（官方壁纸层，草稿 `workbench-draft-eternalnight`，未发送）
  - `...\shell-two-spaces.png`（左右栏 + 未卸载的 iframe）
  - `...\rescue-after-manager-stop.png`（管理停掉后救援条，EternalNight 仍在）
- 日志：`run.log`、`entry.log`、`manager.log`、`{zhuqing,eternalnight}-{dsh,dump,plugin-add}.*`（token 已 redact）

复跑：

```
node scripts/verify-workbench-foundation.mjs
```

`DSH_TEST_WB_REUSE=1` 保留该 Home。CLI / Playwright / pnpm 与主题验收相同。默认重建 `.sandbox/workbench-foundation/home`。

## 实际接口（实验，端口每次 ephemeral，跑完已关）

本次成功跑：入口 `http://127.0.0.1:55957`，管理 `:55956`，竹青 DSH `:55900`，EternalNight DSH `:55929`。

| 面 | 行为 |
| --- | --- |
| `GET /` | 实验外壳；Set-Cookie `wb-entry` HttpOnly SameSite=Strict；左右 72px 栏 |
| `GET /api/spaces` | 浏览器 DTO：`{id,displayName,status}`，无 token/port/path/cookie |
| `GET /embed/:id/bootstrap` | 需入口 cookie；管理进程服务端打 DSH `/?token=`；把上游 Set-Cookie 拷到 127.0.0.1；HTML 跳到干净 `http://127.0.0.1:<dshPort>/`（竹青带 `#theme=zhuqing-light`） |
| 管理 `GET /health`、`GET /internal/state`、`POST /internal/embed/:id/bootstrap` | 仅 `x-wb-internal` + loopback Origin，不面向浏览器 |

iframe 元素 `src` 保持 `/embed/<id>/bootstrap`；Playwright `frame.url()` 为 DSH 子 origin，search 无 token。

## 验证（已跑，不是计划）

1. 官方 CLI `0.1.5-rc.1`：`dsh-theme-plugin@0.3.3 --ignore-scripts`、`@eternalnight/dsh-theme@0.5.1`。dump 有 `theme-zhongguo` / `dsh-theme`，无 Spaces 插件行。session/storage 经 `applyIsolationPatch`。HOME/USERPROFILE=隔离 Home。
2. 空目录 `workspace/create` + `session/create`（只传 `workspaceId`）。Playwright 点掉内测声明与「稍后配置」，**未发送 prompt**。
3. 两 iframe 独立 origin；切换不卸载，草稿仍在；竹青 `--dsw-alias-bg-base rgb(239,248,241)`，EternalNight `.dt-bg` + `/dsh-theme/assets/import-images/default.png`；入口 origin 未被染色。
4. 根 origin 读 DSH `/api/session/list` → `TypeError: Failed to fetch`。子 origin 读 `/api/spaces` → 同样失败。服务端错 Origin → 403。
5. 杀管理进程后入口 200 + `#rescue.visible`；两工作空间端口仍开。finally `taskkill` 后 `:55900/:55929/:55956/:55957` 均 `waitPortClosed`。
6. 浏览器可见面无原始启动 token。`document.cookie` 看不到 `dsh-auth-*`（HttpOnly）。

## 实验脚手架 vs 产品

脚手架：入口/管理 Node HTTP、引导 HTML、`wb-entry` 会话、把 DSH Set-Cookie 设到 127.0.0.1 再跳子 origin。\
产品不该：关 DSH auth、把 launch token 放进 DTO/iframe URL、任意 URL 反向代理、把控制面放进被恢复替换的目录。\
产品可沿用：服务端换票、authority 绑定的 Cookie 名、Origin 校验、iframe 不卸载、管理挂了入口仍救援。

## 未验证 / 风险

- 未测 Electron WebContentsView、Firefox/Safari、非 127.0.0.1。
- 127.0.0.1 上 host-only Cookie 跨端口会进 jar；靠 Cookie **名和 payload 绑定 authority** 防串用，本次成立。
- 根/子互访在浏览器里是 CORS/`Failed to fetch`，未读到 403 响应体；服务端探测已证明错 Origin=403。
- 竹青跳转 URL 带 `#theme=zhuqing-light`（官方主题 hash，不是启动 token）。
- `failure.png` 是修 overlay 前的失败帧，可忽略。
- 未验证模型回复、消息隔离、桌面端、Spaces 插件误装。

## 给整合 / A1 的接口含义

浏览器 DTO 只暴露空间 id/显示名/状态。嵌入 URL 由入口用 id 构造 `/embed/:id/bootstrap`，**不要**把 DSH launch URL 或 token 交给渲染层。子实例 origin 是 `http://127.0.0.1:<port>/`。管理 API 必须 Origin+Cookie；子 origin 不得读。监督进程与稳定入口分离：杀管理环境不能带走入口和工作空间进程。
