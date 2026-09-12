import { t } from "../../shared/i18n";
import {
  PROFILE_NAME_RE,
  RESERVED_PROFILE_NAMES,
  type OnboardingProfile,
  type ProfileKind,
  type ProfileRecord,
  type SpaceMeta,
  type SpacesFile,
} from "../../shared/types";

export const SPACES_VERSION = 1 as const;
export const WEB_APP_BUNDLE = "@deepseek-ai/dsh-web-app";

export function emptySpacesFile(): SpacesFile {
  return { version: SPACES_VERSION, onboarded: false, order: [], meta: {} };
}

export function normalizeSpacesFile(parsed: SpacesFile): SpacesFile {
  if (parsed.version !== 1) {
    throw new Error(t("errors.unsupportedSpacesVersion", { version: String(parsed.version) }));
  }
  if (parsed.order != null && (!Array.isArray(parsed.order) || parsed.order.some(name => typeof name !== "string"))) {
    throw new Error("Space registry order must be a list of names.");
  }
  if (parsed.meta != null && (typeof parsed.meta !== "object" || Array.isArray(parsed.meta))) {
    throw new Error("Space registry metadata must be an object.");
  }
  for (const meta of Object.values(parsed.meta ?? {})) {
    if (!meta || typeof meta !== "object" || Array.isArray(meta) ||
      typeof meta.displayName !== "string" || !Number.isFinite(meta.order)) {
      throw new Error("Space registry metadata is invalid.");
    }
  }
  return {
    version: 1,
    onboarded: Boolean(parsed.onboarded),
    order: parsed.order ?? [],
    meta: parsed.meta ?? {},
  };
}

export function defaultSpaceMeta(name: string): SpaceMeta {
  return {
    displayName: name === "web" ? "Home" : name,
    order: name === "web" ? -1 : 1000,
  };
}

export function classifyProfile(name: string, hasWebApp: boolean): ProfileKind {
  if (name === "web") return "root";
  if (!hasWebApp) return "hidden";
  return "workbench";
}

export function onboardingAction(
  kind: ProfileKind,
  hasWorkbenchPatch: boolean,
): OnboardingProfile["action"] {
  if (kind === "root") return "adopt-root";
  if (kind === "workbench") {
    return hasWorkbenchPatch ? "already-workbench" : "convert-workbench";
  }
  return "hide";
}

export function packageHasWebApp(pkg: unknown): boolean {
  if (!pkg || typeof pkg !== "object") return false;
  const dsh = (pkg as { dsh?: { profile?: { bundles?: unknown } } }).dsh;
  const bundles = dsh?.profile?.bundles;
  return Array.isArray(bundles) && bundles.includes(WEB_APP_BUNDLE);
}

export function assertValidProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(t("errors.nameInvalid"));
  }
  if ((RESERVED_PROFILE_NAMES as readonly string[]).includes(name)) {
    throw new Error(t("errors.nameReserved", { name }));
  }
}

export function compareScannedProfiles(
  a: Pick<ProfileRecord, "kind" | "name" | "meta">,
  b: Pick<ProfileRecord, "kind" | "name" | "meta">,
  order: string[],
): number {
  if (a.kind === "root" && b.kind !== "root") return -1;
  if (b.kind === "root" && a.kind !== "root") return 1;
  const ao = order.indexOf(a.name);
  const bo = order.indexOf(b.name);
  if (ao !== -1 || bo !== -1) {
    return (ao === -1 ? 9999 : ao) - (bo === -1 ? 9999 : bo);
  }
  return a.meta.order - b.meta.order || a.name.localeCompare(b.name);
}

export function completeWorkbenchOrder(visible: string[], requested: string[]): string[] {
  const filtered = requested.filter((name) => visible.includes(name) && name !== "web");
  for (const name of visible) {
    if (!filtered.includes(name)) filtered.push(name);
  }
  return filtered;
}

export function applyMetaPatch(
  spaces: SpacesFile,
  name: string,
  patch: Partial<SpaceMeta>,
): SpaceMeta {
  const current = spaces.meta[name] ?? { displayName: name, order: 1000 };
  const next = { ...current, ...patch };
  spaces.meta[name] = next;
  if (!spaces.order.includes(name) && name !== "web") {
    spaces.order.push(name);
  }
  return next;
}

export function applyWorkbenchReorder(spaces: SpacesFile, ordered: string[]): void {
  spaces.order = ordered;
  ordered.forEach((name, index) => {
    const meta = spaces.meta[name] ?? { displayName: name, order: index };
    spaces.meta[name] = { ...meta, order: index };
  });
}

export function removeSpaceMeta(spaces: SpacesFile, name: string): void {
  delete spaces.meta[name];
  spaces.order = spaces.order.filter((item) => item !== name);
}
