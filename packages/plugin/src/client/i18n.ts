/**
 * Panel copy for zh/en. Locale selection is documented in
 * `tasks/archive/pluginization-localization.md`: browser language, then a visible
 * 中文/English switch. Host `ctx.locale` is not used — the locale plugin is
 * not in this package's inject/peers, and declaring `locale:` on a slot
 * throws if the face is missing.
 */

export type SpacesLocale = "zh" | "en";

export function inferSpacesLocale(tag?: string): SpacesLocale {
  const value =
    tag ??
    firstNavigatorLanguage() ??
    (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().locale : "en");
  return /^zh([-_]|$)/i.test(value) ? "zh" : "en";
}

function firstNavigatorLanguage(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  const languages = navigator.languages;
  if (Array.isArray(languages) && typeof languages[0] === "string" && languages[0]) {
    return languages[0];
  }
  return navigator.language || undefined;
}

const guideEn = {
  loading: "Checking this Home…",
  blockedTitle: "Workbench unavailable",
  blockedBody: "This Home cannot open the workbench. Locks were not cleared.",
  initTitle: "Initialize Spaces",
  initBody:
    "This creates a dedicated manager and supervisor for this Home, then opens the authenticated workbench. It does not turn this space into the manager.",
  initAction: "Initialize Spaces",
  initBusy: "Initializing Spaces…",
  enterTitle: "Enter workbench",
  enterBody:
    "This space is not the manager. Open the authenticated workbench, or start it if it is stopped. Management stays on the dedicated manager profile.",
  enterAction: "Enter workbench",
  enterBusy: "Connecting…",
  startAction: "Start workbench",
  copyDetails: "Copy details",
  unavailable: "The workbench entry is not available yet.",
  roleFailed: "This Home could not be checked.",
} as const;

const guideZh: Record<keyof typeof guideEn, string> = {
  loading: "正在检查此 Home…",
  blockedTitle: "工作台不可用",
  blockedBody: "此 Home 无法打开工作台。未清除锁。",
  initTitle: "初始化 Spaces",
  initBody: "这将为本 Home 创建专用管理空间和监督进程，然后打开已认证的工作台。不会把当前空间变成管理空间。",
  initAction: "初始化 Spaces",
  initBusy: "正在初始化 Spaces…",
  enterTitle: "进入工作台",
  enterBody: "当前空间不是管理工作台。这里只会打开已认证的工作台入口；若工作台已停止，请启动它。管理能力仍在专用管理空间。",
  enterAction: "进入工作台",
  enterBusy: "正在连接…",
  startAction: "启动工作台",
  copyDetails: "复制详情",
  unavailable: "工作台入口暂不可用。",
  roleFailed: "无法检查此 Home。",
};

export const GUIDE_COPY: Record<SpacesLocale, Record<keyof typeof guideEn, string>> = {
  en: guideEn,
  zh: guideZh,
};

export type GuideCopyKey = keyof typeof guideEn;

export function guideText(locale: SpacesLocale, key: GuideCopyKey): string {
  return GUIDE_COPY[locale][key] ?? GUIDE_COPY.en[key];
}
