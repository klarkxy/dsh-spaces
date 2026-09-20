# B1–B4 integrated runtime review — REVISE

Reviewed 2026-09-20 against `tasks/merge-contract-v2.md` and `docs/plans/spaces-merge-convergence.md`. Baseline: HEAD `07208e2` plus the working tree captured in `.sandbox/runtime-review/baseline`; cumulative diff against `d8a692d` saved as `.sandbox/runtime-review/diff.txt`. This is a milestone checkpoint, not final product or live acceptance.

## Verified defects

### P1 — Direct LLM/credential admission ignores a failed owned-process stop

Frozen source: `src/adapters/node/workbench-supervisor.ts:541–546`; callers at `:519–537`; failed-stop transition at `:1489–1497`; ordinary submission rejection at `:683–689`.

A failed `service.shutdown` sets `maintenanceBlocked = true`, clears `sealing`, and retains Home ownership. Ordinary `submit()` then refuses new jobs, but `assertLlmMutationAllowed()` only checks owner, sealing and job-store existence. Both dedicated direct-write channels call this incomplete gate. Consequently a user can still change model configuration while the service deliberately refuses other management changes after failing to stop an owned process.

Verified using a real isolated fixture child whose injected stop function leaves it alive: shutdown job fails; a subsequent ordinary submit rejects; `runtime.llm({ method: 'setDefault', model: null, expectedRevision: 0 })` succeeds, causing the expected-rejection assertion to fail. Credential requests use the same admission function; that implication is traced in source, not separately exercised with a credential store. An additional test for an existing Home operation lock passed, so this finding is specifically the failed-stop flag rather than a claim that every lock can be bypassed.

Scoped fix: centralize the relevant failed-stop/sealing admission check and use it at execution time for direct LLM writes, credential writes and queued work. Preserve dedicated secret transport and do not persist secret payloads. Add the failed-stop cross-channel regression case.

### P2 — Identical applyPlan request cannot read its accepted job after state changes

Frozen source: `src/core/application/global-llm-host.ts:233–242`; `src/adapters/node/workbench-supervisor.ts:514–517` and `:1716–1722`; JobStore deduplication in `src/adapters/node/workbench-jobs.ts:288–297`.

`applyPlan()` checks current observations before reaching `submitApply()` and the request-ID/command deduplication boundary. A successful apply changes the applied catalog revision and often the generation itself. Repeating the same request ID and same command therefore throws `LLM_APPLY_FAILED` before returning the original job. Changing the catalog likewise causes an early revision conflict. This contradicts the accepted contract that an already accepted identical request reads the existing job despite later state changes.

Verified with an isolated stopped `alpha` profile: first apply with catalog revision 0 and observed applied revision null succeeds; submitting the exact same request throws `observed space state no longer matches` at `global-llm-host.ts:479`. The first job remains succeeded and is not replayed; the defect is the lost idempotent result path.

Scoped fix: deduplicate/validate command identity before live observation validation; retain the existing `executeApply()` observation recheck for genuinely new jobs at execution time. Ensure same-ID/different-command requests still conflict.

### P2 — Shared Host transport erases all structured LLM errors

Frozen source: `packages/plugin/src/host/workbench-http.ts:240–255`, especially `:245` and `:251–252`; callers `createWorkbenchHttpClient().llm/llmCredential` at `:115–117` and `WorkbenchManagerHost.guard` in `packages/plugin/src/host/workbench-manager.ts`.

`remoteFromSupervisorError()` only enters the mapping block for `workbench/` codes. The `LLM_PUBLIC_ERROR` branch inside it is consequently unreachable for `LLM_REVISION_CONFLICT`, `LLM_CREDENTIAL_MISSING`, `LLM_RESULT_UNKNOWN`, etc. Both browser and the migrated desktop receive `workbench/unavailable` instead of the actual conflict, credential or unconfirmed-operation result. The branch predates this migration, but retiring the direct desktop path makes this shared transport the required two-client contract and leaves the accepted structured-error requirement unmet.

Verified by feeding an HTTP envelope containing `LLM_REVISION_CONFLICT` through the real `workbenchPost()`; the emitted error was `workbench/unavailable` with `The workbench service could not complete this request.`

Scoped fix: independently allowlist the workbench and LLM namespaces and preserve only approved public details. Add transport-level assertions for conflict, missing credential and unknown-result errors.

## Verification and evidence

All tests imported the frozen snapshot, not the concurrently edited source tree. Tests use their existing temporary Home and fixture processes; no real Home or credentials were accessed. No source changes, staging, commits or release operations were performed.

- Existing jobs/protocol/forwarding/LLM-auth group: **62 passed**, process exit **0**, `.sandbox/runtime-review/bounded-tests.log`.
- Existing endpoint/desktop-client/Supervisor/products/recipe group: **95 passed, 2 failed**, process exit **1**, `.sandbox/runtime-review/lifecycle-tests.log`. Failures: `default entry origin survives clean cold restart while explicit port zero stays ephemeral` (timed stop did not force-kill), and `shutdown persists the job then releases rights without deadlocking on whenIdle` (timed out waiting for persisted shutdown success). These are unresolved acceptance failures, not independently diagnosed additional defects. Fixture timings are short; do not infer a product root cause or dismiss them as flaky without evidence.
- Added review-only reproductions: **3 failed as expected, 1 passed**, process exit **1**, `.sandbox/runtime-review/repros.log`. The failures substantiate the three findings above. The extra passing case checks an existing operation lock.

Commands (from the integration worktree):

```powershell
node --import tsx --test --test-concurrency=1 .sandbox/runtime-review/baseline/tests/workbench-jobs.test.ts .sandbox/runtime-review/baseline/tests/workbench-protocol.test.ts .sandbox/runtime-review/baseline/tests/workbench-forwarding-v2.test.ts .sandbox/runtime-review/baseline/tests/llm-api-auth.test.ts
node --import tsx --test --test-concurrency=1 .sandbox/runtime-review/baseline/tests/workbench-endpoint-v2.test.ts .sandbox/runtime-review/baseline/tests/desktop-service-client.test.ts .sandbox/runtime-review/baseline/tests/workbench-supervisor.test.ts .sandbox/runtime-review/baseline/tests/workbench-products.test.ts .sandbox/runtime-review/baseline/tests/space-recipe.test.ts
node --import tsx --test --test-concurrency=1 --test-name-pattern='REVIEW' .sandbox/runtime-review/baseline/tests/review-runtime.test.ts .sandbox/runtime-review/baseline/tests/review-forward-error.test.ts
```

The first attempt to create the repro artifact failed on Python's Windows default text encoding before creating or running a repro; it was corrected to `python -X utf8`. This setup failure is not test evidence.

## Source status and scope limits

Before/after Git status and tracked diff-path lists are saved in `status.txt`, `paths.txt`, `after-status.txt`, `after-paths.txt`; all Git commands exited 0. Hashes for 262 bounded files are in `before-hashes.json` / `after-hashes.json`. The only changed bounded source during checks was `src/adapters/node/workbench-supervisor.ts`; its new handoff integration is an expected concurrent primary-owned worker change, saved separately in `supervisor-drift.diff`. It was not reviewed or tested as the frozen baseline. No unexpected source drift was detected.

Reviewed the runtime queue, CAS/epoch and job persistence, direct model and credential admission, HTTP/Host forwarding, product recipe/import service and its callers, desktop connector/disposal and view sandbox configuration. Existing coverage supports endpoint/Home identity rejection, no second writer in the client adapter, known request deduplication, unknown record preservation, product reads without disk writes, partial import results, and secret-field rejection. It does not substitute for final native UI, packaged installation, provider operation or sustained operation.

Excluded as assigned: B5 component-handoff/selection/launcher and pending Supervisor handoff integration, final build/package acceptance, native two-client interaction, deployment, release and publication. Full visual/keyboard/focus capability acceptance and final assets remain primary-owned. Review verdict **REVISE** until the verified defects and unexplained lifecycle test failures are resolved or explained by current evidence.


## Follow-up: library ID contract — P1 verified

One additional bounded check requested by the primary. Fresh source snapshot/hashes: `.sandbox/runtime-review/library-check/baseline` and `before-hashes.json` / `after-hashes.json`; Git status/diff paths recorded in `library-before-status.txt`, `library-before-paths.txt`, `library-after-status.txt`, `library-after-paths.txt` in the parent review directory.

`src/adapters/node/plugin-ops.ts:381–383` creates npm library IDs as `packageName@version`, and `:518–528` persists that ID. `src/adapters/node/workbench-products.ts:496–505` returns `entry.id` directly. However, `src/shared/workbench-product-schemas.ts:14`, `:32`, `:71–73`, `:321`, `:356–357`, and `:380` use the generic entity-ID alphabet for library IDs. It excludes `@` and `/`, rejecting every version-pinned npm download ID, including unscoped packages. This breaks the required cache/multiversion/removal capability after successful download:

- The archive and library entry are written correctly.
- `WorkbenchJobStore.publicResult()` (`src/adapters/node/workbench-jobs.ts:671–676`) silently drops the rejected product outcome, so the job reports success without its product result.
- `product({ method: 'library' })` returns the real ID from the service, but the Host result schema rejects the entire library response and returns `workbench/unavailable` (`packages/plugin/src/host/workbench-http.ts:108`, `:180–186`). One such entry prevents loading the whole cache list.
- `plugin.library.remove` rejects that same ID before HTTP submission, returning `workbench/invalid-input` through the Host command schema.

Verified through real `WorkbenchProductService.execute()` → `downloadPlugin()` → on-disk library/archive, real JobStore publication, and `createWorkbenchHttpClient()` validation, using injected registry/tarball fixture responses with no external network. Both `dsh-outline@0.3.0` and `@dsh-spaces/plugin@0.3.0` reproduced all three public failures. The single focused test intentionally asserts these observed defects and passed, exit 0. Command:

```powershell
node --import tsx --test .sandbox/runtime-review/library-check/repro.test.ts
```

Output: `.sandbox/runtime-review/library-check/repro.log`. No earlier suite was repeated; no source files were edited.

Scoped recommendation: introduce one dedicated **library ID** validator and apply it consistently to item IDs, removal command IDs and removal outcome IDs, preserving persisted IDs. Accept the actual emitted identity forms: bare npm names (legacy installed entries), scoped/unscoped npm names with an optional exact version, and existing catalog `owner/repo` / permitted `github:owner/repo` identities where supported. Keep a finite length bound sized for package name plus version. Validate package-name/version and Git/catalog segments structurally; reject absolute/relative filesystem paths, backslashes, traversal segments, URL schemes/userinfo, whitespace, query parameters and shell syntax. Do not broadly relax `entityIdSchema` or use filesystem-escaped `libraryFileId()` as public identity, since that can collide and changes existing lookup keys. Add the real download-to-Host round trip and legacy ID cases to acceptance.

Lifecycle failure permission clarification: the earlier 97-test group used default restricted execution, **not `require_escalated`**. The existing fixture launches `taskkill` with `stdio: 'ignore'` and resolves on both exit and error without inspecting the taskkill exit code (`tests/workbench-supervisor.test.ts:379–389`). Thus the test result does **not establish that taskkill had permission or succeeded**. I did not independently verify taskkill permission. A targeted elevated rerun of the two current failures is primary-owned; this review does not classify those failures as flaky or as an additional verified product defect.

Follow-up drift: only component-handoff.ts and workbench-supervisor.ts changed during this narrow check, matching active B5 ownership; neither is part of this library-ID finding. The reviewed library modules and schemas remained unchanged. Checks ran from the frozen copy.


## Library ID fix verification — READY within this scope

Reviewed the primary's actual current `src/shared/workbench-product-schemas.ts` diff: dedicated bounded `libraryIdSchema` at lines 56–64, consistently used for library item, removal command and removal outcome. Generic entity validation remains unchanged. The earlier library-ID P1 is now resolved by current evidence.

A **fresh current-source snapshot** was captured under `.sandbox/runtime-review/library-fix/baseline`; this did not reuse the old failing baseline. One adapted round-trip fixture test passed, process exit **0**, using both `dsh-outline@0.3.0` and `@dsh-spaces/plugin@0.3.0` through real download service, on-disk archive/library, JobStore serialization and the real Host HTTP client with injected transport. Assertions now require:

- Successful download retains `result.product.item.id` both publicly and in the persisted job.
- Host `product(library)` succeeds and returns the persisted ID.
- Host removal transmits the exact ID, executes through ProductService/JobStore, retains its outcome, deletes the archive and yields an empty subsequent library read.
- Eight supported legacy/npm/catalog/GitHub ID forms pass. Seventeen path, traversal, credential-URL, query, shell, version-tag and overlength forms fail item/removal-outcome/removal-command validation and are rejected by the Host before transport. A scoped package ID remains invalid as a template entity ID.

Command: `node --import tsx --test .sandbox/runtime-review/library-fix/repro.test.ts`. Evidence: `.sandbox/runtime-review/library-fix/repro.log`. No other suite was repeated. No source edits. Existing artifact fixture bytes and injected HTTP transport do not prove real registry availability or native UI; those are outside this narrow schema fix.

Before/after Git status and diff paths are recorded in `.sandbox/runtime-review/library-fix-before-status.txt`, `library-fix-before-paths.txt`, `library-fix-after-status.txt`, `library-fix-after-paths.txt`; Git commands exited 0. Fresh hashes cover 158 files. Source drift during the check: src/core/application/global-llm-host.ts, packages/plugin/src/host/workbench-http.ts, packages/plugin/src/workbench/components.tsx, packages/plugin/src/workbench/store.ts. Only the frozen current-source copy was exercised.

This READY verdict resolves the library-ID finding only; it does not change the earlier unresolved LLM/failed-stop findings or claim final B5/native/package acceptance.
