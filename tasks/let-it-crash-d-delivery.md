# D-phase delivery: let it crash as the exception-free project contract

Date: 2026-09-15  
Baseline: `main@c89dc05b364ca2ee4bb803a321c403e8a04cd9c0`  
Scheme: `dsh-spaces-let-it-crash-plan.md` (worktree; used as the D-phase source plan)

## Completion split

| Track | Status |
|---|---|
| **D 文档完成** | Yes, this delivery. Effective docs/plans/tasks/acceptance no longer require restore. History kept. Runtime gap listed. |
| **R 代码完成** | **No.** R1–R6 pending. Do not claim 运行时已符合 let it crash. |
| Tests run this delivery | Document grep/read only. Did **not** run `test:workbench:recovery` as a new-policy pass. Did **not** run E01–E18. |
| Platforms | N/A for D (no runtime claims). |
| Git | Local working-tree edits only. **Not committed. Not pushed.** Remote docs are unchanged. |

Unique current-policy contract: [`docs/let-it-crash.md`](../docs/let-it-crash.md). Activity ledger: [`todo.md`](todo.md). Developer entry: [`../AGENTS.md`](../AGENTS.md), [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

## Git state (this delivery)

Recorded at D0 and re-checked at D3:

- HEAD at D0: `c89dc05b364ca2ee4bb803a321c403e8a04cd9c0` (descendant check: HEAD **is** that commit).
- D0 dirty files besides this work: untracked `dsh-spaces-let-it-crash-plan.md` only (scheme).
- This delivery adds/edits Markdown (and two narration JSON files). It does **not** delete or rewire production restore execution under `src/`, `packages/*/src/`, `tests/`, or `scripts/`.
- New files `AGENTS.md`, `docs/let-it-crash.md`, `tasks/let-it-crash-d-delivery.md`, and `dsh-spaces-let-it-crash-plan.md` are **staged** so `git ls-files` lists them. **Not committed. Not pushed.** Remote docs are unchanged.

See `{SCRATCH}/git-baseline.txt`, `{SCRATCH}/diff-stat.txt`, `{SCRATCH}/controlled-docs.txt`.

## Per-file change list

Classification from D0 `git ls-files -- '*.md' '*.mdx' '*.rst' '*.txt'` plus extra tracked narration JSON. Appendix A of the scheme was a starting list; this list is the live checkout.

### New (有效契约)

| Path | Change |
|---|---|
| `docs/let-it-crash.md` | Unique contract: OBJECTIVE body, two interpretations, error shape, boundaries, D vs R. |
| `AGENTS.md` | One-page developer entry citing the principle. |
| `tasks/let-it-crash-d-delivery.md` | This record. |

### Effective rewrite

| Path | Change |
|---|---|
| `README.md` | Bilingual: isolation, lifecycle, error reporting. Drop recovery-core / recoverable-snapshot marketing. Gap note for runtime + `--snapshot-worker`. |
| `CONTRIBUTING.md` | Cite principle; no catch/default/retry/compensate masking; keep safety. |
| `docs/workbench.md` | Drop rescue/restore as capability; keep error examples + log viewing; keep launch flags with 目标政策 / 已知实现差距. |
| `docs/plugin-standard-install.md` | Init failure ends; next open does not auto-complete. |
| `packages/core/README.md` | Isolation/lifecycle, not recovery core. |
| `packages/plugin/README.md` | Fail visible; no restore entry; init does not auto-resume. |
| `packages/doctor/README.md` | Diagnose-only **target**; `unlock`/`recover`/`rollback` revoked; current binaries are R5 gap. |
| `packages/supervisor/README.md` | Normal ops, not resurrection; keep start flags. |
| `packages/view-bridge/README.md` | Handshake failure display; origin safety. |
| `tasks/plugin-management/plan.md` | Task table: 01 evidence only; 02 stay; 03 project-wide errors; 03–06 已撤销; 07 export not disaster recovery; 08 split states; 09 incompatible-combo failure; 10 fail-stop; 11 template fail reports. |
| `tasks/workbench-contract.md` | Drop restore commands/states; keep security, idempotency, preview; job states `queued→running→succeeded/failed/cancelled`. |

### Mixed (current section rewritten; history kept)

| Path | Change |
|---|---|
| `REQUIREMENTS.md` | Highest-priority principle; FR2 crash display without auto-restart; NFR1/NFR2 keep atomic write / refuse-don't-fix; A11; revoke 2026-09-08 snapshot-restore decision as current FR. 2026-08-28 measurements kept. |
| `IMPLEMENTATION_PLAN.md` | Current scope + phase 3 → error propagation; early timeline kept. |
| `TODO.md` | Points at `tasks/todo.md`; historical phases kept. |
| `tasks/plan.md` | Current entry = plugin-management + let it crash + R pending; 2026-09-08 restore plan stamped history. |
| `tasks/todo.md` | Unique ledger: D vs R; 03–06 已撤销; R1–R6 pending; history sections stamped. |
| `tasks/workbench-implementation.md` | Current contract at top; unfinished kill/restore remaining items 已撤销. |
| `tasks/workbench-jobs-worker.md` | Current job states; recovery FSM is R2 gap. |
| `tasks/pluginization-plan.md` | Delivery scope: Phase 2 is lifecycle/plugin/runtime **without** snapshot restore; snapshot restore **已撤销**, not deferred. |
| `tasks/pluginization-core.md` | Shared isolation stays; restore service not current. |
| `tasks/pluginization-runtime.md` | Normal install stays; fail-fallback revoked. |
| `tasks/pluginization-doctor.md` | Diagnose-only; recover/unlock/rollback 已撤销. |
| `tasks/pluginization-lock.md` | Mutex stays; unlock workflow revoked. |
| `tasks/pluginization-host.md` | Error propagation; recovery-only mode revoked. |
| `tasks/pluginization-frontend.md` | Error cards; no restore UI as current. |
| `tasks/pluginization-desktop.md` | Snapshot restore UI remaining 已撤销. |
| `tasks/pluginization-bundle.md` | Restore module not required. |
| `tasks/pluginization-localization.md` | Error facts, no repair advice (header). |
| `tasks/pluginization-distribution.md` | Drop restore-distribution as current (header). |
| `tasks/pluginization-windows-distribution.md` | Doctor diagnose; restore not required (header). |
| `tasks/plugin-standard-install.md` | Rescue entry and retry-as-product 已撤销; init fail ends. |
| `tasks/plugin-distribution-worker.md` | Header: no restore product. |
| `tasks/plugin-community-submission.md` | 简介 no longer advertises 独立恢复入口. |
| `tasks/handoff-2026-09-14.md` | Principle wins; whole-Home rollback remaining 已撤销; version-whitelist item kept. |
| `tasks/history-recovery.md` | Kept source/branch/recovery-of-**code** facts; 「当前有效需求」→ 当时需求. **Not deleted.** |
| `tasks/plugin-management/task-01-write-scope.md` | Measurement kept; not a restore-module prerequisite. |
| Other `tasks/workbench-*-worker.md` listed in D0 inventory as mixed | Current-policy header + history notice; specific remaining restore todos 已撤销 where they were still open (crash pass condition, documentation kill-recovery, doctor recover conclusion, maintenance-product restore success, self-update rollback). |

### Historical reports (notice; facts kept)

`tasks/acceptance.md`, `fix-acceptance-2026-09-11.md`, `review-2026-09-11.md`, `review-config.md`, `workbench-restore-receipt.md`, `workbench-audit.md`, `workbench-crash-worker.md` (pass condition redirected), `workbench-maintenance-faults-worker.md`, `workbench-maintenance-responsiveness-worker.md`, `workbench-foundation-worker.md`, `workbench-dual-control-worker.md`, `workbench-external-discovery.md` (restore takeover not a discovery fix), `workbench-rc2-worker.md`, `workbench-xp-compatibility-worker.md`, `workbench-demo-video-worker.md`, `plugin-cli-rc2-worker.md`, `pluginization-acceptance.md` (Phase 2 快照恢复 **已撤销**; doctor recover/rollback **已撤销**), `pluginization-trial-acceptance.md` (recover/rollback/snapshot restore **已撤销**, not later-phase), `pluginization-theme-compatibility.md`, `pluginization-themes-worker.md`, `pluginization-themes-acceptance.md`, `releases/v0.2.0.md` (**body rewritten**: current/future copy must not sell restore; 0.2.0 restore features listed as superseded facts), `spaces-demo-video-acceptance.md`, `spaces-demo-video-worker.md`.

### Original evidence (not rewritten)

| Path | Why |
|---|---|
| `web-dump-config.txt` | 2026-08-28 dump-config measurement. |
| `LICENSE` | Copyright. |
| `tasks/artifacts/**` | Screenshots; no pixel rewrite. |

### Extra tracked non-md

| Path | Change |
|---|---|
| `tasks/workbench-demo-narration.json` | Slide 04 no longer sells snapshot restore / rescue entry. |
| `tasks/spaces-demo-narration.json` | No restore marketing (isolation 「验证隔离」 kept). |
| `.github/workflows/*.yml` | **Inventory only.** CI still runs `test:workbench:recovery` (mixed suite). R/Q must not delete it wholesale. |

### Untracked scheme

`dsh-spaces-let-it-crash-plan.md` — D-phase source plan. Not a claim that D or R was already done when written.

## Restore-task revocation list

Marked **已撤销** (2026-09-15), not deferred, not checked 已完成:

- Plugin-management original **03** install restore-point
- Original **04** auto fail-restore / auto rollback
- Original **05** restart / Doctor restore
- Original **06** undo / restore-result entry
- Whole-Home snapshot restore as an exception to let it crash
- Whole-Home rollback final matrix (was still open on `tasks/todo.md` / handoff)
- Batch 失败项重试 / 剩余项继续 / 中断续接
- Workbench rescue page / 检查并恢复 / 恢复中断任务 / 配置恢复 as product
- Job `recovery-required` / `settleRecovery` / `recovery.resume` as product contract (R2 still must delete code)
- Doctor `unlock` / `recover` / `rollback` as product (R5 still must make them fail unsupported)
- Kill-fault recovery success as a pass condition
- Coordinated-upgrade **post-commit** automatic fallback
- Self-update / manager-package **rollback** as a pass condition
- Permanent “must restore before spaces can start” gate

## Still-valid tasks

From [`todo.md`](todo.md):

- Plugin **02** state / exact version / multi-version cache (unknown stays unknown; download failure errors)
- Plugin **03** project-wide error display (no repair advice / restore entry)
- Plugin **07** space export (not disaster recovery)
- Plugin **08** import with split 空间定义 / 插件安装 / 空间启动
- Plugin **09** desktop round-trip plus legal-but-incompatible failure display
- Plugin **10** batch fail-stop
- Plugin **11** new-space templates (run failure errors; no auto swap)
- Cancel permanent exact-version whitelist (handoff)
- npm publish / community listing
- External unregistered DSH discovery (view-only; no restore takeover)
- Catppuccin missing-deps failure recorded honestly
- Final regression and new intro video (must not advertise restore)
- Isolation / A8 / lifecycle / single-writer / atomic write (standing)
- **R1–R6 and Q** pending (runtime)

## Unmigrated runtime entry points (R inventory; presence expected)

Do **not** treat this list as deleted.

Public / shared:

- `src/shared/workbench.ts`: `JobStatus` includes `recovery-required`; `recoveryRequired`; `{ kind: 'recovery.resume' }`; `{ kind: 'snapshot.restore' }`; `{ kind: 'config.restore' }`
- `src/shared/restore-selected.ts`: **not** product restore (renderer selection after remount)
- `src/shared/spaces-control.ts`, `src/shared/types.ts`, `src/shared/desktop-controller.ts`

Error reporting (R1):

- `src/main/diagnostics.ts`, `src/shared/diagnostics.ts`
- Node / HTTP / IPC / Remote / UI adapters that swallow or flatten errors

Jobs (R2):

- `src/adapters/node/workbench-jobs.ts` (`settleRecovery`, recovery hold)
- `tests/workbench-jobs.test.ts`

Supervisor (R3):

- `src/adapters/node/workbench-supervisor.ts`, `workbench-http.ts` (embedded HTML: 救援入口 / 检查并恢复)
- `src/adapters/node/home-controller.ts`, `src/main/process-manager.ts`
- `packages/supervisor/src/**`, `packages/plugin/src/host/supervisor-bootstrap.ts`

Restore business chain (R4):

- `src/adapters/node/workbench-maintenance.ts`
- `src/main/coordinated-upgrade.ts`, `snapshot-store.ts`, `snapshot-executor.ts`, `snapshot-worker.ts`
- `src/main/restore-session.ts`, `src/core/application/restore-session.ts`, `src/core/ports/restore.ts`
- `src/main/plugin-restore-point.ts`, `src/main/runtime-store.ts`
- Keep `snapshot-worker` non-restore execution (runtime install) until extracted

Doctor (R5):

- `packages/doctor/src/index.ts` commands `unlock` / `recover` / `rollback`
- `packages/doctor/src/recover.ts`, `inspect.ts`, `resources.ts`, `common.ts`
- `tests/spaces-doctor.test.ts`, `tests/workbench-doctor.test.ts`

UI / API / CLI / build (R6):

- `packages/plugin/src/workbench/**` (`recovery.resume` i18n)
- `packages/plugin/src/client/i18n.ts` (需要恢复)
- `src/renderer/**`, `src/preload/**`
- `scripts/build-spaces.mjs`, `package.json` `test:workbench:recovery` (mixed: doctor + cooperative-children + responsiveness + XP — do not delete wholesale)
- `.github/workflows/ci.yml` still runs that script
- `scripts/verify-workbench-crash.mjs` still asserts restore success

Full symbol dump: `{SCRATCH}/runtime-restore-entries.txt`.

## Working tutorials vs flags

`--snapshot-worker`, `--snapshot-root`, `--control-tool-root` remain in [`docs/workbench.md`](../docs/workbench.md) and [`packages/supervisor/README.md`](../packages/supervisor/README.md), labeled **目标政策 / 已知实现差距**. They were **not** dropped; current supervisor still needs them for runtime install / long IO.

## Verification this delivery actually ran

1. `git rev-parse HEAD` / `git status --short` → `{SCRATCH}/git-baseline.txt`
2. `git ls-files -- '*.md' '*.mdx' '*.rst' '*.txt'` → `{SCRATCH}/controlled-docs.txt`
3. D0 classification → `{SCRATCH}/d0-inventory.md`
4. Recovery-language scan over markdown/text → `{SCRATCH}/recovery-grep.md` (classified)
5. Runtime restore-symbol scan → `{SCRATCH}/runtime-restore-entries.txt` (presence expected)
6. Re-read effective files named in criterion 2
7. `git diff --stat` → `{SCRATCH}/diff-stat.txt`
8. Confirm no production TS/JS restore-chain deletion in this diff

Not run: `npm test`, `test:workbench:recovery`, E01–E18, push.

## Honest limits

- Historical bodies still contain the words 恢复/rollback as **facts of what was built**. That is required. They are gated by the 2026-09-15 notice and are not current construction gates.
- Token 恢复 in `tasks/history-recovery.md` is Git/code recovery from an old machine. Facts kept.
- `restoreSelected` is view-selection, not Home restore.
- Runtime UI still shows 救援入口 until R6. Docs tell operators not to treat it as current capability.
- This delivery does not modify remote GitHub docs.
