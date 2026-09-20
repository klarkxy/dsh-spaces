# 现行文档叶（merge-b-docs）

2026-09-20。只改现行说明，不改源码、Git、配置、凭据。Supervisor / launcher 仍由其他写者拥有。

写入：

- `README.md`
- `docs/workbench.md`
- `tasks/workbench-contract.md`
- `tasks/merge-b-docs.md`

依据：[merge-contract-v2.md](merge-contract-v2.md)、[spaces-merge-convergence.md](../docs/plans/spaces-merge-convergence.md)。历史文件未改写，只在文首指向 [history-recovery.md](history-recovery.md)。

## 现行合同（写入上述三份）

- 一个 Supervisor，协议 **2**，`serviceEpoch` + `revision` CAS。
- 桌面退出只销毁客户端，后台继续。停止服务是显式 `service.shutdown`。
- 公开 API 没有 `controller.acquire` / `release`、没有恢复命令。
- 通用 Node 模块在 `src/adapters/node`。
- `--snapshot-worker`：正常快照与剩余安装 IO。运行时安装已抽出。不是恢复。
- 五组件不可变清单与同组制品；bootstrap 传 `--component-payload`。
- 删掉「等 R4 再抽 snapshot-worker」这类过期施工指示。Doctor 旧恢复命令按现行合同写成不支持，不当成待办缺口。

## 合同目标 vs 已核实

| 项 | 状态（本文写法） |
|---|---|
| 协议 v2 / 无公开接管与恢复 | 现行合同 |
| 五组件清单、pack、`--component-payload` | 实现已有；主 Agent 称归档解析叶含 CLI 共 25 项通过。本叶未重跑 |
| B5 启动器交接、真实 UI、发布包、完整 handoff | **未验收**。写成 intended，未写成 PASS |

本叶没有编造验证，没有跑安装包或双端 UI。
