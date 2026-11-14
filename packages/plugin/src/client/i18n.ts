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
  loading: "Checking status…",
  blockedTitle: "Workbench unavailable",
  blockedBody: "Cannot open the workbench right now.",
  initTitle: "Initialize Spaces",
  initBody: "Set up Spaces for this Home and open the workbench.",
  initAction: "Initialize Spaces",
  initBusy: "Initializing Spaces…",
  enterTitle: "Enter workbench",
  enterBody: "Open the workbench, or start it if stopped.",
  enterAction: "Enter workbench",
  enterBusy: "Connecting…",
  startAction: "Start workbench",
  copyDetails: "Copy details",
  unavailable: "The workbench entry is not available yet.",
  roleFailed: "Could not check service status.",
} as const;

const guideZh: Record<keyof typeof guideEn, string> = {
  loading: "正在检查状态…",
  blockedTitle: "工作台不可用",
  blockedBody: "当前无法打开工作台。",
  initTitle: "初始化 Spaces",
  initBody: "初始化 Spaces 服务并打开工作台。",
  initAction: "初始化 Spaces",
  initBusy: "正在初始化 Spaces…",
  enterTitle: "进入工作台",
  enterBody: "打开工作台；若尚未运行，请先启动。",
  enterAction: "进入工作台",
  enterBusy: "正在连接…",
  startAction: "启动工作台",
  copyDetails: "复制详情",
  unavailable: "工作台入口暂不可用。",
  roleFailed: "无法检查服务状态。",
};

export const GUIDE_COPY: Record<SpacesLocale, Record<keyof typeof guideEn, string>> = {
  en: guideEn,
  zh: guideZh,
};

export type GuideCopyKey = keyof typeof guideEn;

export function guideText(locale: SpacesLocale, key: GuideCopyKey): string {
  return GUIDE_COPY[locale][key] ?? GUIDE_COPY.en[key];
}
