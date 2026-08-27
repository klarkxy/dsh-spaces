import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_HUB_SETTINGS, type HubSettings } from "../shared/types";
import { atomicWrite } from "./atomic";
import { assertNotRealHome } from "./home-guard";

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
    };
  } catch {
    return { ...DEFAULT_HUB_SETTINGS };
  }
}

export function writeSettings(dshHome: string, settings: HubSettings): HubSettings {
  assertNotRealHome(dshHome);
  if (settings.portEnd < settings.portStart) {
    throw new Error("portEnd must be >= portStart");
  }
  if (settings.portStart < 1024 || settings.portEnd > 65535) {
    throw new Error("port range must be within 1024–65535");
  }
  const next: HubSettings = {
    portStart: Math.floor(settings.portStart),
    portEnd: Math.floor(settings.portEnd),
    quitBehavior: settings.quitBehavior === "keep" ? "keep" : "stop",
  };
  atomicWrite(settingsPath(dshHome), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
