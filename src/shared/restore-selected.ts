import type { ProfileRecord, ProfileStatus } from "./types";

/** Keep the renderer's current pick; after a remount, follow the view main is actually showing. */
export function restoreSelected(
  current: string | null,
  visible: string | null,
  profiles: Pick<ProfileRecord, "name" | "status">[],
): string | null {
  if (current && profiles.some((profile) => profile.name === current)) return current;
  if (visible && profiles.some((profile) => profile.name === visible)) return visible;
  return null;
}

export function shouldShowStartingCard(
  status: ProfileStatus | undefined,
  launching: boolean,
): boolean {
  return status === "starting" || (status === "stopped" && launching);
}

export function shouldShowIdleCard(
  status: ProfileStatus | undefined,
  launching: boolean,
): boolean {
  return status === "stopped" && !launching;
}
