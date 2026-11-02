# 检查失败修复与文件来源核对（2026-10-22）

> 历史导航：本文件是 2026-10-22 的历史验收收口记录，只证明当时范围。现行架构见 [architecture.md](../../docs/architecture.md)；故障政策见 [let it crash](../let-it-crash.md)。文中与现行架构冲突的桌面壳、应用内升级、恢复、交接或旧 LLM 方案内容，仅作历史参考，不是当前合同或验收门槛。

状态：已定位并修复，针对性 12 项 worker 测试及包预检通过；最终完整检查 **15/15 全部通过**，指定 Astra 独立复核 **READY（仅本轮检查收口）**。官方 SDK、node_modules 和产品运行时未修改；不提交、推送或发布。

证据目录：`.sandbox/construction-20261021/verification-closeout-1/`。本轮基线 `BASELINE.json` 共 841 条：838 个现存文件、3 项已删除状态；HEAD `26aab5dc095bd97f132f5748aa727b800bb42916`。

## 三份文件：既有删除被误报为新增缺失

涉及 `packages/plugin/src/workbench/recovery.tsx`、`tests/fixtures/workbench-crash/driver.ts`、`tests/fixtures/workbench-crash/snapshot-worker.ts`。

- 原 S0 基线 `.sandbox/construction-20261021/s0-1/baseline.json` 在 2026-10-21 **17:33:37（上海）** 已逐项记录 Git 状态 ` D`。主 facade 阶段及辅助阶段的 BASELINE.json 又逐项记录 `deleted: true`，没有文件摘要。故删除早于本轮辅助调用施工，不是过程中新增丢失；未把最初删除命令的执行者猜成某个代理。
- 上轮新审计脚本使用“磁盘不存在，或摘要变化”判断 changed，忽略了基线 deleted 标记，导致把三项既有删除误判为 unownedChanges。此前“来源未确认的三份新增缺失”结论撤回，原始错误审计和 Astra 复核原文保留。
- `audit-deletions.mjs` 对四种状态断言：基线已删除且仍不存在不变、重新出现算变化、现存文件后来丢失算变化、摘要一致不变。`FILE-PROVENANCE.json` 和旧阶段 `AUDIT-revise-baseline-correction.json` 保存 S0/辅助基线、原审计摘要及更正结果。
- 旧审计脚本已修正并保留修复前副本；原 AUDIT-revise-final.json 不覆写，重新运行写入 AUDIT-current-corrected.json。历史辅助阶段基线实际是 **836 条记录＝833 个现存文件＋3 项既有删除**，12 个授权内既有文件变更、821 个现存文件未变，另 3 项删除状态未变，新增 5 个文件。不能把 836 条全部称为现存文件。

三份文件维持基线的已删除状态，没有恢复旧页面或历史夹具，也没有删除任何额外文件。本轮查明的是误报来源及删除早于 S0 的事实；最初删除命令及执行者不在本轮证据中，不据文件名猜测其归属或动机。

## 三项检查的共同根因与修复

原失败保存在 `plugin-auxiliary-1/checks-revise/`，workbench 547 pass / 7 fail / 2 skip，recovery 26 pass / 5 fail，包预检退出 1，均为原生 esbuild 服务写外部临时目录的 `Access is denied`，分别涉及 snapshot-worker.mjs 与 validator.mjs。

`ESBUILD-OWNER-PROBE.json` 是同一普通 Node 26.10.0 进程、新建仓库外临时根的对照：原生 esbuild 直接写文件失败；同一编译器返回内存结果，由创建目录的 Node 进程写入并 import，成功得到值 17。保留失败目录，不改 ACL、不重试失败任务。PROCESS-PRIVILEGES.json 只读确认检查进程管理员令牌为 false，没有 RunAs/UAC 提权。

复用主构建已有模式，仅修改三处临时编译入口：

| 文件 | 改动 |
| --- | --- |
| tests/runtime-installation.test.ts | worker 构建 write:false，核对单一输出，由 Node 独占写入 |
| tests/maintenance-responsiveness.test.ts | 同样处理真实 worker 构建，保留原心跳及故障断言 |
| scripts/pack-spaces-plugin.mjs | validator 构建 write:false，由 scratch 持有进程写入后执行原验证 |

输出路径、编译配置、worker／validator 源码、错误传播及实际断言不变。没有新增依赖、重试、权限放宽或产品恢复流程。构建失败仍直接失败；Node 写入使用 wx，已有文件或写入错误仍原样失败。

## 验证

FOCUSED.json：两个真实 worker 测试文件共 **12/12**，包预检 exit 0；nested-tgz 负例和正式 dry-run payload 检查均通过。包预检不写发行 tarball，更不代表发布。

最终检查见 checks/result.json、checks/SUMMARY.json、check-all.log，Node 26.10.0、固定 rc.2 SDK，在新隔离 Home、授权仓库外临时根顺序执行，无重试。15 项检查全部 exit 0。

| 检查 | 结果 |
| --- | --- |
| 测试清单、三组类型检查、构建 | 全部通过 |
| 核心 | 268/268 |
| spaces | 148 通过，1 条条件跳过 |
| workbench | 554 通过，0 失败，2 条条件跳过 |
| workbench recovery | 31/31 |
| LLM | 120/120 |
| blueprints | 94 + 239 通过，4 条条件跳过 |
| browser | 13/13 |
| dashboard | 52 + 152 通过，1 条条件跳过 |
| 包预检 | 通过（dry-run，不写发行 tarball） |
| workbench 浏览器 | 12/12 |

正常条件跳过保留，没有为通过检查删断言。原 workbench 7 个和 recovery 5 个失败现在实际执行通过。历史辅助调用报告的 12/15 与三项写入失败是当时真实结果，本轮结果另记，不覆盖旧失败。

FINAL-AUDIT.json 将变更限制为两个测试文件、一个包预检脚本及协调文档。基线 3 项删除状态不变，其余非本轮文件摘要保持。官方 SDK 16 个关键入口摘要与前轮相同；正式 LLM 的 index.js／auxiliary.js 与此前实机安装文件摘要一致，没有再次请求供应商。HEAD 未变。PROCESS-AUDIT.json 未发现本阶段可识别进程残留。

## 指定 Astra 独立复核

指定 Astra 的 ASTRA-REVIEW.md 为 **READY，仅本轮检查收口**，并明确撤回上轮对三项既有删除的错误分类。它独立核对 S0／两阶段基线、全套原日志、当前源码、16 个 SDK 入口及已安装 LLM 产物摘要；确认原 12 个失败用例实际通过、7 个既有文件变更、831 个现存文件一致、3 项既有删除一致。没有修改产品、重跑测试或请求供应商。

PATCH-INTEGRITY.json 另将三处补丁仅在内存中逆转，重建各自原始 CRLF 字节后摘要均与基线一致，证明文件中的既有内容保留。首次附加诊断用 LF 字符串匹配 CRLF，未成功删去补丁字段而误触发摘要断言；诊断原值另留 PATCH-INTEGRITY-first.json，修正后未写回任何源码。

结论仅限文件来源纠正与三项检查缺口收口，不代表稳定 capability 契约、完整 S1/P0/P1、安装版 Desktop、持续运行或发布验收已完成。官方 SDK 不变，未提交、推送或发布。
