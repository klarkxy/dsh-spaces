# Shared core extraction (bounded)

Worker scope: `src/core/**`, `src/main/{patch-writer,profile-registry,maintenance-gate,restore-session}.ts`, `tests/spaces-core.test.ts`, this file.

No DSH SDK/plugin transport research. No `src/main/index.ts`. No Node lock implementation or Desktop wiring.

## Layout

```
src/core/domain/isolation.ts     YAML isolation overlay + dump verification
src/core/domain/registry.ts      name/order/classify/spaces.json helpers
src/core/application/maintenance-gate.ts
src/core/application/restore-session.ts
src/core/ports/operation-lock.ts
src/core/ports/restore.ts        restore snapshot/runtime + describeRuntime ports
```

Desktop keeps consuming the extracted implementation through the four existing `src/main` facades. Node fs, `atomicWrite`, `runDsh`, `assertNotRealHome`, and `describeRuntime` stay in those adapters.

## Changed APIs

### Isolation (`src/core/domain/isolation.ts`)

Moved from `src/main/patch-writer.ts` without behavior change:

- `SESSION_ROW_ID`, `STORAGE_ROW_ID`
- `PatchForbiddenError`, `PatchVerifyError`
- `extractRoot`, `assertDumpPatched`, `isExpectedIsolationRoot`, `isolationExpr`
- **new public helper:** `applyIsolationPatch(original, name, source)` — previous `ensureWorkbenchPatch` YAML mutation
- **new public helper:** `patchTextLooksIsolated(text, name)` — previous `ProfileRegistry.hasWorkbenchPatch` string check

`src/main/patch-writer.ts` re-exports the previous public surface plus the two helpers. `PatchWriter` and `dumpConfig` remain Node adapters.

### Registry (`src/core/domain/registry.ts`)

Extracted from `ProfileRegistry` (class still lives in the main adapter):

- `SPACES_VERSION`, `WEB_APP_BUNDLE`, `emptySpacesFile`, `normalizeSpacesFile`
- `defaultSpaceMeta`, `classifyProfile`, `onboardingAction`, `packageHasWebApp`
- `assertValidProfileName` (syntax + reserved; existence stays in the adapter)
- `compareScannedProfiles`, `completeWorkbenchOrder`
- `applyMetaPatch`, `applyWorkbenchReorder`, `removeSpaceMeta`

Public `ProfileRegistry` methods are unchanged.

### Maintenance (`src/core/application/maintenance-gate.ts`)

- Class moved to core; `src/main/maintenance-gate.ts` re-exports it.
- **new optional constructor:** `new MaintenanceGate(lock?: OperationLock)`
- `OperationLock` port: `{ run<T>(label: string, action: () => Promise<T>): Promise<T> }`
- No-arg behavior is unchanged: synchronous holder acquire/reject, `runMutation` drain, overlapping mutations (different spaces) when no lock is configured.
- When a lock is passed, admitted `run` / `runMutation` work is wrapped with `lock.run` after local admission. Node lock + `index.ts` wiring are out of scope.

### Restore (`src/core/application/restore-session.ts`)

- State machine moved to core.
- **required port:** `describeRuntime: DescribeRuntimePort` (`describe(ref) => SnapshotRuntime`)
- Snapshot/runtime collaborators live in `src/core/ports/restore.ts` (`RestoreSessionSnapshots`, `RestoreSessionRuntimes`, `RestoreBackupOptions`)
- `src/main/restore-session.ts` remains a thin facade: same constructor as before (`snapshots`, `runtimes`, `applyRestoredSettings`) and injects `./runtime-descriptor`. Existing tests keep using the facade.

## Out of scope (other workers)

- Node `OperationLock` implementation
- Desktop wiring in `src/main/index.ts`
- Host/plugin transport, DSH SDK
