# 工作台接口与所有权导航

本文件只负责导航，不再复制一套协议。现行完整管理合同是 [merge-contract-v2.md](merge-contract-v2.md)；公共 API 语义见 [workbench-api-surface.md](../docs/workbench-api-surface.md)；架构与数据所有权见 [architecture.md](../docs/architecture.md)；故障政策见 [let-it-crash.md](../docs/let-it-crash.md)。

## 核心边界

- 每个 Home 只有一个 Supervisor 执行 Spaces 管理写入，宿主不创建第二套后台。
- `spaces-hub` 承载管理工作台，普通空间不注册管理 Remote。
- 展示、管理和 LLM 数据面是不同权限与可用性边界。
- 普通变更经过服务纪元、状态版本、请求 ID 和串行执行校验；危险操作先预览再执行。
- 刷新只读取原任务，中断不重放；凭据不进入通用任务。
- 关闭客户端不停止服务，停止全部空间和停止服务是不同操作。
- 快照只有创建、查看和删除；Doctor 只诊断。
- Spaces 升级只走宿主插件更新、正常停服务和重新打开，不使用应用内自我更新或启动器交接。

## 文档分工

- **产品需求**：[REQUIREMENTS.md](../REQUIREMENTS.md)。
- **角色、数据流与可用性**：[architecture.md](../docs/architecture.md)。
- **管理协议与 DTO 语义**：[merge-contract-v2.md](merge-contract-v2.md)。
- **API 公共 wire 与变更纪律**：[workbench-api-surface.md](../docs/workbench-api-surface.md)。
- **用户与运维操作**：[workbench.md](../docs/workbench.md)。
- **失败、故障证据与有限手动服务操作**：[let-it-crash.md](../docs/let-it-crash.md)。

> 历史：早期合同中的恢复页、双端控制权交接、应用内升级和一次性启动器交接均已撤销。相关实施记录只作历史证据，不是现行 API 或验收门槛。
