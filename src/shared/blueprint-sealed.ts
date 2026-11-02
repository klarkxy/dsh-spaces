/**
 * Spaces' blueprint workflows are sealed while the core space system stabilizes.
 * The independent @klarkxy/dsh-blueprint package and its wire formats remain supported.
 */
export const SPACES_BLUEPRINT_SEALED = true;

export function isSpacesBlueprintMethod(method: string): boolean {
  return method.startsWith("blueprint.");
}
