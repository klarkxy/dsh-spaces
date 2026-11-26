# Spaces 公共插件目录

这个目录面向所有 DSH 插件作者，不要求加入某个 npm scope，也不要求把源码迁入 Spaces。作者继续在自己的仓库和 npm 包中维护插件；Spaces 提供统一的发现与安装入口。首批条目来自 dsh-plugins，后续收录采用同一贡献流程。

用户可以在空间设置的“插件”页浏览目录，或使用“按 npm 包名安装”查询未收录插件。安装前选择精确版本并查看预览。新版本从 npm 读取，不需要等待 Spaces 发版。

## 提交插件

1. 先将可安装的 DSH bundle 发布到 npm。包的 `package.json` 应声明 `dsh.bundle.patch`、公开的 `repository` 地址和支持的 `engines.dsh` / `engines.node`；共享依赖库不单独收录。
2. Fork 本仓库，在 `catalog/plugins.json` 添加一条记录。无需改动已有作者的条目。
3. 在仓库根目录运行 `pnpm install --frozen-lockfile`、`pnpm run catalog:build`、`pnpm run catalog:verify`。
4. 提交包含 `catalog/plugins.json` 和生成文件 `catalog/index.json` 的 Pull Request。维护者审核用途、来源与测试信息，通过后合并；不授予核心包的发布权限。

```json
{
  "package": "@your-name/dsh-example",
  "category": "workflow",
  "title": { "zh": "插件名称", "en": "Plugin name" },
  "summary": { "zh": "说明用户可以用它做什么。", "en": "Explain what the user can do with it." }
}
```

分类可选 `workflow`（工作方式）、`sessions`（会话与记忆）、`models`（模型与联网）、`dev`（插件开发）、`interface`（界面）、`media`（多媒体）、`other`（其他）。包名可带作者 scope，也可不带；npm 包身份是目录里的唯一标识。

构建命令从 npm 自动补齐当前 `latest` 的精确版本、作者、仓库、许可证、支持的版本范围及 bundle 声明，不下载或运行插件代码。CI 检查重复项、数据格式、生成结果与源清单是否一致，再核对生成文件记录的精确 npm 版本。目录文件随普通代码合并生效，无需额外部署站点。

## 收录与实测

所有普通条目显示“已收录 · 兼容性未实测”。收录说明包的信息符合目录要求，不代表任意插件组合都能正常运行。

有可公开核查的实际测试时，可额外提供：

```json
{
  "tested": {
    "pluginVersion": "1.2.3",
    "dshVersion": "0.2.2-rc.1",
    "platform": "Windows / Desktop",
    "evidence": "https://github.com/your-name/your-plugin/issues/123"
  }
}
```

测试记录须描述实际场景、结果与限制。界面始终显示测试对应的插件版本和 DSH 版本；旧版本的测试不会自动扩展为新版本已兼容。仅有构建成功、声明了支持范围或 npm 能下载，不构成实测证据。

如果插件停更、撤包、名称转让或信息有误，可提交 Issue 或更正 PR。目录修改不卸载用户已安装的插件、不替用户切换版本。遇到安装或运行失败，Spaces 如实报告，不自动换包、重试或修复。

## For plugin authors

Publish your own DSH bundle on npm, add its package name, category, bilingual title and summary to `catalog/plugins.json`, then run `pnpm run catalog:build` and `pnpm run catalog:verify`. Submit both the source list and generated `catalog/index.json` in a pull request. Your repository and npm publishing permissions remain yours.

The generator reads public npm metadata without running plugin code. Listing is not a compatibility certification. Optional test evidence must identify the exact plugin version, DSH version and platform; users can also install an unlisted package by its npm name.
