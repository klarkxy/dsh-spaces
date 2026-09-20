# B5 candidate prepare：架构护栏与完整性修正

2026-09-20。未改 Git、`package.json`、build、core Supervisor、shared schema、UI。未读真实 `~/.dsh`、凭据或全局 config。未跑全局 typecheck（Supervisor 写者仍活动）。只测本叶文件。

写入：

- `src/adapters/node/workbench-package-upgrade.ts`
- `tests/workbench-package-upgrade.test.ts`
- `tasks/merge-b5-candidate-prepare.md`

`prepare(input:{version?:string;libraryId?:string}, ctx)` 仍挂在现有 `WorkbenchPackageUpgrade` 上，无新 service/store/registry。启动绑定的 `pluginArtifact`/`viewBridgeArtifact` 不会被选为新版本。交接回调仍是 `{planId,snapshotId,payload}`。任务排队仍由 Supervisor 持有。

## 四条完整性缺口

### 1. 祖先 junction / 规范路径先于任何 mkdir

`requireToolsRoot`、`workbench-prepare` 暂存、以及 `workbench-prepare/<digest>/artifacts` 不再 `mkdirSync({recursive:true})` 后再检查。对目标路径的每一个**已存在**祖先做 `lstat` + `realpath`：junction/别名/落入 Home 在创建任何子目录之前拒绝。缺失段逐级 `mkdir`（非 recursive），每级写后再验。

回归：`tools/workbench-prepare` 或 digest 祖先 junction 进 Home 时，Home 内无新文件，不停机、不改 selected pointer。

### 2. 严格库读取先于缓存查找/下载写入

`readPluginLibrary` 对损坏/未来 schema 会静默成 `[]`，随后 `downloadPlugin` 会重写库文件。prepare 在任何 cache lookup 或 download 之前复用 Primary 已导出的 `readLibraryOrThrow(home)`（`workbench-products.ts`）。损坏 JSON / `schemaVersion !== 1` 拒绝并保留原字节。未改 `plugin-ops`。

### 3. 公共 `version: "latest"`

共享 schema 允许 `workbench.prepare` 的 `version: "latest"`。prepare 将其映射为默认 latest 解析；空 version 同样 latest。`version`（含 `"latest"`）与 `libraryId` 仍互斥。其它非精确 version 仍 `invalid-input`。未改 schema。

### 4. 钉住的精确 version 必须等于实际包版本

`downloadOfficialPlugin` / 缓存 `libraryId` 携带 `{archive, expectedVersion}`。`expectedVersion` 来自下载钉住的 `name@version` 或缓存条目 `spec` 的精确 version，不改写用户 library id。候选提交前（以及 stop 之前的校验链）核对 manager-plugin 清单/包身份等于该钉。请求 0.2.0 但归档实际是 0.3.0：拒绝，保留上一候选。

同组校验是**逐组件**身份（packed plugin/view/llm 各自等于清单里对应组件 version），不再要求 plugin===view===llm===manifest.version 全局相等。

## 其它

- 未完成 marker 文案改为 “Unfinished update evidence remains.”，不再写 recover。
- 失败 prepare 不替换内存候选；不停、不安装、不改 pointer。
- 幂等队列仍归 Supervisor。

## 实测

```text
npx tsx --test --test-concurrency=1 tests/workbench-package-upgrade.test.ts
```

**32 pass / 0 fail**（约 119s）。含原 28 项，以及：损坏/未来库不下载、prepare/digest junction 不写入 Home、钉住 version 与归档不符、混组件 version 且 plugin 匹配 pin、`version:"latest"` 与 latest+libraryId 互斥。

未跑 `build:spaces`、全仓测试或 Supervisor typecheck。Primary 后续把 `workbench.prepare` 接到 Supervisor/UI。
