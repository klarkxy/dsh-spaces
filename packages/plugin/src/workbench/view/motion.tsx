/**
 * Workbench shell motion helpers. `PanelScale` is the shared `VisibleScale`:
 * a panel scales into place while its opacity stays at 1, so a failure reason
 * inside it is readable from the first frame (let it crash).
 */
export { VisibleScale as PanelScale } from "../../../../../src/shared/ui";
