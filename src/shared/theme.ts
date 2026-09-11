import type { ThemePreference } from "./types";

export type { ThemePreference };
export type ColorScheme = "light" | "dark";

export const WINDOW_BG: Record<ColorScheme, string> = {
  dark: "#0b1016",
  light: "#e7eef3",
};

export function resolveColorScheme(
  preference: ThemePreference,
  systemDark?: boolean,
): ColorScheme {
  if (preference === "light" || preference === "dark") return preference;
  if (systemDark === true) return "dark";
  if (systemDark === false) return "light";
  if (typeof matchMedia === "function") {
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "dark";
}
