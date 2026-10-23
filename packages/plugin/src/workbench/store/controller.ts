/**
 * The workbench client.
 *
 * The controller is the last link of the part chain. Every part owns one
 * concern of the client state machine:
 *
 * - `parts/state.ts` applies an observed state to the client.
 * - `parts/persistence.ts` owns the locale, the theme and the selected space.
 * - `parts/navigation.ts` owns the selection and the view session.
 * - `parts/overlays.ts` owns the dialogs, the tabs and the detail page.
 * - `parts/commands.ts` turns a user action into a workbench command.
 * - `parts/requests.ts` previews, submits and polls.
 * - `parts/jobs.ts` tracks the jobs and their product outcomes.
 * - `parts/product.ts` reads the catalog, the library, the logs and the rest.
 *
 * The parts inherit from each other, so the chain is acyclic and every part
 * can call a member that another part owns.
 */

import { ProductPart } from "./parts/product";

export class WorkbenchController extends ProductPart {}
