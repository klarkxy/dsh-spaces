# B5 program handoff integration

Primary-owned extension of merge-contract-v2. No new daemon, registry, recovery or rollback. Source and build workers keep their existing path ownership.

## Node-only component selection

`src/adapters/node/component-selection.ts` exports:

- `stageComponentPayload(home, toolsRoot, sourceLib): ValidatedComponentPayload`: validates the full v2 manifest and copies only its files to `toolsRoot/components/<digest>`; refuses Home-contained or linked roots.
- `readSelectedComponentPayload(home, toolsRoot): ValidatedComponentPayload | undefined`: reads `toolsRoot/selected-<homeDigest>.json`, binds canonical Home digest, resolves only `components/<digest>/lib`, verifies manifest and digest. Only ENOENT means absent; invalid bytes remain and throw.
- `selectComponentPayload(home, toolsRoot, digest): ValidatedComponentPayload`: validates that staged group, writes `{schemaVersion:2,homeDigest,artifactDigest}` atomically. Caller must hold the cold-start reservation with no live owner, or the launcher run reservation. No implicit fallback to another candidate.

Bootstrap stages the bundled group only for an explicit cold start. If a selected pointer exists it is authoritative, including after failed upgrade. It must not be overwritten by a newly opened desktop or plugin. Existing healthy attach remains read-only. The bootstrap passes selected immutable `lib` as `--component-payload` to the Supervisor and uses that group's snapshot worker and plugin/view/LLM artifacts. Full payload stays outside Home. Fresh pointer selection occurs inside the existing cold-start reservation.

## One-shot launcher

`src/adapters/node/component-handoff.ts` and `packages/supervisor/src/launcher.ts` implement the bounded IPC handshake. Secrets travel only over inherited Node IPC, never argv, environment, persistent receipts or public jobs.

The old Supervisor stages the exact candidate first, stops all its owned children under the existing job gate, seals further mutations, and spawns the launcher. Launcher initially waits for a message. Old Supervisor transfers its existing HomeController run owner to the live launcher, then sends the token, exact Home/tools root/digest/runtime launch options and explicit clean-stop confirmation. It must close transport and exit normally without releasing the transferred owner. A failed stop must never transfer or switch.

Launcher validates the reservation and candidate, waits within a fixed deadline for IPC disconnect plus original PID proven dead, then atomically selects the reserved digest. Alive, ambiguous, missing confirmation, token mismatch or timeout leaves old pointer and run evidence intact. It spawns the new Supervisor exactly once with `--accept-handoff`, waits for the new child to report ready-to-accept (IPC), binds authorization to that live PID, then sends the token through IPC. New Supervisor accepts before creating any backend writer or opening management HTTP. It returns a sanitized accepted/ready signal. New epoch and bearer must differ.

After pointer selection, any spawn/accept/start failure preserves the selected pointer and run evidence. No retry, fallback, stale-lock reclaim or replay. Receipts under the Home control directory have bounded fixed public fields (handoffId, phase, artifactDigest, status, timestamps, fixed failure code), no token/nonce/environment/raw error. The launcher has no space/plugin/model business logic.

Export the parent-side launch handshake API and the child-side receive helper with typed parameters. Keep Supervisor integration and its CLI index on the primary until the B2 writer releases those paths. Launcher worker owns the launcher entry only; primary/build worker wires the build later. Use real child processes to verify old-process alive/exit, single start, IPC-only secret transport, missing confirmation, token mismatch, failed target start, and competitor acquisition rejection. Test hooks may supply executables, deadlines and liveness, but production must use the same sequence.

The normal workbench-upgrade use case retains snapshot/install/verify behavior and its exact version/content preview. After installing the complete candidate set it hands off instead of reinitializing the old manager. It must use the validated component payload digest for the handoff binding, and retain ordinary package/job failure evidence.

## Integration clarifications

- A standard installed plugin is read from the target Home's profile/node_modules tree. That is a valid source. Only staged and selected executable destinations must live outside Home. Production reads honor explicit per-Home authorization; tests never touch the real Home.
- The launcher must spawn the selected manifest's supervisor entry, and reject any supplied entry that does not resolve to it before changing the pointer. A trusted parent programming error must not make the reserved digest unrelated to the actual executable. Tests can create a real fixture entry inside the staged manifest.
- The real Supervisor CLI receives the token before constructing its runtime, accepts with the explicit preserved endpoint from its `--port` argument, and passes that accepted handle to the runtime. It reports the final IPC success only after HTTP and manager initialization succeed. An acceptance-only acknowledgment is not startup success. Startup failure preserves the accepted owner and selected pointer.
- The old upgrade job can report preparation/handoff pending after durable snapshot/install verification. It must not tell the UI that a new service started before the launcher confirms. The separate bounded launcher receipt is the final switch/start evidence. The old process waits for its job to settle and its transport to close, then sends the flushed IPC commit and exits without releasing the transferred owner.
