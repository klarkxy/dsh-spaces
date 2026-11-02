/** Browser Space entry points are withheld from the current release.
 * Keep its implementation and contracts for a later, explicitly accepted release.
 */
export const SPACES_BROWSER_SEALED = true;

export function requestsBrowserSpace(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const value = input as { base?: unknown; browser?: unknown };
  return value.base === 'browser' || value.browser === true;
}
