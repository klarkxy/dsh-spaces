# 本次文档检查与证据边界

日期：2026-09-25。来源基线：`c700f548157d6dab111e6c3f4830d524c573d647`。范围：新增首页设计文档、TypeScript 合同、静态示例及其检查脚本。

## 已执行

- 独立 TypeScript strict/noEmit 检查通过；示例中 `action.execute` 的负面类型断言也通过，确认它不属于 v1 BoardCommand。
- 合同与示例编译为临时 CommonJS 后，[check-examples.cjs](check-examples.cjs) 的 12 项文档 fixture 检查全部通过：两类快照、独立 run 序列、跨空间布局、查询/响应顺序、引用、选定发布，以及重复实例、类型错配、进度越界、内容超限和布局重叠负例。
- 新文档内相对链接均指向本次文件或已经读取/确认的基线路径；代码围栏成对、行尾空白检查通过。
- 人工对照现有 AGENTS、故障政策、管理合同、原生插件装配、view-bridge、蓝图 v1 与组件清单。明确排除自动重连、公开业务执行接口、根 web 静默迁移和给普通空间安装完整管理器。

本次检查环境为 Node 22.16.0、TypeScript 5.8.3。这里只验证自包含文档样例；仓库开发与后续运行验收仍使用项目要求的 Node 24 和锁定依赖，不能用本次环境替代。

## 复现文档样例检查

在安装项目依赖后，从仓库根目录执行（只写项目沙箱，不写用户 Home）：

```sh
npx --no-install tsc --strict --noEmit --target ES2022 --module commonjs --moduleResolution node docs/dashboard/contracts.ts docs/dashboard/examples.ts
npx --no-install tsc --strict --target ES2022 --module commonjs --moduleResolution node --outDir .sandbox/dashboard-contract-check docs/dashboard/contracts.ts docs/dashboard/examples.ts
node -e "require('node:fs').writeFileSync('.sandbox/dashboard-contract-check/package.json', JSON.stringify({type:'commonjs'}))"
node docs/dashboard/check-examples.cjs .sandbox/dashboard-contract-check/examples.js
```

`check-examples.cjs` 只是这些静态样例的关系检查器，不是可投入生产的通用协议 validator，不校验完整认证、字节流重复键、时钟窗、磁盘事务或并发。P0 仍须实现严格运行时校验，P1..P5 仍须真实施工。

## 未执行、不能据此宣称通过

未实现或启动 DashboardHub/provider/看板 UI；未运行项目完整测试和构建；未做真实 DSH 插件安装、浏览器、Electron、Windows ACL、组件清单升级、数据迁移、权限攻击、故障注入或性能验收。未访问真实 `~/.dsh`，未发布版本。

没有将历史版本的验收复制为本方案的证据。后续 [D01..D22](implementation.md) 全部保持待验收，执行结果继续写入仓库唯一活动账本。
