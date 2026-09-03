import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { LocalePreference } from "@shared/types";
import {
  applyAppLocale,
  getLocale,
  htmlLang,
  t as translate,
  type AppLocale,
  type MessageKey,
  type MessageParams,
} from "@shared/i18n";

type Translate = (key: MessageKey, params?: MessageParams) => string;

interface I18nValue {
  t: Translate;
  locale: AppLocale;
  preference: LocalePreference;
  setPreference: (preference: LocalePreference) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<LocalePreference>("system");
  const [locale, setLocaleState] = useState<AppLocale>(() => getLocale());

  const setPreference = useCallback((next: LocalePreference) => {
    const resolved = applyAppLocale(next);
    setPreferenceState(next);
    setLocaleState(resolved);
  }, []);

  useEffect(() => {
    document.documentElement.lang = htmlLang(locale);
  }, [locale]);

  const t = useCallback<Translate>(
    (key, params) => translate(key, params, locale),
    [locale],
  );

  const value = useMemo(
    () => ({ t, locale, preference, setPreference }),
    [t, locale, preference, setPreference],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used within I18nProvider");
  return value;
}
