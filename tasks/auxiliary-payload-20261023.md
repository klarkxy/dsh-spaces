# 辅助预设文件遗漏修复与验收（2026-10-23）

## 原因和修复

`@dsh-spaces/llm-bridge/auxiliary` 在 package exports 中指向 `lib/auxiliary.js`。构建与 npm 包已包含该文件，但 `COMPONENT_PAYLOAD_REQUIRED_FILES` 漏列它。`stageComponentPayload` 调用 `copyComponentPayload` 只复制清单文件，导致启动目录缺失模块，官方加载器报 `ERR_MODULE_NOT_FOUND`，DSH 预设检查显示 `compaction-basic (@dsh-spaces/llm-bridge/auxiliary): never started`。

已将该文件列为必需组件文件，纳入摘要、缺失检查、启动复制和复制后完整性校验。没有修改官方 SDK、自动重试、恢复、启动或更新已运行服务的逻辑。旧的不完整清单会被明确拒绝；正常构建生成新摘要和新的不可变组件目录，不原地补写旧目录。

## 回归覆盖

- 两条组件回归在修复前均失败，确认旧代码错误地接受缺失文件和漏列文件的清单。
- 修复后覆盖：缺失时拒绝生成清单、漏列时在创建目标目录前拒绝复制、复制后文件与声明一致、同长度字节篡改被哈希校验拒绝。
- 新增实际打包回归：当前构建 → npm pack 主插件安装包 → 解包 → `stageComponentPayload` → 比较目标文件字节和摘要 → 新 Node 进程通过包 exports 导入实际辅助模块。测试使用真实已安装 SDK，临时 Home 和独立 npm 缓存，不发送模型请求。
- 更新五处测试文件中的完整组件夹具。打包 helper 新增可选子进程环境参数，默认行为不变；测试传入专属缓存，不修改进程全局环境。
- CI 的 Windows gate 将既有构建步骤移到测试之前，确保干净 checkout 中的实际打包回归使用本轮构建；另一条调用该测试的 plugin-install 作业原本已先构建。

## 实际安装包链路

保留产物：`.sandbox/auxiliary-fix-artifacts-20261023/`。

- `pack-report.json` / `pack.log`：四个本地包生成成功，主包文件和清单摘要逐一验证。
- 主包：`dsh-spaces-plugin-0.4.0.tgz`，SHA-256 `9c3aff94b6d64ac323be295c5158858c25919d7f74e3c09bb2eab78041040365`。
- 组件摘要：`d9113dd7da80d036ad852ad36ed719c6202b251d64a7bbf2a81b32e06413e87a`。
- `verify-chain.ts` / `CHAIN-RESULT.json`：从上述主包解包，再走正式启动复制，核对构建／归档／目标字节及摘要；目标包 exports 解析到目标目录中的辅助文件；实际 Cordis Loader 导入成功，官方 DSH 0.2.1-rc.2 `auditRows` 的 failed 为空。
- 有界加载验证没有提供完整宿主服务，因此 pending 为 `waiting for spacesAuxiliarySources`，这是缺少完整宿主服务的明确限制，不是完整 Desktop／会话创建／压缩行为验收。

## 完整检查

首轮 `.sandbox/auxiliary-fix-checks-20261023/` 保留了用户 npm 缓存 `EEXIST` 失败（test、test:llm、包预检），其余组通过。打包回归改为专属缓存后定向通过；独立完整打包也在专属缓存通过。开发验证重跑没有改变产品失败处理政策。

最终检查使用 Node 26.10.0、仓库外临时根 `H:/Code/dsh-spaces-checktmp`、隔离 Home 和独立 npm 缓存，结果目录 `.sandbox/auxiliary-fix-final-checks-20261023/`。14 组全部执行，其中 13 组通过：清单检查、三组类型、构建、默认测试 275、spaces 148（1 跳过）、workbench 575（2 跳过）、recovery 31、LLM 124、blueprints 94＋240（4 跳过）、browser 13 和包预检。

最后的 workbench:browser 为 14 通过／1 失败：既有 `serve()` 通过 `listen(0)` 获得系统随机端口 5061，Chromium 在 `page.goto` 时以 `ERR_UNSAFE_PORT` 拒绝，未进入页面断言。原日志保留，不把该轮 check:all 记为全绿。未改浏览器或产品代码，独立启动一次浏览器组核验，15/15 通过，日志 `.sandbox/auxiliary-browser-check-20261023/browser.log`。CI YAML 已解析并检查两条相关作业均只构建一次且先构建后测试；未声称 GitHub Actions 已运行。

## 边界

没有访问真实 Home、安装到用户宿主、重启服务、调用模型、提交、推送或发布。保持原有工作区修改。安装包已生成但尚未在用户当前运行的 Desktop 生效。
