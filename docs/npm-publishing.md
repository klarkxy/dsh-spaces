# npm 发布

发行包是 `dsh-spaces`，版本取自 `packages/plugin/package.json`。主包携带 Supervisor、管理插件、view bridge、Browser 实现和安装 worker；这些内部组件不分别发布。

## 发布一次新版本

1. 更新根包及 `plugin`、`supervisor`、`view-bridge`、`doctor` 的版本号，补齐 `CHANGELOG.md` 和 `docs/releases/` 中的发布说明，提交到 `main`。封存的 Browser base 保持自己的产品版本，由组件 manifest 和摘要校验，不随主包机械升版。
2. 完成本地 `npm run check:all`，确认该提交的远端 CI 通过。
3. 为该提交创建 GitHub Release，标签使用 `v<精确版本>`，例如 `v0.5.0`。正式版不要勾选 Pre-release；`v0.5.1-rc.1` 这类版本必须勾选。
4. 发布 Release。`Publish Spaces to npm` 会在该标签提交上重新运行 CI、构建和打包，再将同次运行生成的主包归档发布到 npm。正式版使用 `latest`，预发布版使用 `next`。

草稿、编辑 Release、普通推送和仅创建标签不会发布 npm。标签、组件版本或预发布状态不一致时，发布流程拒绝继续。公共插件目录的收录不触发核心包发布。

成功后，流程匿名读取 npm 元数据并下载公开 tarball，核对包名、版本、SHA-512、SHA-1 和 dist-tag。已验证的主包及 `publication.json` 会附加到 GitHub Release；Actions 同时保留打包报告和发布结果。

## 凭据

当前仓库的 Actions Secret **`NPM_TOKEN`** 保存有包写权限的 npm token。需要非交互发布时，token 必须允许绕过发布所需的 2FA。token 只传给发布步骤；依赖安装、构建、测试和打包不接收该值。发布使用官方 npm 源，并在 GitHub Actions 中生成 provenance。

本机环境变量不会自动传入 GitHub Actions。首次配置或轮换时，将新值通过标准输入交给 `gh secret set NPM_TOKEN --repo klarkxy/dsh-spaces`，不要把值写进命令参数、提交文件或日志。token 到期前需要更新仓库 Secret。

### 切换到 Trusted Publishing

npm 已公告在 **2027 年 1 月**取消 granular token 直接发布新版本的能力。长期自动发布应使用 npm Trusted Publishing；只更新 token 的到期时间不能绕过这项平台变更。

工作流已声明 `id-token: write`，发布脚本也接受 GitHub OIDC 身份。维护者在 npm 的包设置中添加 Trusted Publisher：

| 字段 | 值 |
| --- | --- |
| Provider | GitHub Actions |
| Repository owner | `klarkxy` |
| Repository | `dsh-spaces` |
| Workflow filename | `npm-publish.yml` |
| Environment | 留空；当前工作流没有绑定 Environment |
| Allowed action | 明确允许 `npm publish`；仅允许 `npm stage publish` 不能直接发布 |

保存信任配置需要维护者完成 npm 的交互式 2FA。配置完成后移除仓库的 `NPM_TOKEN` Secret，让后续 Release 使用 OIDC，并在首次运行中核对发布身份和 provenance。当前保存 token 不等于已经配置 Trusted Publisher。

平台规则见 [npm access tokens](https://docs.npmjs.com/about-access-tokens/) 和 [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)。

## 失败与核对

流程只尝试发布一次，不自动重发、撤包或换版本。npm 中已存在该版本时直接拒绝发布。失败或响应不确定时，先查看保留的 `publication.json` 并只读查询 npm，不能把命令失败等同于没有发布。

发布成功后若下载或渠道核对失败，npm 上的版本仍可能存在。下载同次 Actions 的 `dsh-spaces-<版本>` artifact，在其目录中设置 `RELEASE_VERSION` 和 `RELEASE_TAG`，然后运行：

```powershell
node scripts/npm-release.mjs verify <pack-report.json 的完整路径>
```

这条命令只核对公开内容。`check` 模式只检查本地归档；`publish` 模式只接受本仓库的已发布 GitHub Release 事件。
