# Final integrated source review — REVISE at captured baseline

Reviewed 2026-09-20. Scope: the accepted single-Supervisor B5 normal update path and its B1–B4 contracts, against current `tasks/merge-contract-v2.md` and `tasks/merge-b5-supervisor-integration.md`. HEAD was `07208e2` plus working-tree changes. The exact reviewed sources are frozen under `.sandbox/final-integrated-review/baseline`; fixes made after that snapshot are not silently included in this verdict.

## Verified findings, ordered by severity

### P1 — Replacement startup can receive a succeeded launcher receipt with a crashed manager

**Source:** `src/adapters/node/workbench-supervisor.ts:479–485`, `:914–920`; `packages/supervisor/src/index.ts:73–83`; `src/adapters/node/component-handoff.ts:547–553` (line numbers refer to the frozen baseline).

`takeAcceptedOwner()` awaits `initWritable()` but does not establish its readiness postcondition. `initWritable()` deliberately catches manager-start failures and resolves with a limited diagnostic entry, and has early returns for unsafe startup state. That behavior is appropriate for an ordinary diagnostic cold start, but the accepted-owner CLI then unconditionally sends `reportAccepted()`. The launcher treats this message as final startup success and writes `{ phase: 'accepted', status: 'succeeded' }`. Thus the handoff receipt can claim successful new startup while the management profile is crashed and the user cannot use the workbench.

**Reproduction:** same-group manifest and actual tar fixtures pass the new artifact preflight; an accepted Home owner is injected with its exact endpoint; only manager process spawn is injected to fail. `createWorkbenchSupervisor()` resolves, yielding:

```json
{"createResolved":true,"availability":"limited","manager":{"status":"crashed","generation":1},"reasons":["The manager process could not be started. The stable entry is still available."],"leaseHeld":true}
```

The expected-rejection check fails, process exit **1**. Evidence: `.sandbox/final-integrated-review/accepted-startup-repro.log`. This exercises real accepted-owner runtime construction and startup error handling; the downstream false IPC/receipt consequence is directly traced in the CLI and launcher source. It does not claim a separately run full launcher chain.

**Scoped fix:** on the accepted-owner path only, after initialization verify the actual manager is running with its matching initialized view and no startup/maintenance block. Throw through the existing accepted-startup failure path when this postcondition fails; preserve owner and selected pointer, close the attempted HTTP endpoint, report IPC failure and exit. Do not replace ordinary cold-start diagnostic behavior with a global fail-fast rule, or equate generic `availability` alone with manager readiness. Verify the manager-spawn failure and a healthy accepted startup after the change.

### P1 — Stalled prepare download bodies hold the sole mutation queue after timeout and cancellation

**Source:** `src/adapters/node/plugin-ops.ts:241–250`, `:314–337`; `src/adapters/node/workbench-package-upgrade.ts:619–637`, plus preparation abort checks at `:251–259` / `:1109–1110`.

The new `workbench.prepare` operation delegates to `downloadPlugin()`. Its default fetcher clears the 20-second timer when response headers arrive, before metadata `json()` or tarball `arrayBuffer()` consumption. Those body reads have no remaining timeout or streamed size bound, and the prepare job's abort signal is not forwarded. A server or connection that sends headers but stalls the body can therefore leave the cancellable prepare running forever. Later management mutations wait on the same job tail; shutdown also waits for that tail.

**Reproduction:** real `WorkbenchPackageUpgrade.prepare()` → default `downloadPlugin()` → real JobStore path, with only global fetch replaced by an in-memory metadata response and a tar body that emits one byte and stays open. No external network, registry or provider is contacted. Cancel is accepted, then a following `runExclusive()` is enqueued. After an actual **20.2 seconds** (no accelerated clock), observed:

```json
{"afterMs":20200,"networkSignalAborted":false,"prepareStatus":"running","nextMutationRan":false}
```

The expected deadline assertion fails, process exit **1**. Closing the fixture stream in cleanup is what lets the job tail finish. Evidence: `.sandbox/final-integrated-review/download-body-repro.log`.

The absence of byte limits on the metadata/tarball response is additionally verified in source (`response.json()` and `packed.arrayBuffer()`); no large allocation/OOM test was performed. The later per-tar-entry/list bounds do not bound downloading the response first.

**Scoped fix:** keep a deadline active through response consumption, propagate `ctx.signal` through the download path, and cancel the reader/request on timeout, cancellation or size-limit failure. Stream with explicit metadata/archive byte caps chosen to accommodate the actual component package; do not rely solely on Content-Length. Check abort before publishing archive/library bytes. Retain no-retry behavior and clean only the operation's temporary download artifacts. Add stalled metadata and tar body, cancellation, and oversize tests proving the next queued operation can run and no partial archive/library entry is published.

## Review coverage and positive evidence

The actual source was traced across `workbench.prepare` dispatch/schema → ProductService → fixed official package resolution/cache → staged declared-file extraction → packed plugin/view/LLM validation → upgrade preview digest/fingerprint → owned stop/snapshot/install/readback → durable job settlement → same-directory Home lock transfer → one-shot launcher → selected CLI/token/artifact preflight. Relevant desktop/bootstrap and package/manifest/build consumers were inspected.

At the captured baseline the following protections are present in source:

- Public prepare accepts only the fixed Spaces plugin and latest/exact-version input; no browser path or ownership token surface was added.
- Preparing a candidate checks existing library corruption, validates pinned version, checks Home-external ancestors before scratch writes, stages the immutable declared component group, packs/compares all declared bridge bytes and versions, and does not stop spaces or switch selection.
- Execute revalidates the candidate/digest and staged group before stop; installed candidate bytes are read back. Failure does not resume old jobs or roll back a selected component pointer.
- Supervisor handoff is finalized only for the exact pending job after in-memory and disk status both say succeeded; failed final persistence cannot trigger transfer.
- The old ownership directory remains reserved through transfer. The launcher binds Home, old owner PID/start identity, epoch, payload digest and target process over inherited IPC, waits for the old owner to die, then switches once and launches once.
- The replacement CLI validates the chosen entry and all plugin/view/LLM side archives before accepting the token, with no fallback acquire. Normal `build-spaces.mjs` builds and packages `launcher.mjs` and generates the v2 manifest from that same component group.
- Earlier library-ID fix was independently verified on its current-source snapshot. Earlier direct-LLM failed-stop and structured error/idempotent-apply corrections are present in the final baseline, with primary-owned targeted results reported separately.

No unchanged primitive launcher contention suite or broad test suite was rerun by this reviewer. The two new focused repro commands are:

```powershell
node --import tsx --test --test-name-pattern='REVIEW' .sandbox/final-integrated-review/baseline/tests/review-accepted-startup.test.ts
node --import tsx --test .sandbox/final-integrated-review/download-body-repro.test.ts
```

Both fail specifically on the findings above, not setup errors. The first uses isolated temporary Home and tar subprocesses but no manager process is spawned; the second uses isolated `.sandbox` Home and synthetic body streams. Both were run under default restricted execution, without escalation. No real Home, credentials or external communications were used. No source edits, Git mutations, configuration changes, publication or deployment occurred.

## Acceptance and source-state limits

The earlier two restricted lifecycle failures have now been rerun by the primary with elevated own-child permissions: `.sandbox/review-lifecycle-elevated-primary.log` was read and shows **2 passed, 0 failed**. These failures are no longer an unresolved product-defect claim from this review. The reviewer did not independently perform that elevated rerun.

Final broad typecheck/build, compiled normal handoff, standard installation, dual-client UI, desktop packaged startup and real maintenance acceptance remain primary-owned. Their pending or previous-checkpoint results must not be represented as final evidence for later source fixes. This report does not claim native UI, production registry, live model provider, sustained operation, deployment, release or non-Windows acceptance.

The audit-only historical `scripts/build-workbench-candidate.mjs` still writes its old candidate manifest and does not assemble the full new launcher/LLM group. It is not the normal `build-spaces.mjs` path and must not be cited as v2 distribution acceptance without updating that harness; it was not run here.

Before/after Git status and tracked diff-path lists are in `.sandbox/final-integrated-review/status-before.txt`, `paths-before.txt`, `status-after.txt`, `paths-after.txt`; the capture commands all exited **0**. SHA-256 hashes cover **324** bounded source/test/script/manifest files in `before-hashes.json` / `after-hashes.json`. During review the only drift was `src/adapters/node/workbench-supervisor.ts`, `tests/workbench-supervisor-handoff.test.ts`, and `scripts/validate-llm-distribution.mjs`: the first two correspond to the primary's newly authorized readiness fix; the last is a primary-side acceptance-script edit observed during checks. No drift was incorporated into the frozen repros. All findings refer to that captured baseline, with follow-up current-source verification required before their closure.

**Verdict: REVISE** until the two verified B5 failures are fixed and narrowly reverified. This is a source-gate verdict for local integration, not a publication or final live-acceptance verdict.


## Focused closure of both P1 findings — READY on the captured current source

Both P1 findings above are closed by independent focused verification of a **new current-source snapshot** in `.sandbox/final-integrated-review/closure/baseline`. The old failing source copies were not used as fix proof. The accepted-startup and download source diffs against the original review baseline are saved alongside that snapshot.

### Correction to the earlier timeout wording

The original `plugin-ops.ts` default `DOWNLOAD_TIMEOUT_MS` was **180,000 ms (180 seconds)**, not 20 seconds. The original 20.2-second reproduction proved that an **accepted cancellation** did not abort the body or release the queue; it did not wait out the original default timeout. Source inspection separately proved the old timer was cleared upon receiving headers. The earlier wording attributing the observed 20.2 seconds to an expired default deadline was inaccurate. This closure verifies the deadline independently using the new explicit short-timeout test seam.

### Accepted startup closure

The reviewed change calls `assertAcceptedStartupReady()` immediately after `initWritable()` only from `takeAcceptedOwner()`. It checks failed-stop admission, manager identity/ownership, running status, and a manager view bound to the current epoch and a child origin. Ordinary cold-start diagnostic behavior is left on its existing path. A failure propagates through the existing accepted-startup HTTP cleanup; the CLI therefore reaches `reportFailed()` rather than `reportAccepted()`.

The original same-group tar/payload reproduction, with only manager spawn injected to fail, now **passes**. It additionally confirms the attempted HTTP endpoint is closed and the Home owner remains held. No manager child is spawned in this failing fixture; no taskkill permissions were needed. Full healthy accepted-startup coverage was separately reported by the primary as 16/16 and was not redundantly rerun here.

### Download closure

The reviewed change creates the download deadline inside the serialized plugin callback, keeps it through header/body consumption and publication guards, forwards the prepare job's `ctx.signal`, cancels readers on abort/limit, and aborts remaining response work when the download control closes. Streamed default limits are 32 MiB metadata and 256 MiB archive bytes. The limit is a response-byte limit, not a measured peak-memory guarantee.

The original stalled-tar/cancellation reproduction now **passes**, with the same 20.2-second observation interval:

```json
{"afterMs":20200,"networkSignalAborted":true,"prepareStatus":"cancelled","nextMutationRan":true}
```

A readback of its retained isolated fixture confirms terminal persisted job status `cancelled`, zero tarballs, and no library file published.

Three focused boundary tests also **pass**:

1. Independently stalled metadata and tar response bodies hit an injected 80 ms deadline, cancel their readers, fail the prepare job and release the following queued mutation. Neither archive nor library entry is published.
2. Metadata and tar streams without Content-Length exceed an injected 8-byte limit at 9 bytes and are rejected/cancelled before publication; the configured production constants are checked as 32/256 MiB. No large-memory allocation test was needed.
3. A real loopback HTTP 503 response with an unconsumed streaming body is aborted when the operation fails; the server observes the connection close. This checks actual native fetch/AbortSignal cleanup rather than only a fake response object.

Commands and results:

```powershell
node --import tsx --test --test-concurrency=1 --test-name-pattern='REVIEW' .sandbox/final-integrated-review/closure/baseline/tests/review-accepted-startup.test.ts .sandbox/final-integrated-review/closure/download-body-repro.test.ts
# 2 passed, 0 failed; exit 0
node --import tsx --test --test-concurrency=1 .sandbox/final-integrated-review/closure/download-boundaries.test.ts
# 3 passed, 0 failed; exit 0
```

Evidence: `.sandbox/final-integrated-review/closure/original-repros.log` and `download-boundaries.log`. Five tests total; no broad or unchanged primitive suite rerun. Default restricted execution sufficed. All filesystem data is isolated under temporary Home or `.sandbox`; the only network connection in these checks is the loopback error-response fixture. No real Home, registry/provider requests, credentials, source edits, Git mutations or global configuration access were used.

### Closure scope and drift

Before/after Git status and tracked diff paths are captured in the closure directory; Git capture commands exited 0. Fresh hashes cover **286** bounded files. **No source drift** occurred during this closure check, and the readiness method matched the live worktree at the final readback. The contemporaneous dsh-cli/toolchain/bindToolchain installation investigation is outside this two-finding closure; its code was captured for dependency consistency but was not treated as new product acceptance.

**Current verdict: READY for these two fixes and the reviewed source gate.** This supersedes the captured-baseline REVISE verdict for the two identified P1 findings. Standard-plugin first installation's EPERM investigation and final native/dual-client/compiled-handoff/package/maintenance acceptance remain primary-owned and are not claimed passed by this report. No push, release or deployment authorization or evidence is implied.


## First-start polling boundary review — READY

Reviewed the actual three-location fix in `src/adapters/node/workbench-supervisor.ts` against the prior closure baseline:

- `state()` calls `refreshAvailability(false)` (`:687`), so reads can refresh displayed reasons without permanently changing startup admission.
- `refreshAvailability(latchBlock = true)` (`:2293–2310`) retains default latching for internal initialization paths and never clears an existing `blocked` flag.
- `availability()` (`:2182–2188`) derives `limited` while manager installation or current diagnostic reasons are incomplete; it does not turn the transient observation into a permanent startup failure.

Relevant callers were traced through `initWritable()` and accepted-startup readiness. Real pre-existing journal/lock/unknown-process branches still call the default latching refresh and return before manager startup. Actual bootstrap/spawn errors still set `blocked` directly. Failed-stop `maintenanceBlocked` and its mutation guards are unchanged. Accepted startup still requires an actually running manager and matching ready view; public polling cannot clear those rejection conditions.

One independent focused test on a fresh current-source snapshot passed, **1/1, exit 0**:

```powershell
node --import tsx --test .sandbox/final-integrated-review/polling-check/polling-boundary.test.ts
```

It pauses the real runtime bootstrap at the injected CLI clone boundary, performs three early public state polls while the normal initialization lock is held and manager installation is incomplete, resumes bootstrap, and proves manager spawn is attempted once. The spawn is intentionally injected to fail, then three subsequent polls prove the actual failure remains latched and visible. Separate subcases in the same test verify a real isolated startup journal still prevents spawn/latches blocking, that a later public poll does not clear the latch, and that accepted startup with such a journal rejects while retaining Home ownership. This is runtime/control-path testing with injected CLI/spawn, not a new real-CLI or native interaction claim; no manager child is spawned.

Evidence: `.sandbox/final-integrated-review/polling-check/polling-boundary.log`. The primary's actual result files were also read: old early-poll case `case-yppNWK/result.json` shows manager stopped/generation 0/limited with empty reasons, while current-source early-poll case `case-obRdVC/result.json` shows manager running/generation 1/ready with empty reasons. These are supporting primary-owned observations, not a substitute for rebuilt standard plugin and packaged UI acceptance.

The fresh reviewed dependency snapshot/hashes cover 153 source files. Before/after Git status and diff paths plus `supervisor.diff` are saved in the polling-check directory; capture commands exited 0. Source drift during this check: **none**. Active worker test/report additions were not used as independent test evidence. No app source edits, Git mutations, real Home or credential access, broad suite reruns or external network calls were performed.

**READY for the polling fix within this scope.** Earlier source-gate closure remains valid; rebuilt full standard-plugin UI and final packaged acceptance remain primary-owned and are still not claimed passed here. The two download ArrayBuffer type normalizations were outside this polling check and their primary-reported targeted result is not relabeled as an independently rerun full suite.


## Focused cache-usage integrity review — REVISE

Scope was limited to the new version-aware occupancy change in `plugin-library.ts`, its removal and library-read callers in `plugin-ops.ts` / `workbench-products.ts`, and the two associated test files. No desktop snapshot helper, broad old-debt audit, build or full suite was inspected/run.

### P2 — A same-archive file reference through a filesystem alias is treated as unused and deleted

**Source:** `src/adapters/node/plugin-library.ts:145–153`, especially the direct-file comparison at `:146–148` and `sameResolvedPath()` at `:184–188`; caller `src/adapters/node/plugin-ops.ts:737–742`. The public library projection uses the same occupancy function at `src/adapters/node/workbench-products.ts:232`.

The new code correctly checks direct `file:` references before excluding a cache version that differs from the installed version, but `sameResolvedPath()` only normalizes strings with `path.resolve()` and Windows case folding. It does not resolve symlink/junction aliases. A valid `file:` dependency can therefore reference the exact candidate archive through a junction while the still-installed resolved version is older. The direct-reference guard misses it, the version comparison returns unused, the UI reports no consumers, and removal deletes the referenced archive. This behavior is newly reachable because the previous package-alias protection blocked removal for any installed version.

**Verified reproduction:** a wholly isolated Home contains candidate `@dsh-spaces/plugin@0.3.1-test.1` under `hub/plugins`; `hub/cache-alias` is a Windows junction to that directory. Profile `coding` has installed version `0.3.0` and a `file:../../hub/cache-alias/<candidate>.tgz` dependency. `realpathSync()` proves the dependency and library archive refer to the same file. The real `spacesUsingPlugin()` plus `removeDownloadedPlugin()` path produces:

```json
{"actualSameArchive":true,"used":[],"removalRejected":false,"archiveRetained":false}
```

The expected-protection test fails, **exit 1**. This is an actual fixture-archive deletion, not a hypothetical path comparison. Command and evidence:

```powershell
node --import tsx --test .sandbox/final-integrated-review/cache-usage/junction-reference.test.ts
```

Log: `.sandbox/final-integrated-review/cache-usage/junction-reference.log`.

**Scoped fix:** preserve the version-aware distinction, but resolve the referenced archive and library archive to canonical filesystem paths before concluding they differ. Keep the direct same-archive rule dominant over resolved-version differences; if a reference's identity cannot safely be resolved, retain conservative protection. Add the junction/symlink alias case to the existing same-archive test. Do not restore package-alias-only blocking for every version or infer a pin from `entry.id`.

Otherwise the inspected change preserves the intended safeguards: a pin comes only from `entry.spec` with matching package name/exact version; bare/Git/unpinned entries remain conservative; actual versions come from installed manifests; unknown versions and recognized malformed `file:` references remain protected. Read and removal callers share the same decision function. The primary's `.sandbox/library-usage-final-primary.log` was read and shows 53/53 passed; those tests do not cover this filesystem-alias case and were not repeated.

Before/after status, diff paths, five bounded file hashes and the reviewed diffs are in `.sandbox/final-integrated-review/cache-usage`. All capture commands exited 0, and the five reviewed source/test files had **no drift** during the repro. The repro imported those hash-stable current source files. It creates/deletes only its own normal scratch artifacts under `.sandbox`; no app source, Git, configuration, real Home, credentials or external network was changed/accessed.

**REVISE for this cache-usage change only.** Earlier completed closures remain intact. Overall final UI/package acceptance is not claimed passed.


## Cache-alias P2 focused closure — READY

Reviewed the actual current fix in `src/adapters/node/plugin-library.ts:145–148` and `:190–206`: same lexical path stays protected, otherwise `sameArchiveIdentity()` resolves both paths with `realpathSync()`. Either resolution failure yields unknown (`undefined`), which the caller protects via `!== false`. Only two successfully resolved, different paths fall through to the existing exact-version comparison. The caller changes and pin derivation were not broadened; pins still come from `entry.spec`, not `entry.id`.

The original independent junction repro was rerun against the hash-stable **current source**, not the old failing snapshot. It now passes:

```json
{"actualSameArchive":true,"used":["coding"],"removalRejected":true,"archiveRetained":true}
```

One additional independent small fixture covers three direct boundaries: (1) distinct existing old/candidate archive paths with differing exact installed/candidate versions still allow removal of the candidate while preserving the old archive; (2) an unresolved requested archive remains protected; (3) an unresolved candidate archive identity conservatively retains the library entry. All use real isolated files and the actual `spacesUsingPlugin()` / `removeDownloadedPlugin()` paths.

```powershell
node --import tsx --test --test-concurrency=1 .sandbox/final-integrated-review/cache-usage/junction-reference.test.ts .sandbox/final-integrated-review/cache-alias-closure/distinct-unresolved.test.ts
```

Result: **2 tests passed, 0 failed, exit 0**. Evidence: `.sandbox/final-integrated-review/cache-alias-closure/verification.log`. The reviewed fix, snapshots, before/after hashes, Git status and diff-path captures are stored in the same directory. All capture commands exited 0. The three implementation files and `tests/plugin-library.test.ts` had **no drift**. `tests/workbench-products.test.ts` changed concurrently to materialize its referenced old archive in the fixture; that test-only delta is saved as `test-drift.diff` and was not part of the independent repros. No implementation drift affected this closure.

**READY: the cache-alias P2 is closed.** This supersedes the preceding cache-usage REVISE verdict. No app source/Git/config changes, other-agent delegation, broad suite/build, desktop snapshot-helper inspection, real Home or credential access occurred. Final overall UI/package acceptance remains outside this closure and is not claimed passed.
