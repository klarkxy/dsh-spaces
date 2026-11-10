# 2026-11-07 Creator 空间创建施工与验收

> 本记录只描述实现边界与已完成的检查结果，不替代完整验收。故障政策仍只有 [let-it-crash.md](../../docs/let-it-crash.md) 一个权威。

## 实现边界

- **主空间 Creator 四工具**：`spaces_context` / `spaces_create_preview` / `spaces_create_execute` / `spaces_job`，仅在经身份确认的 web/desktop 主宿主注册；执行时校验 Creator（`cordis` preset），相关指引也仅在该模式注入。
- **独立 scope**：`issue`/`unregister` 走 Host bearer + loopback `/identity` nonce 挑战；业务操作只认签发的 Creator scope，scope 不进会话、端点记录或日志。同一服务纪元单注册，冲突拒绝；issue 失败在同一端点上是终态，不重试。
- **完整冻结计划**：`createPreview` 把输入（名称/图标/精确 base 版本/modelSource/plugins/startAfterCreate）冻结成绑定服务纪元、状态版本和 TTL 的一次性计划；`createExecute` 按 requestId 幂等，同 requestId 重放返回原作业，不重复执行。
- **单个组合作业**：prepare（含精确版本运行时安装）→ create → view-bridge → llm-policy（`main` 模型源）→ 逐项插件安装 + 读回校验 → 可选 start → result。首个失败即停：已完成步骤真实记录，未完成保持 `not-run`；不重试、不回滚、不续跑、不替换来源。
- **插件来源与安装脚本**：只接受 npm 精确版本或 GitHub 完整 40 位 commit（可带安全子目录）；`approvedBuilds` 只收精确包名/dep key，禁通配，安装前写入 profile `pnpm-workspace.yaml` 的 `allowBuilds`，失败时报告精确 pending key。插件读回校验包名与 npm 解析版本或 GitHub commit/subdir 匹配。
- **不依赖 LLM**：Creator channel 与主空间 LLM 服务相互独立，没有 LLM 时工具仍可用。
- **`@klarkxy/dsh-dev-index` 预装**：作为 canonical `dsh-dev-index` 行随宿主插件和 view bridge 组合 patch 进入主空间与所有 Web 子空间；Browser base 的 profile patch 显式 `disabled: true` 同一行。显式 `plugin add` 与预装行同 id，只会按最后生效一行注册一次。
- **SDK 基线 0.2.2-rc.1**：Cordis 4.1.0 / loader 1.1.0 / schemastery 3.19；宿主要求 Node ≥24.9，本项目 engines 为 Node 24.21+ 的 24.x 或 26.x。官方升级指南仅覆盖到 v0.2.2-alpha.3；rc.1 差异按 `dsh-v0.2.2-rc.1` tag 源码核对（`internal/config` 参数换序、模型选择 API、`purpose` 声明合并、fs-observation-policy 默认禁用 + `apply_patch`）。

## 已完成的检查

| 项 | 结果 | 证据/说明 |
| --- | --- | --- |
| `typecheck`（node+web）、`typecheck:spaces`、`typecheck:tests` | 通过（exit 0） | rc.1 适配后由施工叶复核 |
| `test:llm` | **40/40 pass** | 普通进程 `npm run test:llm`；rc.1 回归修复后归零：`ctx.inject` 回调异步致守卫监听晚注册、`internal/config` ABI 变化、`ModelSelectionRef` 退役。其中 `internal/config` 在 Cordis 4.1 以 `this:null` + 首参 `Fiber` 派发（旧 ABI 为 `this:Fiber` + 首参 config），两处 hook 已改为 `this ?? 首参` 双 ABI 兼容；真实子空间启动 null-`this` 崩溃（`plugin.ts:37`）已修，bundle 探针实测 `thisIsNull: true, firstIsFiber: true` |
| Creator 初轮针对性检查 | 31 项：27 pass / 4 fail | 当轮 4 个失败来自测试 mock/helpers；这些问题已修复，第二轮全套检查中的新增功能用例均通过 |
| `check:all` 第一轮（`.sandbox/checks-E1mbxQ/result.json`） | 11/14 组 pass；`test:workbench` 786 总=780 pass 4 fail 2 skip（3 个 Git 新增 + 既有 `--dsw-radius-sm`）；`test:workbench:browser` 19 pass 6 fail（与 11-04 已记同类选择器问题）；`test:llm` 当轮 36 pass 3 fail → 已修复后全过 | 失败批次保留为当轮事实，不写成基线 |
| `check:all` 第二轮（`.sandbox/checks-qZJ0OG`） | **12/14 组 pass**；`test:workbench` 790 总=787 pass 1 fail 2 skip（唯一 fail 为既有 `--dsw-radius-sm`）；`test:llm` 40/40；`test:workbench:browser` 仍 19 pass 6 fail（旧选择器问题）；其他 type/build/base 244/spaces 114/recovery 28/blueprint 216+4 skip/browser 18/package 全 pass | 第二轮结果，新增 dead-inject activation 回归也在 llm 组通过 |
| Git 子目录（github spec + path 读回） | 已通过 | 第二轮 `test:workbench` 用真实 0.2.2-rc.1 CLI 经受控 Git 传输验证：根包与子目录 commit pin-over-HEAD 读回通过，`approvedBuilds`/`allowBuilds` 哨兵通过；这是受控传输验收，不是公开 GitHub 项目的完整发布验收 |
| 完整 runtime 独立 CLI schema 校验 | 98 条、0 diagnostics | 独立 CLI 依赖完整性检查通过；后续 SDK 启动、创建与停机结果见下方通过的验收轮次 |
| Release tarball | `.sandbox/creator-release-rc1/dsh-spaces-plugin-0.5.0.tgz`（sha256 `e92f811d492bc7507b8c28e1e372ec0319e0d74e91944bf8b065e4669de2efb6`） | 由主线程产出；其 SDK composition run 见历程第 5 次 |
| `approveEscalation` 审批面 | 部分验证 | 真实 SDK 的 `approveEscalation`（动态 import 自 `@deepseek-ai/dsh-sandbox`）allow/reject 单元测试已过；没有真实 Agent Session UI 端到端审批证据，wire 层 `createExecute` 已在 harness 覆盖 |
| 官方 Desktop EXE 入口与后台集成冒烟 | **通过** | [完整结果](../.sandbox/creator-native-acceptance/2026-11-07T18-18-10-326Z/results.json)：应用/SDK 0.2.2-rc.1、Node 24.21.0、Electron 44.7.0；独立 Home/userData，主空间四工具已注册，受权 wire 驱动 main-inherit 空间创建并启动，正常退出后进程清零、端点/租约释放、EXE/asar 摘要未变。不是 Agent Session 审批 UI 端到端测试；截图在启动加载阶段拍摄，不作为工作台已渲染的证据 |

## SDK 隔离诊断历程

| 轮次 | 结果 | 说明 |
| --- | --- | --- |
| 第 1 次（`.sandbox/creator-sdk-dd7...`） | create/start 失败；清理 durable `9fe...` succeeded，endpoint/owner 退休 | 脚本 running 误报已修；根因为 `internal/config` 在 Cordis 4.1 下 `this:null` 访问 `entry` |
| 第 2 次（`.sandbox/creator-sdk-e8a7a7b3256c463e9e011cbefcf2b0bd`） | 子空间存活但 `session.list` 报 `gateway/service-unavailable`，API 3102 约 49s 未 ready；正常 shutdown 成功 | 根因为 `cordis.patch.yml` 两处 `spacesLlmSnapshot` 退役 inject 阻断 `agent-default-model` → session-controller 就绪链；移除后修复 |
| 第 3 次（`.sandbox/creator-sdk-b957...`） | local creator job `4dffdff6...` durable=succeeded、全部 steps done、shutdown `21d5...` succeeded | 脚本证据侧 `toolsError`（observer 未声明 tools injection）是采集超时而非产品 fail，随后已修复；该轮 main-inherit 第二 job 未执行 |
| 第 4 次（`.sandbox/creator-sdk-7bfb045bb3d347c2a991a213bb9aae27`） | **pass**（SDK composition harness，非打包 Desktop） | 官方 CLI 0.2.2-rc.1 + 隔离 desktop profile + dev link：`boot()` 挂载真实组合、Supervisor v2 启动；job1 `space-creator-ok`（local）全部 steps done + dev-index 安装见证；job2 `space-creator-main`（main-inherit）全部 steps done、`llm-policy` 持久化 `inheritMain:true`、子空间 tools 见证；observer 证实 `spaces_*` 四工具在 desktop；`service.shutdown` durable；`issue`/`createPreview`/`createExecute`/`job` 的 bearer/epoch/plan/输入边界全部拒绝路径通过。未覆盖：真实 Agent Session 的审批 UI（wire 层 createExecute 已覆盖）与打包 Desktop EXE |
| 中间一次 release run（`22faf...`） | 脚本失败（endpoint≠ready 误判） | 脚本以启动端点等待代替 `startupStatus` + 新 state 观察，是夹具误判不是产品失败；已修脚本并后验 endpoint/owner 退休，产品代码未改 |
| 第 5 次（`.sandbox/creator-sdk-release-203398ed0d1149e4835acd5ab738649e`） | **pass**（SDK composition harness，非打包 Desktop） | 真实发行 tarball（sha256 见上表）装入隔离 desktop profile：`boot()` 挂载真实组合、Supervisor v2 启动、manager `spaces-hub` running；job1 `space-creator-ok`（local）全部 steps done；job2 `space-creator-main`（main-inherit）全部 steps done、`llm-policy` 持久化 `inheritMain:true`；子空间 5 工具且无跨空间工具；observer 证实 `spaces_*` 四工具在 desktop；manager 身份与 scope 拒绝路径通过；`service.shutdown` durable，owner pid dead、endpoint 失效、端口关闭。未覆盖：真实 Agent Session 的审批 UI与打包 Desktop EXE |

## 未验证与交接

- `check:all` 第二轮仍有 2 组未过：`test:workbench` 唯一 `--dsw-radius-sm` 既有 fail、`test:workbench:browser` 6 个旧选择器 fail；均非本轮回归。第二轮 `test:workbench` 中新增的 Git 根包/子目录受控传输与 `allowBuilds` 哨兵用例全部通过。
- local 与 main-inherit 两条创建路径在 SDK composition harness 均已通过：dev link（`creator-sdk-7bfb045bb3d347c2a991a213bb9aae27`）与真实发行 tarball（`creator-sdk-release-203398ed0d1149e4835acd5ab738649e`）。
- 以上各轮当时仅覆盖 SDK 审批单测与 wire 操作。后续 2026-11-08 [独立 Web + Magpie SWE2 实测](creator-swe2-web-20261108.md) 已覆盖真实模型搜索/preview、真实 Agent Session UI 拒绝和允许一次、作业提交与只读结果转述；普通 Web 页面已实际运行。
- 后续 SWE2 作业在插件安装阶段真实失败（工具链 china 镜像缺少 model-route@0.2.7），并未启动子空间；这不改写此前通过轮次，也不能将本轮标成完整创建成功。上游 served-model 关联、该失败空间的运行时工具隔离与进入后交互仍未覆盖。
- `check:all` 产品代码自第二轮起未变，未声明第三轮；保留两组既有 UI 测试失败，本记录不声明全仓测试全绿。
