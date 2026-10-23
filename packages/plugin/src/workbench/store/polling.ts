/**
 * The poll cadence of the workbench client.
 *
 * A hidden tab polls slower, and a tab with running jobs polls faster. The
 * function was module-level in `workbench/store.ts` and moves here unchanged.
 */

export function pollDelayMs(activeJobs: boolean, hidden: boolean): number {
  if (hidden) return activeJobs ? 2000 : 4000;
  return activeJobs ? 500 : 1000;
}
