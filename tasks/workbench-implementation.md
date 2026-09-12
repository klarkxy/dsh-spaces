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
- B-UI Grok：packages/plugin/src/workbench/**、tests/workbench-ui.test.tsx、tasks/workbench-ui-worker.md。基于固定合同独立制作工作台组件；不改入口，不启动浏览器；真实接线仍等待A闸门通过。
- A/B监督服务 Grok：src/adapters/node/workbench-{runtime,http,supervisor,views}.ts、packages/supervisor/src/**、tests/workbench-{runtime,http}.test.ts、tasks/workbench-supervisor-worker.md。只做正式运行服务和组合，不改旧模块/公共DTO/构建；真实DSH验收由主Agent串行运行。
- C维护 Grok：src/adapters/node/workbench-maintenance.ts、tests/workbench-maintenance.test.ts、tasks/workbench-maintenance-worker.md。消费固定Node ports复用旧事务，不自建监督进程。
- 插件角色/桥 Grok：packages/plugin/src/host/**、client/index.tsx与workbench-remote.ts、入口/typert/types、packages/view-bridge/src/**、tests/workbench-plugin.test.ts与spaces-host.test.ts、tasks/workbench-plugin-worker.md。不得改工作台UI、Node适配器或构建清单。
- doctor Grok：packages/doctor/src/**、packages/doctor/README.md、tests/spaces-doctor.test.ts与workbench-doctor.test.ts、tasks/workbench-doctor-worker.md。独立离线诊断/恢复，仍复用原事务。
- Codex：本记录、接口合同、根依赖与构建配置、Git、独立验收。后续叶子派发前补充所有权。

## 当前记录

- 实现前基线：180项桌面测试、89项插件测试、桌面TypeScript通过；日志 .sandbox/workbench-baseline-{desktop,spaces,types}.log。
- A0 task_5099138387 / sess_85bce9de05；A1 task_d74dc0f97e / sess_bf242b2bdb；A2 task_56b8a94682 / sess_eb1c507a1c。均请求Grok/high，实际模型待回执。
- 公共类型在 src/shared/workbench.ts，通信/拓扑见 tasks/workbench-contract.md。写接口根作者Codex。
- B-UI与基础后端独立制作，task与session见后续派工回执；不得把未接入组件当运行完成。
- B-UI task_ae8befe357 / sess_c800355aa4；监督 task_d01250167f / sess_51f4611809；维护 task_e7c4540010 / sess_143b1c3e59。
- A1审计修正通过主Agent24项测试与2个独立反例复验，commit 99ae600；session已关闭。A2审计修正task_27891e3718 / sess_eb1c507a1c进行中。
- A0 run.log已有双真实DSH iframe/草稿保持/Origin隔离/不暴露token/独立入口存活的实验PASS；实验管理服务是Node脚手架，不冒充正式管理profile验收，正式接线仍需重验。
- A0已交回并关闭session；Codex读回JSON及截图。A2一次修正完成，Codex追加损坏记录结算门禁并独立21 tests通过，session关闭。
- B-UI审计重试task_bdcec2fb00 / sess_c800355aa4；插件角色/桥task_518594be2a / sess_97b2c25108。均Grok/high。公共View新增entryOrigin，详合同。
- C维护审计重试task_fd98b15284 / sess_143b1c3e59已完成并关闭，Codex复验23项及原反例通过；监督审计重试task_aa911561e8 / sess_51f4611809进行中。
- 桌面审计重试task_c7435e298e / sess_ca0229c591；插件审计重试task_17d04eb914 / sess_97b2c25108进行中。后续这些session不再延长，进一步问题由Codex修正整合。
- B-UI session已关闭；Codex独立30项交互/DOM验证通过并补充测试fixture。正式验收脚本scripts/verify-workbench-product.mjs已准备，尚未执行。首轮build:spaces已成功，仍需所有最终源码稳定后重建验收。
- doctor task_f86e0dd9a6 / sess_64633c38fa。离线资源私有toolchain.json需根统一补runtimeRoot/snapshotRoot/toolchainRoot，供Desktop/Web/doctor同Home接续，不允许猜旧appuserdata。
- 根整合待重点核查：普通Desktop空间列表不得显示manager形成双层空间栏；监督启动/释放/故障保持入口；真实升级候选进程的跨崩溃身份记录（旧CoordinatedUpgrade只在内存track子进程）；Home资源指针跨端一致；独立CLI生产Home许可须明确产品授权传递且测试仍隔离。

## 证据入口

2026-09-12 根整合进展：正式 A 产品基础已通过，见 .sandbox/workbench-product/results.json 和 workbench-two-spaces.png / manager-stopped-rescue.png。实际打包监督程序创建专用 DSH 管理 profile，两个未安装完整 Spaces 的工作 profile 经左栏点击启动、授权 iframe 就绪；停止真实 manager 后稳定入口仍可查询。不是 A0 脚手架。根修正了双 shebang、页面脚本语法、Windows 含空格归档参数、协作停机、半完成管理安装续接、停止失败保留视图。

最新独立整合单测72项通过（.sandbox/workbench-integrated-root.log），此前三个TS配置均通过；之后的资源根同步与参数校验仍需最后复验。主题分发正在 scripts/verify-workbench-product.mjs --themes 下实际跑，竹青已安装和显示，未将未完成的全部主题矩阵记通过。

doctor 唯一审计重试 task_5bd2351c95 已交回并关闭session；根待复验26项。维护真实分发脚本叶子 task_c821afd32e / sess_f49f582cbb 已交回初稿 scripts/verify-workbench-maintenance-product.mjs，尚未真实运行；实际进程/浏览器与主题测试串行。

总目标仍未完成：维护完整读回及故障注入、rc2实际兼容、跨端资源接续/桌面分发回归、Catppuccin失败案例隔离、最终视频与最终产物回归均待完成。不要把当前基础通过当作完整交付。

旧主题与分发：tasks/pluginization-themes-acceptance.md、tasks/pluginization-trial-acceptance.md。
真实 SDK：C:/Users/admin/AppData/Local/Temp/spaces-runtime-install-fIEaas/versions/0.1.5-rc.1/node_modules/@deepseek-ai。
Node：D:/Program Files/nodejs/node.exe。Playwright 包：C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright。
最新 Spaces tgz：.sandbox/pluginization-delivery/dsh-spaces-plugin-0.2.0.tgz。
旧截图和视频 Home 仅供只读参考；本轮建立独立 workbench 验收 Home。
