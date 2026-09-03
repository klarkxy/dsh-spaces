import { BrowserWindow, nativeTheme } from "electron";
import { WINDOW_BG, resolveColorScheme, type ColorScheme } from "../shared/theme";
import type { ThemePreference } from "../shared/types";

export function applyNativeTheme(preference: ThemePreference): ColorScheme {
  nativeTheme.themeSource = preference;
  const scheme = resolveColorScheme(preference, nativeTheme.shouldUseDarkColors);
  const background = WINDOW_BG[scheme];
  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor(background);
  }
  return scheme;
}

export function currentColorScheme(): ColorScheme {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}
