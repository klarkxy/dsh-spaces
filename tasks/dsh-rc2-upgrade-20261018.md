# 2026-10-18 DSH 0.2.1-rc.2 升级记录

## 范围与结果

DSH Spaces 的开发 SDK、新安装默认 CLI、CI 和验收目标已对齐官方 `0.2.1-rc.2`。Spaces 自身版本仍为 `0.4.0`，原最低支持版本 `0.2.0-rc.2` 保留；已有空间的精确版本绑定不自动改变。

本轮保留开始前已有的未提交修复，没有提交、推送、发布或替换用户已安装的 Desktop。未访问真实 `~/.dsh`。实际验收使用未修改的官方 rc.2 CLI、全新隔离 Home 和 Chromium，没有真实模型调用。

## 实现

- 根目录与 Blueprint 开发依赖、锁文件对齐 rc.2；配套 Cordis `4.0.5`、loader `1.0.6`、Schemastery `3.18.5`。移除没有代码引用、上游不再发布新版本的 `dsh-invariants` 开发依赖。
- 分发组件的 DSH peer 声明保留原下限，并显式加入新预发布版本，避免 npm 默认 prerelease 语义拒绝安装。
- 启动准入使用实际绑定宿主的兼容性判断，兼容旧 `peers` 和新 `requirements` 返回结构；省略版本时从绑定的 app-boot 读取实际版本。
- 官方标签源码确认 `engines.dsh` 优先规则始于 `0.2.1-alpha.4`。运行时切换按目标版本应用规则，逐包保留约束；预览与执行前均重新检查，不兼容或损坏声明在停止、安装、改写 pin 前拒绝。
- `LLM_ADAPTER_VERSION` 统一模型能力生产者、快照、公开类型与宿主响应校验；新增实际 `GlobalLlmHost` 经认证 HTTP 和生产响应校验的回归。
- 蓝图生产逻辑不变；官方集成测试改为使用目标 SDK 的实际内置包身份。CI、安装说明和开发启动入口同步更新。
- 标准安装脚本通过官方账号引导窗的明确“关闭”按钮完成无密钥初始化。没有强制点击、修改官方宿主、恢复旧 Home 或重放失败作业。

## 最终验证

Node `26.10.0`；每项结果来自相应最终日志，不将先前失败覆盖为成功。

| 检查 | 最终结果 |
| --- | --- |
| 测试清单、typecheck、typecheck:spaces、typecheck:tests | 通过 |
| 完整构建 | 通过，使用仓库 `.sandbox/tmp` |
| npm test | 259 通过 |
| test:spaces | 149 通过 |
| test:workbench | 510 通过，2 项平台权限跳过 |
| test:workbench:recovery | 31 通过 |
| test:llm | 99 通过 |
| test:blueprints，含独立 Blueprint 包与目标 SDK 集成 | 326 通过，4 项平台权限跳过 |
| test:browser | 11 通过 |
| test:dashboard，含 domain core 与真实 SDK | 200 通过，1 项平台权限跳过 |
| 八组规定测试合计 | 1,585 通过，7 跳过，最终无失败 |
| 额外 test:workbench:browser | 11/11 |
| 实际旧版 app-boot 兼容回归 | 44/44 |
| 原始进程管理测试单独复验 | 25/25 |
| 独立 Astra 源码审查与后续定向复核 | READY，无未关闭发现 |

工作台组按相同文件清单串行运行。默认组最终使用原始 `npm test` 命令。蓝图官方集成绑定本轮 rc.2 SDK，未把旧版本条件导致的跳过计为新版本通过。

## 最终包与官方宿主

包：`../.sandbox/dsh-rc2-upgrade-20261018/artifacts/dsh-spaces-plugin-0.4.0.tgz`

SHA-256：`eef69b686adfa37da92c3250e5511c837b479c9720a356cca3c041a36d1d51dd`

`verify-plugin-standard-install.mjs` 在全新官方 rc.2 Home 中通过：

1. 官方 CLI 安装插件，初始化前无管理空间。
2. 通过真实 UI 初始化；工作台嵌入原页面，只创建一个 `spaces-hub`。
3. 创建登记的 `space-coding`，通过生产隔离检查，进入空间并完成 view-bridge 握手。
4. 重启该空间，其他空间状态保持不变；重复进入不增加第二个管理空间。
5. 关闭并重新启动普通 Web，重新进入同一管理空间。
6. 停止服务后用持久化 succeeded 作业、死进程、失效端点和关闭端口确认完成。此处 HTTP 连接先断开，不计为 HTTP 成功，也未再次提交。
7. 官方 CLI 卸载入口，包依赖、bundle 和 dump 行均移除。

最终报告 `status=pass`、`modelCalls=false`、`forceCleaned=false`、`leftoverPorts=[]`，页面和 RPC 错误均为 0。初始化前后受保护的原 Web 路径检查通过。

证据副本：`../.sandbox/dsh-rc2-upgrade-20261018/acceptance-evidence/`，包含 `results.json`、`initialized.png` 和 `coding.png`。

## 保留的失败与证据边界

- 首轮宿主验收被 rc.2 新账号引导窗遮挡，停在初始化点击前。截图和失败 Home 保留；修正验收步骤后另建全新 Home，没有恢复或续跑旧现场。
- 测试过程中出现过 Windows 临时文件 rename EPERM、Blueprint 夹具保存失败，以及两个并行子进程启动用例的偶发失败。原始失败日志保留。换用合适的临时目录并分组诊断后，最终规定测试通过；两项启动用例的偶发根因未判定，未修改进程管理实现或添加重试来消除失败。
- 系统临时目录曾拒绝 esbuild 子进程写入，最终构建按仓库规定使用 `.sandbox/tmp`。源码检查、测试与构建证据和官方宿主验收分开记录。
- 本次是官方 Web 的本地包验收，不代表用户安装版 Desktop 已替换或其原生嵌入交互已验收；不关闭既有持续 UI `read.deadline` 调查，不宣称长期运行或生产 Home 迁移通过。

全部日志与检查结果：`../.sandbox/dsh-rc2-upgrade-20261018/`。关键日志为 `default-last.log`、`gate-test-spaces.log`、`gate-test-workbench.log`、`gate-test-llm.log`、`blueprints-all-target.log`、`gate-test-dashboard.log`、`compat-old-host.log`、`standard-install-onboarding.log` 和 `gates.ndjson`。
