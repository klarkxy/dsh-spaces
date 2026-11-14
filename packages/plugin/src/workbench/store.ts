/**
 * The workbench client.
 *
 * This module is the facade of the client. The behaviour lives in
 * `./store/`, one focused part per concern; this file keeps the module path
 * and the public surface of the client exactly as it was:
 *
 *   WorkbenchController, pollDelayMs, createDefaultEnv,
 *   workbenchRequestOrigin, requestOriginMounted,
 *   HomeTab, OverlayKind, SettingsDraft, ImportPreviewState,
 *   WorkbenchPluginVersions, WorkbenchEnv, WorkbenchUiState,
 *   WorkbenchReadSurface, SpaceImportResult.
 *
 * The directory is named `store/` and holds no `index.ts`, so an import of
 * `"./store"` keeps resolving to this file and never to the directory.
 */

export { WorkbenchController } from "./store/controller";
export { createDefaultEnv } from "./store/env";
export { pollDelayMs } from "./store/polling";
export { requestOriginMounted, workbenchRequestOrigin } from "./store/origin";
export { isSettingsOverlay } from "./store/types";
export type {
  CreateDialogMode,
  HomeTab,
  ImportPreviewState,
  OverlayKind,
  SettingsDraft,
  SpaceImportResult,
  WorkbenchEnv,
  WorkbenchPluginVersions,
  WorkbenchReadSurface,
  WorkbenchUiState,
} from "./store/types";
