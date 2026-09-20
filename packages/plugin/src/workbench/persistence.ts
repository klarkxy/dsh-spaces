import type { ThemePreference } from "../../../../src/shared/types";
import { defaultWorkbenchLocale, type WorkbenchLocale } from "./i18n";

export const WORKBENCH_STORAGE_KEY = "dsh-spaces.workbench.ui";

export interface WorkbenchPersist {
  selectedId: string | null;
  locale: WorkbenchLocale;
  theme: ThemePreference;
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

function parseTheme(value: unknown): ThemePreference {
  if (value === "light" || value === "dark" || value === "system") return value;
  return "system";
}

export function persistWasEmpty(storage: StorageLike): boolean {
  const raw = storage.getItem(WORKBENCH_STORAGE_KEY);
  return raw === null || raw === "";
}

export function readPersist(storage: StorageLike): WorkbenchPersist {
  const raw = storage.getItem(WORKBENCH_STORAGE_KEY);
  if (!raw) return { selectedId: HOME_ID, locale: defaultWorkbenchLocale(), theme: "system" };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const locale: WorkbenchLocale = parsed.locale === "en" ? "en" : "zh";
    const selectedId =
      typeof parsed.selectedId === "string" && parsed.selectedId.length > 0
        ? parsed.selectedId
        : HOME_ID;
    return { selectedId, locale, theme: parseTheme(parsed.theme) };
  } catch {
    return { selectedId: HOME_ID, locale: defaultWorkbenchLocale(), theme: "system" };
  }
}

/** Persist only selectedId, locale and theme. Never store URLs, tokens, archives, paths or secrets. */
export function writePersist(storage: StorageLike, persist: WorkbenchPersist): void {
  const payload: WorkbenchPersist = {
    selectedId: persist.selectedId,
    locale: persist.locale === "en" ? "en" : "zh",
    theme: parseTheme(persist.theme),
  };
  storage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify(payload));
}

export function persistLooksSafe(raw: string | null): boolean {
  if (!raw) return true;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    return keys.every((key) => key === "selectedId" || key === "locale" || key === "theme");
  } catch {
    return false;
  }
}
