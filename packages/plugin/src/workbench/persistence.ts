import { defaultWorkbenchLocale, type WorkbenchLocale } from "./i18n";

export const WORKBENCH_STORAGE_KEY = "dsh-spaces.workbench.ui";

export interface WorkbenchPersist {
  selectedId: string | null;
  locale: WorkbenchLocale;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const HOME_ID = "__home__";

export function homeSelectionId(): string {
  return HOME_ID;
}

export function isHomeSelection(id: string | null): boolean {
  return id === null || id === HOME_ID;
}

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

export function defaultStorage(): StorageLike {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    /* ignore */
  }
  return memoryStorage();
}

export function readPersist(storage: StorageLike): WorkbenchPersist {
  const raw = storage.getItem(WORKBENCH_STORAGE_KEY);
  if (!raw) return { selectedId: HOME_ID, locale: defaultWorkbenchLocale() };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const locale: WorkbenchLocale = parsed.locale === "en" ? "en" : "zh";
    const selectedId =
      typeof parsed.selectedId === "string" && parsed.selectedId.length > 0
        ? parsed.selectedId
        : HOME_ID;
    return { selectedId, locale };
  } catch {
    return { selectedId: HOME_ID, locale: defaultWorkbenchLocale() };
  }
}

/** Persist only selectedId and locale. Never store URLs, tokens, origins or channels. */
export function writePersist(storage: StorageLike, persist: WorkbenchPersist): void {
  const payload: WorkbenchPersist = {
    selectedId: persist.selectedId,
    locale: persist.locale === "en" ? "en" : "zh",
  };
  storage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify(payload));
}

export function persistLooksSafe(raw: string | null): boolean {
  if (!raw) return true;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    return keys.every((key) => key === "selectedId" || key === "locale");
  } catch {
    return false;
  }
}
