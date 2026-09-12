export type { OperationLock } from "../../core/ports/operation-lock";
export { createDesktopHomeControl, type DesktopHomeControl } from "./home-control";
export {
  HOME_LOCK_DIR_NAME,
  HOME_LOCK_OWNER_FILE,
  HOME_RECLAIM_DIR_NAME,
  HomeLockBusyError,
  HomeLockReleaseError,
  HomeOperationLock,
  canonicalHome,
  type HomeLockInspect,
  type HomeLockOwner,
  type UnlockDeadResult,
} from "../node/home-operation-lock";
