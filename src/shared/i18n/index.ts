import type { LocalePreference } from "../types";
import { en, type MessageKey, type Messages } from "./en";
import { zh } from "./zh";

export type AppLocale = "en" | "zh";
export type { MessageKey, Messages, LocalePreference };
export { en, zh };

export const APP_LOCALES = ["zh", "en"] as const satisfies readonly AppLocale[];

const dictionaries: Record<AppLocale, Messages> = { en, zh };

let currentLocale: AppLocale = inferAppLocale();

export function inferAppLocale(locale?: string): AppLocale {
  const value = locale ?? Intl.DateTimeFormat().resolvedOptions().locale;
  return /^zh([-_]|$)/i.test(value) ? "zh" : "en";
}

export function resolveLocale(preference: LocalePreference, systemLocale?: string): AppLocale {
  if (preference === "en" || preference === "zh") return preference;
  return inferAppLocale(systemLocale);
}

export function getLocale(): AppLocale {
  return currentLocale;
}

export function setLocale(locale: AppLocale): AppLocale {
  currentLocale = locale;
  return currentLocale;
}

export function applyAppLocale(preference: LocalePreference, systemLocale?: string): AppLocale {
  return setLocale(resolveLocale(preference, systemLocale));
}

export function htmlLang(locale: AppLocale = currentLocale): string {
  return locale === "zh" ? "zh-CN" : "en";
}

export type MessageParams = Record<string, string | number>;

export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

export function t(key: MessageKey, params?: MessageParams, locale: AppLocale = currentLocale): string {
  const template = dictionaries[locale][key] ?? dictionaries.en[key] ?? key;
  return interpolate(template, params);
}

export function catalogKeys(): MessageKey[] {
  return Object.keys(en) as MessageKey[];
}
