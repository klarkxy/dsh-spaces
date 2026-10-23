/**
 * The fixed vocabularies of the workbench client.
 *
 * The name rules, the job kinds and the confirmation tiers were constants of
 * `workbench/store.ts`. They move here unchanged so that every part module
 * reads the same sets instead of repeating them.
 */

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
export const RESERVED = new Set(["web", "hub", "headless", "node_modules", "spaces-hub"]);
export const ACTIVE_JOB = new Set(["queued", "running"]);
export const CREATE_JOB = new Set(["space.create", "template.create", "space.import"]);

/**
 * D1 confirmation tiers.
 *
 * A stop or a restart of one space is reversible and does not destroy data, so
 * its preview executes without a second dialog. Everything that removes data,
 * switches a version or stops the whole service keeps the confirmation dialog.
 * A destructive plan of the same kind still shows the dialog: the backend
 * decides what the plan does, the client only decides whether to ask again.
 */
export const AUTO_CONFIRM_KINDS = new Set(["space.stop", "space.restart"]);
