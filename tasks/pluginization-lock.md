# Home operation lock — Desktop slice

Cross-process lock for one canonical DSH home. Lock and reclaim directories sit next to the home root, not under snapshot-replaced `hub/` or `profiles/`.

## Types

```ts
export const HOME_LOCK_DIR_NAME = ".dsh-spaces-lock";
export const HOME_LOCK_OWNER_FILE = "owner.json";
export const HOME_RECLAIM_DIR_NAME = ".dsh-spaces-reclaim";

// from src/core/ports/operation-lock.ts
export interface OperationLock {
  run<T>(label: string, action: () => Promise<T>): Promise<T>;
}

export interface HomeLockOwner {
  pid: number;
  nonce: string;
  startedAt: string;
  label: string;
}

export type HomeLockInspect =
  | { held: false; lockDir: string }
  | { held: true; incomplete: true; lockDir: string }
  | { held: true; reclaim: true; lockDir: string }
  | { held: true; ambiguous: true; reason: string; lockDir: string }
  | { held: true; owner: HomeLockOwner; lockDir: string };

export type UnlockDeadResult =
  | { unlocked: false; reason: "not-held" }
  | { unlocked: false; reason: "incomplete" }
  | { unlocked: false; reason: "reclaim-in-progress" }
  | { unlocked: false; reason: "ambiguous"; detail: string }
  | { unlocked: false; reason: "owner-alive"; pid: number }
  | { unlocked: false; reason: "remove-failed"; detail: string }
  | { unlocked: true; owner: HomeLockOwner };

export class HomeOperationLock implements OperationLock {
  constructor(home: string);
  readonly home: string;
  readonly lockDir: string;
  readonly reclaimDir: string;
  inspect(): HomeLockInspect;
  unlockDead(): UnlockDeadResult;
  run<T>(label: string, action: () => Promise<T>): Promise<T>;
}

export class MaintenanceGate {
  constructor(lock?: OperationLock);
  run<T>(label: string, action: () => Promise<T>): Promise<T>;
  runMutation<T>(action: () => Promise<T>): Promise<T>;
}
```

`HomeOperationLock` implements the core `OperationLock` port. Desktop constructs `new MaintenanceGate(lock)` — not `{ lock }`.

## Semantics

- Canonical home: `resolve` then `realpath`, `assertNotRealHome` on both the unresolved path and the realpath result.
- Ownership: exclusive `mkdir` of `.dsh-spaces-lock`, then `owner.json` with pid + random nonce + timestamp + label.
- Crash before owner write leaves an incomplete lock. `run` and `unlockDead` refuse; they do not guess or steal.
- No automatic steal. `unlockDead` only after ESRCH. EPERM is live.
- Release verifies nonce and unlinks/rmdirs only that owner. Failure throws `HomeLockReleaseError`; blocked state stays visible.
- Reclaim of a dead owner takes exclusive `mkdir` of `.dsh-spaces-reclaim` first. Acquisition treats reclaim as held. Incomplete reclaim is not stolen.
- AsyncLocalStorage reentry is only for the active owner generation of that instance.

## Desktop wiring

`createDesktopHomeControl(home)`:

- `mutate(action)` → `maintenance.runMutation(async () => action())`
- `runMaintenance(label, action)` → `maintenance.run(label, action)`

`src/main/index.ts` uses that for IPC mutations, startup-recovery, runtime-prep, create/delete/plugin ops, menu/tray `mutate` paths, and these read handlers that actually write:

- `getPluginCatalog` / `searchPluginCatalog` — hub catalog cache
- `listPluginLibrary` — `syncLibraryFromProfiles` may write `hub/plugin-library.json`
- `previewUpgrade` — current `CoordinatedUpgrade.preview` only reads plugin metadata; it is still admitted through the mutation lock so it cannot interleave with writers. `dump-config` remains on upgrade/verify/start, already under maintenance or `mutate`.

Quit: first `stopAll()` stays outside the lock so in-flight starts cancel while maintenance drains (avoids deadlock). After `idle()` + plugin drain, `runMaintenance("quit", stopAll)` takes the home lock.

This phase does not kill external/host processes or steal a live lock.
