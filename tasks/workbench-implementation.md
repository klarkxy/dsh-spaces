# 工作台化实施记录

状态：施工中。2026-09-12；分支 codex/spaces-pluginization；起点 5585060。用户批准完整 A—D 计划，Grok 施工，Codex 接口编排、整合、独立验收。不得把批次完成当成总目标完成。

## 固定需求

- 专用 spaces-hub 管理 profile，名称冲突时递增后缀，不覆盖旧 profile。原 profile 原地接入，保留数据和默认启动入口。
- 72px 外层空间栏，独立 iframe 工作空间，保留草稿/滚动/会话，最后一次切换胜出，视图就绪后才切换，失败保留原空间。
- 普通空间不运行完整 Spaces 管理服务；误装只提供返回工作台。允许无管理权的独立轻量视图桥。
- 本机 Windows/Chromium；仅绑定 127.0.0.1。同一 canonical Home 只有一个写控制者，桌面/Web另一端只读。原有事务锁继续使用，不被长期运行权取代。
- 独立监督进程和稳定入口，关闭浏览器标签不停止实例。管理环境升级/恢复期间仍有维护页面；执行器和控制状态不位于被恢复替换的目录。
- 包含空间元数据/生命周期、插件搜索安装卸载启用、整 Home 快照创建预览恢复删除、配置备份恢复、运行时安装升级和失败回滚；包含管理工作台自身维护。
- 长任务持久化、刷新续看、幂等请求、可取消阶段明确；维护后不自动重启全部工作空间。损坏或身份不明只进入恢复模式，不猜测清锁，不接管外部实例。
- 浏览器 DTO 不含磁盘路径、命令、原始启动 token、Cookie、配置秘密；服务器解析业务标识。视图握手校验 source/origin/generation。
- 保留 doctor/独立恢复 CLI、旧快照格式与整 Home 语义；原生桌面行为回归。
- 基线 CLI 0.1.5-rc.1 / SDK 0.1.5-rc.2；真实 CLI 0.1.5-rc.2 仅在完整兼容验证后可允许写，不能假造版本或绕过门禁。
- 所有运行验收用新隔离 Home/空会话，不读取生产配置、不调用模型。完成后更新分发产物与空间栏介绍视频。窄范围本地提交，不推送/发版/改版本号。

## 批次与闸门

A：监督、身份/运行权、稳定入口、专用管理环境、轻量桥。先用真实 DSH 证明两工作空间无完整 Spaces 仍可嵌入、认证隔离和管理环境停止时救援入口可用。基础闸门失败则暂停依赖它的扩建，报告证据。

B：空间栏和完整使用闭环、元数据/生命周期、误装限制、双端运行权。

C：复用现有插件/快照/升级模块接入监督进程，完成自维护及中断恢复。

D：分发、回归、实际浏览器/桌面验收和新视频。

## 初始叶子所有权

- A0 Grok：scripts/verify-workbench-foundation.mjs、tasks/workbench-foundation-worker.md、.sandbox/workbench-foundation/**。真实架构试验；不得改产品源码或既有主题/录像 Home。
- A1 Grok：src/adapters/node/home-controller.ts、tests/home-controller.test.ts、tasks/workbench-controller-worker.md。独立管理身份、长期运行权模块与测试；不得改桌面/插件入口及公共 DTO。
- A2 Grok：src/adapters/node/workbench-jobs.ts、tests/workbench-jobs.test.ts、tasks/workbench-jobs-worker.md。持久化任务、幂等与取消；不启动DSH/HTTP。
- Codex：本记录、接口合同、根依赖与构建配置、Git、独立验收。后续叶子派发前补充所有权。

## 当前记录

- 实现前基线：180项桌面测试、89项插件测试、桌面TypeScript通过；日志 .sandbox/workbench-baseline-{desktop,spaces,types}.log。
- A0 task_5099138387 / sess_85bce9de05；A1 task_d74dc0f97e / sess_bf242b2bdb；A2 task_56b8a94682 / sess_eb1c507a1c。均请求Grok/high，实际模型待回执。
- 公共类型在 src/shared/workbench.ts，通信/拓扑见 tasks/workbench-contract.md。写接口根作者Codex。

## 证据入口

旧主题与分发：tasks/pluginization-themes-acceptance.md、tasks/pluginization-trial-acceptance.md。
真实 SDK：C:/Users/admin/AppData/Local/Temp/spaces-runtime-install-fIEaas/versions/0.1.5-rc.1/node_modules/@deepseek-ai。
Node：D:/Program Files/nodejs/node.exe。Playwright 包：C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright。
最新 Spaces tgz：.sandbox/pluginization-delivery/dsh-spaces-plugin-0.2.0.tgz。
旧截图和视频 Home 仅供只读参考；本轮建立独立 workbench 验收 Home。
