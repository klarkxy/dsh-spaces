# 工作台接口与所有权合同

Codex owns src/shared/workbench.ts。本文件固定新接口，保留旧 SpacesControlApi 供兼容适配；不是授权浏览器提交路径、命令或原始 spec。

现行故障政策：[docs/let-it-crash.md](../docs/let-it-crash.md)。**目标政策 / 已知实现差距：** 源码在 R1–R6 完成前仍含 `recoveryRequired`、`recovery.resume`、`snapshot.restore`、`config.restore` 等。那些不是当前合同要求。实现迁移见 [todo.md](todo.md) R1–R6。

## 通信

- 浏览器 API 以 WorkbenchApi 为准。监督 HTTP transport 固定 /api/workbench/<method>，POST JSON，查询也 POST。方法白名单和逐方法输入校验，credentials include；精确校验管理页/监督入口 Origin，普通子空间不得调用管理 API。请求上限按图标许可大小设置，不接受任意代理URL。
- API 成功 {ok:true,value}，失败 {ok:false,error:{code,message}}，敏感原始异常仅落经脱敏的本地日志。客户端不根据HTTP200猜成功。不得增加 `recoveryPlan`、`suggestedFix`、`autoRetry` 等指导恢复字段。
- submit(command,requestId) 持久化且幂等；同requestId同命令返回原job，不同命令拒绝；job.result只允许合同中的字段，不直接透传内部对象。刷新只读取同一任务，不重新执行。
- 危险或需停机动作先preview再plan.execute；plan在服务器保存解析后的输入、目标与fingerprint，有效期5分钟；执行时再次核对目标状态/运行权，变化则要求新preview。取消只允许queued或尚未进入不可逆阶段，不能把“取消请求”伪装为已回滚。
- view(spaceId)只为已由监督进程启动、通过后端就绪检查的实例签发授权引导路径。entryPath不含DSH原始token；origin用于精确消息源检查。每次启动/重启递增generation，channel只做视图消息相关性校验，不授予管理权。
- 安装只接受服务端目录条目catalogId和精确版本；目录可复用原本npm/GitHub条目解析，但不得让客户端传本地file:/git/shell spec。保护官方核心与完整Spaces管理包。下载失败报错；读不到实际版本显示未知，不改用 latest。

## 拓扑

独立监督进程持有运行权、进程监督和任务执行，提供稳定HTTP入口。正常页面展示管理profile的原生DSH客户端，完整Spaces插件只在该profile提供工作台root布局。工作空间使用各自独立origin，视图桥不含管理能力。入口在管理profile停机时若自身仍在线，显示真实失败（错误详情、脱敏日志），监督进程不随管理profile停机。不得通过共origin反向代理所有工作空间来假装隔离。不提供救援页、检查并恢复、恢复中断任务。

管理profile内优先通过已认证的DSH Remote代理WorkbenchApi至监督进程，浏览器不接收进程间私密凭据；稳定入口直接使用监督进程受认证的同源API。保留独立稳定入口页面（正常时嵌入管理profile，停机时显示失败）。入口进程自己崩溃时用已有 stderr/启动器/日志，不另建看门狗。

整合澄清：WorkbenchView.entryOrigin 是监督进程的干净 origin，entryPath 相对此 origin；WorkbenchView.origin 是最终子 DSH origin，只用于消息校验。两者不应混用。新增必填 entryOrigin，所有生产 view DTO 与客户端必须携带并校验；不得把引导路径拼到子 DSH 端口。

controller.acquire是唯一允许只读端请求的写运行权操作，仍必须已有本机浏览器认证；只在无人占有且无歧义时获取，不自动抢占，不清锁，不接管身份不明的所有者。另一端释放后必须由用户明确点击接管，不因轮询发现空闲而自动获得运行权。这是正常双端控制，不是恢复。

## 任务状态

```text
queued → running → succeeded / failed / cancelled
```

进程中断后重开：读取原任务，展示中断失败或结果无法确认，保留最后阶段和证据，不重放命令，不对账修补环境。没有记录完成不证明命令没有生效。损坏或未知格式的任务文件保留原字节，不清空成默认状态。

不得要求 `recovery-required`、恢复冻结、`settleRecovery` 或 `recovery.resume`。不得要求先完成恢复结算再允许普通任务继续。

## 已选行为

- 保留所有已访问iframe，停止或重启其目标才销毁；不用新标签代替切换。失败的新启动保留上一视图，同时标明本次切换失败。
- managed=false的外部实例只能查看，不能start/stop/restart/adopt。
- 删除工作空间先预览。删除配置与保留/删除隔离数据分开；removeData默认false；web和manager保护。
- 插件toggle沿用桌面现有“安装到空间/从空间移除”语义，UI应直说，不伪装为无需重启的热开关。
- UI不提供修改管理环境的任意插件或主题；管理器自身包更新走受控、用户主动的维护，失败不自动回退。
- 基础状态轮询1秒，任务活跃时500ms；页面隐藏降频，不停止任务。轮询不触发接管、重启或重放。
- 默认使用已有home的源设置。当前二进制仍可能使用独立 snapshot 目录与旧读写格式；**目标政策**不把快照恢复列为 API 能力。API 映射去除home/bin路径。

公开命令不得再把 `recovery.resume`、`snapshot.restore`、`config.restore` 作为有效产品入口。调用已移除的恢复 API 必须明确失败（R6）。

## 并行模块

A1 owns home-controller.ts（管理身份/运行权）。后续监督runtime仅消费该模块，不能自行重写/清除owner。
任务持久化模块与runtime分开，以类型合同交接。公共合同、依赖和最终构建整合由Codex单写。

A2 owns src/adapters/node/workbench-jobs.ts、tests/workbench-jobs.test.ts、tasks/workbench-jobs-worker.md（持久化任务/幂等/取消/中断失败记录）。调用者必须先持有A1运行权；A2不启动DSH或管理进程。中断标记是失败终态，不是恢复合同。

维护层组合接口固定为 src/adapters/node/workbench-maintenance-ports.ts，由监督runtime提供现有模块与安全生命周期回调。维护层不自行生成第二个ProcessManager或运行权；controller.release/shutdown由监督层处理。所有业务目标验证和停机通过ports，避免绕过运行权或误停外部实例。Web停止超时应失败并保留实例记录，不沿用桌面ProcessManager默认自动强杀而不提示。维护层不得在故障后回滚、恢复快照或续跑中断任务。

> 历史记录：本文件早期把稳定入口写成恢复页，并把中断恢复标记写入 A2。那些要求已由 2026-09-15 let it crash 取代。当时的接口实现事实见源码与 [workbench-jobs-worker.md](workbench-jobs-worker.md)，待 R2/R6 删除。
