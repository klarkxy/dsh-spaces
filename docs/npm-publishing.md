# 发布 Spaces 到 npm

Spaces 使用项目级包名 `@dsh-spaces/plugin`，与第三方作者的 npm scope 分开。第三方插件通过[公共目录](../catalog/README.md)贡献，作者无需获得 Spaces 核心包的发布权限。

发布入口是 GitHub Actions 的 **Publish Spaces to npm**。它只响应维护者手动触发，不因普通推送、目录收录或第三方 PR 自动发布。唯一发行包是包含同组组件的插件 `.tgz`，不单独发布 Supervisor。

## 账号准备

首次发布前，需要拥有 npm `@dsh-spaces` scope 的发布权限。包名中使用项目名称不等于已经创建或取得同名 npm 组织；npm 账号、组织成员和 GitHub 仓库权限分别管理。

持续发布使用 npm Trusted Publishing。按 npm 当前界面完成首次包建立及发布权限设置后，在该包的 Trusted Publisher 配置中填写：

| 字段 | 值 |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `klarkxy` |
| Repository | `dsh-spaces` |
| Workflow filename | `npm-publish.yml` |
| Environment | `npm` |
| Allowed action | `npm publish` |

这里的 `klarkxy` 是当前 GitHub 仓库所有者，不是 npm 包 scope。将来若把仓库迁入项目组织，应同步仓库地址、发布校验与 npm 的信任绑定。

工作流使用 GitHub 托管 runner、OIDC 临时身份和公开 provenance，不复制其他仓库的 npm Token。npm 文档要求 CLI 至少为 11.5.1、Node 至少为 22.14；工作流固定的 Node 26.10.0 满足运行需求。Trusted Publisher 的配置与有效期以 [npm 官方说明](https://docs.npmjs.com/trusted-publishers/)为准。

建议在 GitHub `npm` Environment 中配置维护者审批和 `main` 分支限制。首次包建立可能需要 npm 网页或本机登录的交互授权；没有有效身份时，CI 配置本身不会赋予发布权限。

## 准备发布

1. 将拟发布的精确版本写入 root、plugin、Supervisor、view-bridge、doctor 的 `package.json`，按项目版本规则提交到 `main`。候选版建议使用 `0.5.0-rc.1` 这样的预发布版本；不要把尚未发布的版本写成“已发布”。
2. 打开 **Publish Spaces to npm**，填写版本，选择 `next`（候选）或 `latest`（正式）。第一次核对时保留 `publish=false`。
3. 工作流复用完整 CI 和现有打包流程，再下载同一次运行生成的归档，核对包名、版本、SHA-256、包内 manifest 和仓库身份。`publish=false` 生成审阅制品，不调用 npm 发布。
4. 确认账号条件和制品验收后，使用 `publish=true` 发起发布。工作流只尝试一次，不自动改版本、覆盖版本或续跑失败发布。

发布成功后，流程匿名读取 npm 元数据、下载公开归档，核对 SHA-512、SHA-1、包名、版本及所选 dist-tag。检查结果保存在 `npm-publication-*` artifact 的 `publication.json`；实际发布与发布后核对是两个状态。

如果发布请求失败或响应无法确认，先只读查询 npm。已经发布的版本不能当作“失败了所以没生效”；若版本已存在，发布脚本会拒绝再次发布。发布后核对失败也不会删除、撤包或重新发布。

有需要时，可下载同一份打包制品，在设置 `RELEASE_VERSION` 和 `RELEASE_TAG` 后运行 `node scripts/npm-release.mjs verify <pack-report.json>`，只读核对其公开内容。

## 发布后的安装

仅在对应版本实际发布后，用户才可用 npm 包名安装。例如候选渠道：

```sh
dsh plugin --profile web add @dsh-spaces/plugin@next
```

现有 tarball 安装方式继续可用。真实 Desktop、插件组合和持续运行的验收状态仍记录在维护待办；构建与 CI 通过不替代它们。
