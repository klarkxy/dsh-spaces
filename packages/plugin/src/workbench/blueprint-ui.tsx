/**
 * The blueprint page of the workbench.
 *
 * The implementation moved into `blueprint/`, one module per panel:
 *
 * - `blueprint/page.tsx` — the page and its mode switch
 * - `blueprint/use-panel.tsx` — reading and applying a blueprint
 * - `blueprint/generate-panel.tsx` — writing a blueprint
 * - `blueprint/inspect.tsx` — the catalogue of an inspected blueprint
 * - `blueprint/inputs.tsx` — the receiver-local inputs
 * - `blueprint/bindings.tsx` — the convert bindings
 * - `blueprint/preview.tsx` — the staged plan
 * - `blueprint/apply.tsx` — the stage report of an applied blueprint
 * - `blueprint/shared.tsx` — the diagnostics and the safe link
 *
 * This file stays the public entry point, so every existing import path keeps
 * working.
 */
export { BlueprintsPage } from "./blueprint/page";
export { BlueprintApplyResult, BlueprintJobResult } from "./blueprint/apply";
