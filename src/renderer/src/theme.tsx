import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ThemePreference } from "@shared/types";
import { resolveColorScheme, type ColorScheme } from "@shared/theme";

interface ThemeValue {
  preference: ThemePreference;
  scheme: ColorScheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

function systemDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function paint(scheme: ColorScheme): void {
  document.documentElement.dataset.theme = scheme;
  document.documentElement.style.colorScheme = scheme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [scheme, setScheme] = useState<ColorScheme>(() => resolveColorScheme("system", systemDark()));

  const setPreference = useCallback((next: ThemePreference) => {
    const resolved = resolveColorScheme(next, systemDark());
    setPreferenceState(next);
    setScheme(resolved);
    paint(resolved);
  }, []);

  useEffect(() => {
    paint(scheme);
  }, [scheme]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (preference === "system") setScheme(media.matches ? "dark" : "light");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  const value = useMemo(
    () => ({ preference, scheme, setPreference }),
    [preference, scheme, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used within ThemeProvider");
  return value;
}
