# DSH 蓝图码协议

本文定义当前实现的蓝图数据、文本编码和导入语义。协议标识为 **DSHBP2**，
JSON 的 `formatVersion` 为 **2**。这是插件组合分享协议，不是环境备份或设置迁移协议。

参考实现：`blueprint.mjs`（数据校验）、`codec.mjs`（文本编解码）、
`core.mjs`（协议操作与只读导出）。三个层次分别负责结构、编码和操作，
解码成功不等于数据符合蓝图结构，更不等于可以直接执行。

## 1. 数据结构

```json
{
  "kind": "dsh-blueprint",
  "formatVersion": 2,
  "metadata": {
    "name": "示例组合",
    "description": "以下包名仅用于展示协议结构"
  },
  "packages": [
    { "name": "example-a", "version": "1.2.3", "source": "npm" },
    { "name": "example-b", "version": "2.0.0", "source": "npm" }
  ],
  "bundles": ["example-a", "example-b"]
}
```

示例包名不表示真实可安装包。可直接用于编解码验证的空组合及对应蓝图码见
[`examples/empty.dsh-blueprint.json`](examples/empty.dsh-blueprint.json)、
[`examples/empty.code.txt`](examples/empty.code.txt)。空组合导入不会停用或删除任何现有插件。

| 字段 | 必需 | 规则 |
| --- | --- | --- |
| `kind` | 是 | 固定字符串 `dsh-blueprint` |
| `formatVersion` | 是 | 固定整数 `2` |
| `metadata` | 是 | 只允许 `name`、`description` |
| `metadata.name` | 是 | 1–120 个 UTF-16 代码单元，不含 U+0000–U+001F |
| `metadata.description` | 否 | 存在时为 1–4000 个 UTF-16 代码单元，不含 U+0000–U+001F |
| `packages` | 是 | 最多 128 项；按顶层安装请求的建议顺序排列 |
| `packages[].name` | 是 | 包名字符串，最多 214 个代码单元；包名不能重复，不能引用 `@klarkxy/dsh-blueprint` 本身 |
| `packages[].version` | 是 | 精确 SemVer，包括可选预发布／构建标识；不接受 `latest`、范围或未固定版本 |
| `packages[].source` | 是 | `npm` 或 `builtin` |
| `bundles` | 是 | 最多 128 个互不重复的包名；必须全部存在于 `packages`，表达请求启用的组合层及建议先后 |

包名语法为 `^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$`。
当前协议只允许以上字段；每个 package 对象只允许 `name`、`version`、`source`。
不包含设置、凭据、组件行状态、执行脚本、其他蓝图的嵌套引用或自动更新链接。

`packages` 和 `bundles` 分别表达安装与启用意图。某项在 `packages` 中但不在
`bundles` 中，表示只请求它存在，**不表示接收方应停用它**。
`npm` 包缺失时由官方管理器安装精确版本；`builtin` 必须由接收方宿主提供。
顶层安装请求顺序不替代包管理器的依赖解析，也不定义异步插件启动顺序。

## 2. 执行策略与迁移

DSHBP2 是可移植数据格式，不是执行脚本或完整合并计划。精确版本记录分享方的身份，顺序是归并参考；不从包名或排列猜测依赖关系。

当前执行入口为 Creator：用户提供码和导入意图，Agent 读取当前 profile，自主选择经过核实的版本和最终顺序，复用原生 `plugin_manager` 安装／启用，再以 `blueprint_apply_order` 提交当前已选列表的完整排列。原蓝图保持不变；偏离记录版本时报告差异。未列出的本地 bundle 默认保留，安装-only 项不授权停用本地插件。

顺序入口不安装、不添加、不停用 bundle；拒绝过期 stamp、重复／遗漏／未知名称，以及受保护位置与分段变化。安装、脚本与兼容性风险授权继续走原生权限体系，Agent 自主决策不代替安全审批。不要求用户例行审阅合并排序计划。

旧实现采用固定追加策略 `L + B 中尚未存在于 L 的项`，并提供页面 `preview` / `apply` / `result`。这些执行端点现已退役，不将旧端点静默改成重排；已有 v2 文档、字段和蓝图码仍可解析。没有新增格式版本，因为数据含义与编码未改变，而执行策略与入口已显式迁移。

归并结果仍是一份平面 profile，不是持续同步的子蓝图。保存配置与运行时生效分别报告：live profile 使用官方重新协调路径，startup profile 需要重启。多步骤导入不是全局事务，失败可能保留已完成更改；不整体回滚、自动重试或重放丢失的响应。顺序 stamp 不是全部 patch 文件的内容版本号。

严格封装组件及默认配置关系时使用原生组合插件；顺序成功不证明插件语义兼容，后层可能影响默认值，profile/home/launch overlays 仍按原生优先级参与。

## 3. 文本编码

导入只接受以下一种大小写敏感的蓝图码。JSON 只用于内部数据结构和开发调试，不作为界面的导入或导出格式：

```text
DSHBP2:<payload>
```

- 固定流程：JSON 的 UTF-8 字节 → **raw DEFLATE** → 无填充 Base64url。
  raw DEFLATE 没有 zlib／gzip 头尾，不得使用 gzip 或普通 zlib 包装流替代。
- Base64url 字符集为 `A–Z a–z 0–9 - _`；不允许 `=` 填充或空载荷，且重新编码必须逐字一致。
- 解码前只裁去文本首尾的空格、Tab、CR、LF；不移除码内空白，不接受 Markdown 围栏。
- UTF-8 必须有效，不接受 BOM。JSON 字段顺序和普通 JSON 空白不具有语义。
- 参考编码器使用紧凑 JSON，始终压缩后编码，不提供编码模式参数。
  不要求不同压缩库生成完全相同的压缩字节，只要求能正确解码。

蓝图码不提供加密、签名或作者认证。导入方仍须检查包身份和将执行的动作。

## 4. 限制与拒绝规则

- 输入文本最大 **2 MiB（UTF-8 字节数）**；解码／解压后的 JSON 最大 **1 MiB**。
- JSON 最多 **64 层容器嵌套**；压缩数据只能包含一个完整 raw DEFLATE 流，禁止尾随字节。
- 拒绝重复 JSON 成员（含转义后同名）、非法 Unicode、非有限数和不安全整数。
- 任意对象层级禁止键 `__proto__`、`prototype`、`constructor`。
- 不支持的前缀、编码、协议版本、文档类型、字段、包来源或不明确版本均拒绝；不做格式猜测或迁移。
- 宿主传输层可以另有请求体限制，协议上限不保证所有宿主接受同样大小的 RPC 请求。

## 5. 使用参考实现生成与验证

```js
import { validate } from '@klarkxy/dsh-blueprint/core';
import { encode, decode } from '@klarkxy/dsh-blueprint/codec';

const document = validate({
  kind: 'dsh-blueprint',
  formatVersion: 2,
  metadata: { name: '空组合' },
  packages: [],
  bundles: [],
});
const code = encode(document);             // 生成唯一格式的蓝图码
const checked = validate(decode(code));   // 解码之后仍须校验文档
```

`encode`／`decode` 负责 JSON 和编码安全边界，`validate` 负责蓝图结构。
制作工具应在编码前、解码后调用 `validate`。随后还需要核实当前宿主的包身份、权限与实际生效结果；
不要把生成蓝图码当作执行授权。

## English summary

DSHBP2 transports a plugin-only JSON document with exact package identities.
`packages` gives top-level installation request order; `bundles` gives requested
activations in preferred order. Creator resolves versions and ordering under the
user's import intent, using native management and a guarded permutation-only order
tool. Version deviations are verified and reported; absence never disables a local bundle.
The former additive page execution endpoints are retired; v2 artifacts remain readable.
There are no hard ordering constraints, settings transfers or nested blueprint links.

`DSHBP2:` is the only code format and carries unpadded canonical Base64url of
raw-DEFLATE-compressed UTF-8 JSON. Raw JSON is not accepted for import. The caps are
2 MiB input, 1 MiB decoded JSON, and 64 JSON container levels. No signatures or
encryption are implied. Use `validate(decode(text))` before planning native operations and
`encode(validate(document))` when authoring. The shipped empty-document vectors
are safe no-op examples; compressed byte-for-byte equality is not required.
