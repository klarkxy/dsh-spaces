# Changelog

All notable changes to DSH Spaces are recorded here. This project follows Keep a Changelog style; version ranges follow the repository's own 0.x policy.

## [Unreleased]

### Added

- Desktop error pages now expose a manual frontend-only `Reload Spaces view` (`重新加载空间界面`) button whenever the failure is on the client/bridge side while `desktopLaunchState` and the running manager remain ready: it performs read-only checks (`role`, `desktopLaunchState`, `presentationSnapshot`) and mounts a fresh read-only `NativeHostController` without restarting Supervisor or any space.
- Client surfaces (`NativeHostController`, `HostShellController`) now forward bounded, sanitized failure reports (including `stage`, `WorkbenchRemoteError` RPC transport/connection state, `portalFailure`, and up to 64 `navDiag` events) via `workbenchGuide/reportClientFailure` into `host.jsonl`, flushing once if the host WebSocket reconnects.
- The official native DSH space the Desktop and portable rails run in now shows a static ambient light: green while a session is actually running, yellow while a tool approval or `ask_user_question` card waits for you (yellow wins). It is drawn on the rail's inner edge, the pinned current entry and the edges of the host page, never over a native view, and it does not animate in a loop. It follows the host theme, `prefers-reduced-motion` and forced colours, and the current entry's accessible name and a status region carry the same state. The state comes from a read-only `workbenchGuide/hostActivity` remote (two enum fields, no session content) that only a trusted main host answers. A confirmed pending approval or question is yellow even while `working` is unknown; green needs `attention: none` together with `working: busy`; an unknown attention, a failed, timed-out or malformed read shows no light. Each read is bounded by a 5-second abortable deadline, `stop()` aborts the read in flight and withdraws the light at once, a late answer of an older generation is discarded, and the next read waits the ordinary 1.5-second cadence; there is no early retry or reconnect. Sub-space halos are unchanged.

### Fixed

- `NativeHostController` outer selection deadline now aligns to 90 seconds (covering 15s initial guest load + 35s manager readiness + 35s child selection) and appends the bounded `navDiag` reached-stage summary to `detail` on expiration.
- Contained `WorkbenchApp` instances disable stale `localStorage` `selectedId` auto-restore (`disableAutoRestore`), and `@dsh-spaces/view-bridge` deduplicates repeated `"ready"` `postMessage` frames across DOM mutations while `connection` remains `"ready"`.
- Desktop `shell.overlay` remounts during live `cordis.patch.yml` reloads now replace a non-terminal disposed controller instead of rendering an already-stopped instance, while preserving terminal `failed` / `service-stopped` controllers and keeping the active controller pointer synced across service restarts and surface reloads.

- The managed component packages `@dsh-spaces/view-bridge` and `@klarkxy/dsh-dev-index` are protected wherever plugin changes are accepted: they show as protected in the workbench plugin list, and install, remove and toggle previews refuse them before a job exists. They remain preinstalled canonical lines and can no longer reach a running space's plugin manager as a removal target.
- A running-space plugin operation refused before any change reaches the child (protected package, invalid input, missing entry, stale identity) now fails as an ordinary job failure; it no longer latches the Home maintenance flag, which previously reported an "unfinished maintenance journal", blocked the workbench and refused the authorized Desktop service restart until a Supervisor restart.
- Plugin batch failures headline "插件操作失败" instead of "启动失败"; space start and stop failure headlines are unchanged.
- Main-space model sync now reads the main profile through an in-process, read-only composition of the bound host's `dsh-app-boot` layers instead of the official `--dump-config` CLI, so the Desktop `desktop` profile (refused by that CLI) syncs and its `cordis.yml` is never rewritten.
- Creator and maintenance batch installation accepts the exact pinned GitHub subdirectory spec (`github:owner/repo#<commit>&path:/<sub>`) it generates, validated by a dedicated strict parser; on Windows it is refused for CLI builds that join arguments through a shell.
- The blueprint runtime inspection test derives its optional-bundle expectation from the bound installation's catalog instead of a retired bundle name, and the host failure-page test scopes its detail assertion to the primary reason row.
- Managed spaces now have one 30-second cooperative shutdown window instead of five seconds. A clean exit observed after a failed stop updates the process to stopped without reporting an unrelated startup crash or rewriting the failed operation; failed service shutdowns still preserve ownership and do not retry or restart.
- Desktop failure pages now carry the actual diagnosis: a supervisor request that never arrived reports its bounded transport cause and elapsed time, a presentation failure appends the read-only supervisor liveness and endpoint facts, renderer and load failures keep a sanitized reason, and the failure panel shows the failure time. A failed guide request is recorded in the host diagnostic log with its remote name; the failure stays terminal without reconnecting, retrying or relaunching.
- The supervisor HTTP server allows 65 seconds of keep-alive headroom so 1.5–5 second pollers never meet a server-side idle close.
- Diagnostic log rotation is decided from on-disk state on every write: the active file's first record time and its real size, so alternating logger instances and processes no longer leave stray one-line archives at startup and an eight-day-old first record rotates exactly once.
- A remounted Desktop plugin instance joins the shared launch record and, once it is ready, attaches the running service so the main space registration is re-established on the same Supervisor epoch — attach only, never a second launch.
- A failed dead-lock reclaim drops its reclaim marker, so later `unlockDead` attempts report the real lock state instead of `reclaim-in-progress` forever; held ownership still blocks acquisition.
- Workbench shutdown confirmation reads the submitted job read-only until it is terminal: a failed or cancelled shutdown resumes normal polling with the error shown, and a read failure keeps the unconfirmed notice instead of replacing the view with the state error page.
- Share export no longer rejects spaces that synced models: the secret scan flags literal `apiKey` values while `apiKeyEnv: <env name>` rows pass; managed credential references and `sk-` literals stay caught by their own patterns.
- The Workbench skips npm version reads for Spaces component packages (`@dsh-spaces/view-bridge`, `@dsh-spaces/browser`, the plugin package) that ship inside the payload; ordinary installed plugins are still queried.
- Fire-and-forget promises that could reject now log their failure: host bootstrap and the settled-plan hooks write to the host or Supervisor diagnostic log instead of surfacing as unhandled rejections.
- Successful timer-driven read-only requests (`state`, `startupStatus`, `job`) no longer write per-request debug lines, while failed and mutating requests keep logging; child space stderr lines record at `info` with a `stream: "stderr"` context, and observed process failures stay `error`.

## [0.5.0] — GitHub Release 2026-11-14; npm pending

The npm publication request was accepted, but the registry currently exposes only a temporary `0.0.0-stage` holding version. The real 0.5.0 npm version and its public-install acceptance remain pending. The GitHub Release archive is available and its download matches the approved package.

- The main plugin is now named `dsh-spaces`, including its client module, bundle entries and local archive. Existing `@dsh-spaces/plugin` installations require the documented explicit package-name change; the old identity remains protected and is never treated as an ordinary workspace plugin.

### Added

- Published GitHub Releases automatically run CI, pack and publish the exact `dsh-spaces` archive to npm, then verify its public metadata, bytes and channel. Stable versions use `latest`; prereleases use `next`. The verified package and publication report are attached to the Release.
- Local rotating JSONL diagnostics for the host, Supervisor and managed-space output: `debug`/`info`/`error`/`fault` levels, seven-day or 100 MiB active-file rotation, seven-day/100 MiB archive retention, and an `info` default for distribution builds. Credentials, bootstrap tokens and local paths are redacted before disk writes; log failures never trigger recovery.
- The Spaces plugin now runs inside compatible DSH Web and Desktop hosts, with the original application preserved and a space rail added.
- Four main-space Creator tools: `spaces_context`, `spaces_create_preview`, `spaces_create_execute` and `spaces_job` for one frozen, serial creation plan.
- Main-space space-control tools for lifecycle, plugin, runtime, model-sync and bounded UI automation work: `spaces_overview`, `spaces_inspect`, `spaces_logs`, `spaces_templates`, `spaces_import_preview`, `spaces_plan`, `spaces_execute`, `spaces_control_job` and `spaces_ui_*`.
- One-time main-space model sync (`models-sync` at creation, "Sync models from the main space" in workbench space detail, and `models.sync` in `spaces_plan`): copies the main space's `llm-pi-ai` routes, `llm-deepseek` settings, default model and the keys those routes reference so each space calls providers directly with its own configuration. Manual sync shows and rechecks a non-secret preview before any write. Running spaces use their own settings/credentials Remote interfaces, stay running and apply the new configuration to the next model request; stopped and crashed spaces use direct file writes. Login-grant and expression routes are skipped and listed in the preview and job result.
- The three space rails draw a breathing attention halo around a space whose sessions have a pending tool approval or `ask_user_question` card; the halo is presentation only and reports `unknown` when no fresh view-bridge report exists.
- Desktop rail open, start, stop, restart and "Open space settings" actions, plus preserved background service failure reporting.
- Ordinary templates and `.dshspace` sharing remain available; Browser Space and Spaces blueprint entry points remain sealed.

### Changed

- Standalone DSH runtime installation explicitly includes required npm peers instead of inheriting the checkout's development-only `legacy-peer-deps` exception.
- The default plugin directory is now the Spaces community catalog in this repository, accepting packages from independent authors. Catalog cards show authors, repositories, runtime ranges and version-specific test evidence; an explicit npm-name entry supports installing packages before catalog inclusion.
- Install published prebuilt npm versions or directly from the Git repository root: the installer's authorized `prepare` step builds the complete Git plugin, and the root package ships only its runtime payload. Manual clone/build/pack steps are optional maintainer workflows. CI verifies Git-root and archive installation, and the community catalog remains available.
- The initial community catalog reuses dsh-plugins entries, including bilingual descriptions, categories and exact npm coordinates. The bundled snapshot excludes shared service libraries and example entries; installation rechecks published npm versions and honors the selected package source.
- Desktop startup preferences run only on a new Desktop launch, through the serialized job queue. Web launches and confirmed service-only restarts leave child spaces stopped. State decoding accepts the preference and defaults it to off for older service responses.
- Live model sync replaces same-named routes instead of keeping obsolete nested settings and verifies written configuration values. Diagnostic logging preserves Node's fatal rejection behavior and redacts known credential values before recording Remote failures.
- Live plugin batches preserve completed, failed and unattempted target outcomes. Completed offline plugin operations refresh the open space's plugin inventory.
- Space detail now shows the target's saved model state on General, including its default model, route count and incomplete settings. Running model sync confirmations state that the space stays running and the next request uses the new configuration; running plugin install, remove and toggle operations apply live through the space's `pluginManager` without stopping the space and let the user choose when to restart if needed (`cleanup-manager` and `space.runtime.set` retain their stop/restart confirmations).
- Space-scoped workbench plans validate only their affected target spaces rather than unrelated `stateRevision` changes and check plan TTL on submit so queued plans do not expire while waiting; workbench busy state is scoped per space so unrelated spaces can queue operations behind the single-writer job queue.
- Settings UX refinements: settings navigation is consolidated into four items (`Spaces`, `Templates`, `General` with collapsible `Advanced` settings for package source, plugin catalog URL and port range with dirty-state tracking, and `Maintenance` combining service status, jobs, Home backups, DSH runtimes, workbench logs and service stop); space rows open space settings on click and unify `Space settings`, lifecycle, `Export share file`, `Save as template`, move up/down, rename, icon and delete with an explicit data-removal checkbox under a single `⋯` / context menu (removing the duplicate export card from space detail); space detail keeps internal IDs under `Advanced`, shows manager-cleanup only when `dsh-spaces` is misinstalled, and supports manual diagnostic refresh; `Create space` unifies `Blank`, `From template` and `.dshspace` `Import from file` modes with display-name-first input, auto-derived IDs, start-after-create and collapsible advanced fields, while `Templates` focuses on using or deleting saved local templates; plugin catalog cards group by category with installed badges, one-click latest preview install and inline version selection; common job progress messages are localized and backups explain their offline archive directory.
- UI copy cleanup across the workbench, Desktop rail, portable host guide and Browser preview: redundant explanatory paragraphs, scope-help modals and verbose policy disclaimers were removed or tightened in both Chinese and English while preserving action impact warnings and failure details.
- The default DSH runtime for new installations, the build SDK and CI now target `0.2.2-rc.1`; existing supported runtimes remain pinned per space, with `0.2.0-rc.2` as the minimum.
- Spaces upgrades use the host plugin manager, a normal service stop and a reopen; there is no in-app self-update or launcher handoff.
- Without a bound DSH CLI, Spaces now fails with a typed error instead of installing a managed CLI; the Node toolchain download makes a single attempt with no `curl` retries.
- An older space drops the retired `@dsh-spaces/llm-bridge` bundle once through the official `dsh plugin remove` at its next start; an interrupted removal keeps its alignment marker as evidence.
- Doctor JSON reports `writeBlocked` instead of the misleading `rollbackRequired`; the always-equal `writeAllowed` field and the unused recovery exit code `10` were removed.

### Removed

- Live main-model delegation and the legacy shared LLM connection library: the `@dsh-spaces/llm-bridge` component, the main host's LLM services and image helper entry, the `--llm-bridge-artifact` Supervisor flag, the `llm-policy.set` control operation and `hub/<id>/llm-policy.json` writes.
- Standalone desktop distribution and in-place upgrade from the 0.4.0 desktop application.
- Public recovery orchestration, snapshot/config restore, Doctor recover/unlock/rollback, legacy desktop leases and runtime `current.json` pointers.
- The unused `DSH_SPACES_PACKAGED` environment bypass of the real-Home write guard.

### Known limitations

- Browser Space and Spaces blueprint workflows are sealed in 0.5.0; their implementations remain in the repository.
- There is no in-place upgrade or migration from the 0.4.0 standalone desktop application; old spaces are not migrated.
- Windows is the locally verified platform for this release; macOS and Linux are not certified, and remote HTTPS or arbitrary third-party native hosts remain unsupported.
- Existing ordinary-space bridges are not automatically realigned to a new component group; presence of a bridge does not prove version alignment.
- There is no automatic retry, restart, rollback, restore, repair or interrupted-job replay. Only the bounded Desktop service start/restart exception in the fault policy is allowed.
- Unregistered manual DSH processes are outside managed discovery and shutdown; backups cover known stopped managed spaces only.
- Space isolation is not a malicious-plugin sandbox, multi-tenant boundary or cross-machine high-availability mechanism.
- Real-Desktop end-to-end acceptance is still incomplete for `plugin.live.*` operations and the `spaces_ui_*` approval flows.

## [0.4.0] and earlier

See the historical release notes for [0.4.0](tasks/archive/releases/v0.4.0.md), [0.3.1](docs/releases/v0.3.1.md), [0.3.0](tasks/archive/releases/v0.3.0.md) and [0.2.0](tasks/archive/releases/v0.2.0.md).
