import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_HUB_SETTINGS,
  inferPackageSource,
  type HubSettings,
  type LocalePreference,
  type PackageSource,
  type ThemePreference,
} from "../shared/types";
import { t } from "../shared/i18n";
import { atomicWrite } from "./atomic";
import { assertNotRealHome } from "./home-guard";

function parsePackageSource(value: unknown): PackageSource {
  if (value === "china" || value === "official") return value;
  return inferPackageSource();
}

function parseLocale(value: unknown): LocalePreference {
  if (value === "system" || value === "en" || value === "zh") return value;
  return DEFAULT_HUB_SETTINGS.locale;
}

function parseTheme(value: unknown): ThemePreference {
  if (value === "system" || value === "light" || value === "dark") return value;
  return DEFAULT_HUB_SETTINGS.theme;
}

export function parseCatalogUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" ? trimmed : "";
  } catch {
    return "";
  }
}

export function settingsPath(dshHome: string): string {
  return join(dshHome, "hub", "settings.json");
}

export function readSettings(dshHome: string): HubSettings {
  assertNotRealHome(dshHome);
  const path = settingsPath(dshHome);
  if (!existsSync(path)) return { ...DEFAULT_HUB_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<HubSettings>;
    const portStart = Number(parsed.portStart) || DEFAULT_HUB_SETTINGS.portStart;
    const portEnd = Number(parsed.portEnd) || DEFAULT_HUB_SETTINGS.portEnd;
    return {
      portStart,
      portEnd: portEnd >= portStart ? portEnd : portStart,
      quitBehavior: parsed.quitBehavior === "keep" ? "keep" : "stop",
      packageSource: parsePackageSource(parsed.packageSource),
      locale: parseLocale(parsed.locale),
      theme: parseTheme(parsed.theme),
      catalogUrl: parseCatalogUrl(parsed.catalogUrl),
    };
  } catch {
    return { ...DEFAULT_HUB_SETTINGS };
  }
}

export function writeSettings(dshHome: string, settings: HubSettings): HubSettings {
  assertNotRealHome(dshHome);
  if (settings.portEnd < settings.portStart) {
    throw new Error(t("errors.portEndRange"));
  }
  if (settings.portStart < 1024 || settings.portEnd > 65535) {
    throw new Error(t("errors.portBounds"));
  }
  const next: HubSettings = {
    portStart: Math.floor(settings.portStart),
    portEnd: Math.floor(settings.portEnd),
    quitBehavior: settings.quitBehavior === "keep" ? "keep" : "stop",
    packageSource: parsePackageSource(settings.packageSource),
    locale: parseLocale(settings.locale),
    theme: parseTheme(settings.theme),
    catalogUrl: parseCatalogUrl(settings.catalogUrl),
  };
  atomicWrite(settingsPath(dshHome), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
