# 2026-11-14 npm 发布与 Release 自动发布

用户明确授权发布当前包，并配置以后发布 GitHub Release 时自动发布 npm。目标为现有的 `dsh-spaces@0.5.0`，不单独发布内嵌组件；`outputs/` 下已有未跟踪素材保留。

## 实施

- `npm-publish.yml` 监听 `release.published`，校验仓库、标签、主包与同版本组件和预发布状态。封存 Browser base 保持独立产品版本。复用现行 CI 与插件打包流程；正式版进入 `latest`，预发布版进入 `next`。
- 使用仓库加密 Secret `NPM_TOKEN`，仅向发布步骤注入。凭据通过本机用户环境变量读取并经标准输入加密保存，不写入仓库或命令参数。
- 发布已检查的 tarball，禁止重复版本、发布请求重试和自动撤包。发布后匿名核对包身份、SHA-512、SHA-1、下载字节及渠道；验证成功的归档和发布报告附加到 GitHub Release。
- 标准安装验收增加精确 npm 版本来源，保留 Git 完整提交和本地 tarball 路径。这个既有大脚本只调整来源选择与安装后核对，不为局部维护重组整个生命周期流程。
- 现行安装和发布文档随实施更新；历史 npm 方案保持归档状态。

## 验证

新增发布回归覆盖事件边界、预发布渠道、组件版本不一致、归档篡改、公开字节和渠道不一致、未知下载域、已存在版本、注册源错误和不重试语义，最终定向执行 6/6 通过。

受限执行中的目录 junction 和进程操作出现权限失败，原日志保留在 `.sandbox/npm-release-20261114-checks/`；单独诊断也观察到 `EPERM`。该次执行不算通过。按项目要求改用普通进程和全新仓库外临时目录，完整 `check:all` 17 个阶段全部通过：1,725 次测试执行，1,717 通过、8 跳过、0 失败。跳过为 7 个当前账户不能创建文件符号链接的用例和 1 个未指定 CLI 路径的可选集成用例。证据：`.sandbox/npm-release-20261114-ordinary-checks/result.json` 及同目录日志。

公开 npm 安装验收显式选择官方 registry，避免新版本尚未同步到默认镜像。最后这处验收工具调整另行通过语法检查；发布回归再次 6/6 通过，不改变分发运行时代码。

## 首轮 Release 触发

GitHub Release `v0.5.0` 指向 `4d8f890684dda424adcafdacb6a5404f006940c1`。首轮自动流程 `43604718892` 在 prepare 的版本校验处失败，打包和发布均未执行。原因是新增校验错误地要求封存的独立 Browser base 从 0.4.0 跟随主插件升为 0.5.0。按现行架构修正为只同步根包、plugin、supervisor、view-bridge 和 doctor，Browser 继续由组件 manifest 和摘要核对。回归同时检查真实仓库版本及独立 Browser 版本，不只检查人为同版本 fixture。

现有标签与已发布的 GitHub Release 不重指、不删除。首次 npm 发布将使用同一标签对应的分发内容在本机完成；后续 Release 自动采用 main 上修正后的流程。首轮失败记录保留，不重跑其旧代码。

受限检查遗留的测试进程树（根 PID 69896）只尝试过一次非强制结束，Windows 拒绝正常终止。未使用强杀或删除现场；该失败检查始终不计入通过证据。

## 提交与当前公开状态

- 本机按用户授权只执行了一次 `npm publish`，CLI 退出 0 并返回 `+ dsh-spaces@0.5.0`。发布前检查分发源码、包元数据及构建/打包脚本与 `v0.5.0` 标签一致；本次本机发布没有 GitHub Actions provenance。
- 已审阅主包为 `dsh-spaces-0.5.0.tgz`，SHA-256 `e82770380a51d07cd353ee1a397f6b351fc5cca26ca7188fc2f0f548324b6e13`。主包内组件 manifest 摘要为 `da1ff2dcb64f54c30c78f0e162b5ef65721413bcc1c703399da0f2e5e05667f6`。
- 首次公开核对返回 HTTP 404，保留状态 `published-verification-failed`，没有再次发布。之后查询可见归属 `klarkxy` 的 `dsh-spaces` 包，但 `latest` 和唯一公开版本仍为 `0.0.0-stage`；包页说明真实版本已提交审核、等待 staged release。不能将 CLI 的成功回执当作真实版本已公开。
- 通过 token 查询 `/-/stage?package=dsh-spaces` 返回 200、0 个条目。浏览器包页同样显示占位，当前浏览器未登录 npm，无法核实账号内部是否存在审批提示。尚不能确定只需等待还是需要额外账号操作。
- GitHub Release 已附加主包和提交状态报告。重新从 Release 下载 tarball，SHA-256 与审阅归档一致，结果为 `.sandbox/npm-release-20261114-first-package/github-asset-verification.json`。Release 正文明确注明 npm 待公开，避免把占位版本作为可用插件安装。
- 修正后的远端 CI `43605347447`（`ee5f5b6cbe6f8c4c75667859aede5b178bd5167f`）全部通过，包括 Node 24.21.0 / Node 26.10.0、真实官方 CLI 和 Web 安装、Git 根安装、空间操作、正常关闭与重开。首轮 Release 自动发布 run 的 prepare 失败记录保留，不能宣称自动实发通过。
- 已用真实 GitHub Release 数据执行修正后的 `prepare`，正确产生 `version=0.5.0` / `tag=latest`；发布回归最终 6/6 通过。

## 凭据后续

当前 token 到期时间为 2027-01-09 09:01（北京时间）。npm 已公告 2027 年 1 月移除 token 直接发布新版本的能力，因此长期自动发布需要在 npm 后台配置允许 `npm publish` 的 GitHub Trusted Publisher。工作流已有 `id-token: write`，脚本接受 token 或 GitHub OIDC；信任配置仍需维护者在 npm 完成交互式 2FA，当前没有宣称该绑定已经完成。

真实 npm 版本公开、完整性/渠道核对和从 npm 安装的生命周期验收仍待完成；不将 GitHub 归档可下载等同于 npm 可安装。
