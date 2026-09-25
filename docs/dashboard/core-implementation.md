# 首批核心实现与验证边界

日期：2026-09-25。基线：[设计 PR #10](https://github.com/klarkxy/dsh-spaces/pull/10)，`e468bf5e60b250fc059e3e3168b9159b291690bf`。实际阶段进度仍以 [唯一活动账本](../../tasks/todo.md) 为准。

本批提交可执行的纯 TypeScript 核心与测试，**不是已安装的看板插件，不是已经接入的 Supervisor Hub，也没有替换首页**。P0 真实 SDK 验证尚未完成，P1–P5 不因本批代码存在而自动完成。生产入口、依赖、组件清单、默认 web 和用户 Home 均未改动。

## 已落入代码的合同

| 模块 | 实现 | 调用边界 |
| --- | --- | --- |
| `src/shared/dashboard.ts` | v1 DTO，与设计合同逐字对比（首行状态注释除外） | 不是已发布 SDK |
| `validation.ts` | 严格 JSON、封闭字段、四类内容、整份快照引用、查询、布局、发布、心跳与授权计划校验 | 适配器必须在读取 body 时先限流量和字节，再调用解析器 |
| `projection.ts` | run/grant/sequence、重复确认、选定实例、离线与撤销读取 | `preparePublication` 只准备候选，不代表已耐久接受 |
| `boards.ts` | 布局 CAS、请求幂等、回执保留、删除 tombstone、撤销后回执过滤 | `prepareLayout` 只准备完整文档，必须与回执共同原子提交 |
| `provider.ts` | 每绑定一个注册表、串行 snapshot、有界合并、Home 发布终态、5 秒超时、正常 dispose | Host 必须提供真实身份绑定、存储与已授权传输；没有凭据发现或网络实现 |
| `read-session.ts` | 成功期间只读轮询、失败终止、取消与迟到响应、敏感内存清理 | read 回调必须先验证响应；这里不提供 DashboardBackend 或 UI |

源代码位于 [核心目录](../../src/core/domain/dashboard)，没有 Electron、Node 文件系统、DSH SDK、HTTP 服务或网络发现依赖。测试中的两个空间、权限主体、提交端口和传输都是显式 fixture，不是独立 Host 进程。

## 后续装配必须履行的义务

身份由真实 Host 上下文绑定，不能直接拿客户端 body 构造 PublishAuthority。聚合端在单写者临界区重新检查当前授权，再准备并提交候选；成功确认只能在存储提交完成之后发出。纯 reducer 不提供锁、崩溃一致性或持久性保证。

PublicationChannel 接收已经认证的 send 回调。后续适配器还必须落实 loopback/Origin/Cookie 校验、私有 bootstrap、重定向拒绝、abort、provider 每秒一次与 run 每秒五次的公平有界调度。当前核心只有每 provider 一个在途 snapshot 加一个合并槽，不能据此声称 Home 全局限流已实现。

撤销测试证明的是当前策略下的纯读取与回执过滤；实际策略耐久提交、磁盘清除、目录 cursor、导航和在线客户端响应竞态仍需 P2 的集成验证。测试中的布局竞争按相同 revision 提交候选，不能代替跨进程文件锁和双端浏览器验收。

Markdown 校验不是 HTML sanitizer。UI 必须禁用原始 HTML、脚本、外部资源和危险链接，不能因为通过内容 schema 就渲染任意网页。当前时间解析接受有效带时区日期和秒值 00–59；RFC 3339 闰秒表示尚未实现，P0 冻结接线前需定稿并同步合同/测试，不能宣称已实现完整 RFC 3339 语义。

## 本次实际验证

运行环境：Linux、Node `22.16.0`、预装 TypeScript `5.8.3`。项目要求的 Node 24、锁定依赖组合和真实官方 `0.1.7-alpha.1` 插件安装，本地未验。

`node scripts/test-dashboard-core.mjs` 先 strict 编译核心，再运行 Node test。默认使用项目已安装的 TypeScript；离线环境可明确指定预装编译器：

```sh
DSH_DASHBOARD_TSC="$(npm root -g)/typescript/bin/tsc" node scripts/test-dashboard-core.mjs
```

结果：**52 项通过、0 失败、0 跳过**。包含 500 个确定性合法 JSON 的对照生成检查，以及重复键、非法 UTF-8、越界、同序列异内容、旧 run/grant、回执撤销、超时不重发、终态不再发送与取消竞态。文档 DTO 与运行时 DTO 的同步检查也在同一测试内。

测试目录仅为本仓库 `.sandbox/dashboard-core-*` 的本次临时目录；脚本不安装或运行 DSH，不访问真实 Home，不自动切换编译器。独立 CI 工作流在 Node 24 的 Linux/Windows 上运行相同核心测试；工作流定义不是通过证据，实际结果以对应提交的 Actions 为准。

SDK 获取探针执行 `npm view @deepseek-ai/cordis@4.0.3 version --fetch-retries=0 --fetch-timeout=5000`，因执行环境 DNS `EAI_AGAIN` 失败。没有据此判断 SDK 不兼容，也没有换依赖、伪造官方接口或绕过安装。通过连接器读到的官方架构文档只用于源码导航，不作为安装版本的实测证据。

未执行：完整项目构建/回归、真实可选服务/认证代理/存储/共享 React、Windows ACL、HTTP 攻击与故障注入、持久化提交、真实多空间、浏览器/Electron、六组件过渡、标准插件打包安装及性能负载。

## 接续点

先在可安装依赖的隔离 Node 24 环境完成 P0 探针并留下精确版本和命名 profile 证据，再接 local 存储、Host registry/认证适配、固定 renderer 和共享 DashboardView。Home 聚合与管理授权沿既有 Supervisor 接入，不通过模拟数据接管首页。首版发布仍受 [完整施工验收门槛](implementation.md) 约束。
