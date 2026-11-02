# Windows 维护测试 EPERM：根因与检查环境修正

2026-10-20，用户授权查清并修复，明确不增加重试；后续分别明确授权短时管理员级文件跟踪和一次管理员完整检查。历史失败目录与日志保留，不提交、推送或发布。

## 根因已确认

前轮将 TMP 指向仓库内 `.sandbox/tmp`，使安装 staging 落入当前 Codex 应用的并发目录读取范围。Windows 不允许在后代文件仍有打开句柄时改名整棵目录；因此一次正常的只读访问就能与 `RuntimeStore.installOnce` 的单次原子发布冲突。不能把这个错误归因为 CLI 版本、空间导航、永久 ACL 损坏或杀毒软件。

微软明确列出[目录后代有文件句柄时不能改名的规则](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information#remarks)。本机受控实验与系统事件形成了直接证据：

| 相对时间 | 事件 |
| --- | --- |
| -0.1158 ms | `ChatGPT.exe`（当前 Codex 应用，PID 4476）打开 staging 下的 `bulk/`。 |
| -0.0724 ms | Node PID 61772 发起整目录 Rename。 |
| -0.0003 ms | 同一应用打开 `bulk/b15/f895.dat`，ShareAccess 为 7（包含 delete sharing）。 |
| 0 ms | RenamePath 指向 `versions/1.2.3`。 |
| +0.1894 ms | 同一 Rename IRP 的 OperationEnd 返回 **3221225506 / 0xC0000022 / STATUS_ACCESS_DENIED**，被 Node/libuv 映射为 `EPERM`。 |
| +0.2222 ms | 应用才开始 Cleanup 这个子文件句柄。 |

这是 `sample-14-98LCot` 的精确 IRP/FileObject 关联；数十微秒后占用就会消失，解释了事后目录与句柄查询均正常。该次 WPR 捕获共 4 次失败、12 次成功，采集已正常停止。没有关闭应用、索引或安全软件，也没有改变系统设置。

## 对照实验

- 在新目录的单次发布采样中复现 `EPERM`，失败时 source 存在、destination 不存在。
- 提前创建 `versions/` 的对照仍失败：32 个原顺序样本 9 次失败，32 个提前准备样本 4 次失败。此假设被排除，没有通过顺序挪动、等待或增加工作量掩盖窗口。
- 自持有后代文件/目录句柄的 6 个独立实验全部在单次 rename 时报 `EPERM`；句柄已允许 read/write/delete 共享，证明 delete sharing 不解除整目录改名约束。
- 同一普通用户权限（administrator=false），在仓库外系统临时目录的 **32 个独立样本全部通过**，没有重试失败目录。只改变位置，安装与发布实现相同。

证据根目录 `.sandbox/runtime-eperm-20261020/`：`rename-linked-events.json`、`test-directory-events.ndjson`、`trace-sample-results.json`、`held-child-results.json`、`parent-experiment-results.json`、`outside-control-results.json` 和 `outside-control-environment.json`。原始 `file-io.etl` 仅供本地核对，包含系统范围的跟踪，不应提交或上传。

## 修正

新增 `npm run check:all`：运行规定清单、三组类型、构建、八组测试，以及包预检和 workbench 浏览器测试。复用现有 npm CLI 定位函数，无新增依赖。

- 每轮新建独立 TMP/TEMP/TMPDIR 与非真实 DSH Home，保持调用者环境不变。
- Windows 在启动子进程前验证临时父目录必须位于仓库外，并解析真实路径，拒绝指向仓库内的目录别名。不会静默换目录或在失败后再试一次。
- `--temp-root` 可显式选择已有、获准写入的外部目录；`--output` 指定新的证据目录。每个检查命令只执行一次，失败日志保留；准备/构建失败会停止后续依赖检查，测试组之间保留各自结果，任一失败使整轮失败。
- 三项回归验证仓库内临时目录拒绝、目录别名拒绝、新环境隔离和 SDK 环境透传，均通过。接入 `npm test`，使用说明与仓库指导同步更新。

构建生成组件清单时，也将 esbuild 的临时模块输出改为 `write: false`，由创建临时目录的 Node 进程写入，再按原顺序检查语法、导入和生成清单。这与既有客户端构建采用同一种内存输出方式，避免长驻原生构建服务直接写入新临时目录被当前执行沙箱拒绝；没有失败后换实现或重试。其余测试夹具仍使用原来的构建调用，完整验证在已获授权的沙箱外进程执行。

`RuntimeStore` 源码 SHA-256 前后均为 `442980C9D514EAF45F44B696D287EDAB242C0700D622A516E759864E3BE5DBAF`。发布仍是原来的单次异步 rename；原有“首个错误直接失败、不重试、不发布结果”回归保留。诊断用 FFI 仅在忽略的 `.sandbox` 脚本里，没有进入产品或检查入口。

真实运行时若遇到外部占用，仍报告实际失败；本次修正的是测试临时目录与外部读取者的冲突，不提供恢复能力。

## 完整检查

前两轮新入口均在构建阶段失败并停止：构建子进程写仓库外临时文件被拒绝（`checks/`、`checks-final/`），未把未执行的测试写成通过。源码清单与类型检查已通过。这一权限限制与上面的目录 rename 冲突分别留证。

随后普通权限完整轮 `checks-verified/` 的构建通过，八组测试中六组通过；workbench 与维护组分别有 7 项、5 项夹具编译失败，额外包预检同样不能写仓库外临时模块，均为原生构建子进程的 `Access is denied`，不是运行时目录 rename。其余检查没有被记作整轮通过，独立浏览器 11/11。该轮退出码为 1，全部日志保留。

用户另行授权后，以管理员令牌启动一次全新完整轮 `checks-admin/`，使用系统临时父目录，覆盖最终检查入口及三项回归。

最终完整轮于 **2026-10-20 03:22:04 UTC** 结束，`admin-check-status.json` 确认 administrator=true、exit=0；`checks-admin/result.json` 的 **15 个检查全部 code=0**。环境为 Windows、Node 26.10.0、官方 DSH 0.2.1-rc.2 SDK，独立临时目录为 `C:\Users\27837\AppData\Local\Temp\dsh-spaces-check-1qtQVY`。

| 检查 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| `npm test` | 264 | 0 | 0 |
| `test:spaces` | 149 | 0 | 0 |
| `test:workbench` | 516 | 0 | 0 |
| `test:workbench:recovery` | 31 | 0 | 0 |
| `test:llm` | 99 | 0 | 0 |
| `test:blueprints`（两段合计） | 330 | 0 | 0 |
| `test:browser` | 11 | 0 | 0 |
| `test:dashboard`（两段合计） | 201 | 0 | 0 |
| **规定八组合计** | **1,601** | **0** | **0** |
| 额外 `test:workbench:browser` | 11 | 0 | 0 |

清单、三组类型、构建和额外包预检均通过；三项新入口回归包含于 `npm test`。本轮管理员权限使先前七项条件跳过用例也实际执行。`final-check-counts.json` 根据各组日志汇总，没有把两段测试只计最后一段。

本轮证明完整检查在授权的沙箱外管理员环境通过；普通权限的运行时位置对照为前述 32/32。不能据此宣称受限沙箱已获得仓库外原生子进程写入权限。没有重试失败 rename、降低测试断言、关闭读取者或修改系统配置；先前失败轮仍保持 failed。WPR 独立状态查询确认未在记录。没有访问真实 DSH Home、提交、推送或发布。本轮没有重新执行 UI 生命周期，完整根目录软链接 UI 实测沿用[导航修复后的新 Home 验收](local-link-debug-20261020.md#追加两处导航修复与软链接复验)。

结束后独立只读查询本轮临时目录关联的 Node 进程，结果为空（`post-check-processes.json`，available=true）。默认受限查询曾被 CIM 拒绝，未将该次查询的空结果作为证据；最终记录来自获准的只读查询。
