import { inferSpacesLocale, type SpacesLocale } from "../i18n";

/**
 * The words of the space dock.
 *
 * They are the host-side counterpart of the panel wording and live in one
 * place, so the portable host shell, the desktop host shell and the guide
 * panel never drift apart.
 */

/** Every string the space dock can show. */
export interface HostShellTexts {
  current: string;
  home: string;
  title: string;
  initialize: string;
  start: string;
  connecting: string;
  loading: string;
  manage: string;
  stopped: string;
  unsupported: string;
  unavailable: string;
  entry: string;
  initBody: string;
  startBody: string;
  /** Label suffix while a space waits on an approval or a question. */
  attention: string;
  /** Label suffix while the current space is working. */
  working: string;
}

const texts: Record<SpacesLocale, HostShellTexts> = {
  zh: { current:"当前应用", home:"Spaces 首页", title:"空间", initialize:"初始化 Spaces", start:"启动工作台", connecting:"正在连接空间服务", loading:"正在打开空间", manage:"打开空间管理", stopped:"该空间尚未运行，请在空间管理中启动。", unsupported:"当前环境不支持内嵌空间（需 http://127.0.0.1）。", unavailable:"空间服务不可用。", entry:"无法连接空间视图。", initBody:"初始化 Spaces 管理服务后即可使用空间栏。", startBody:"打开管理工作台；若尚未运行，请先启动。", attention:"等待处理", working:"正在工作" },
  en: { current:"Current application", home:"Spaces Home", title:"Spaces", initialize:"Initialize Spaces", start:"Start workbench", connecting:"Connecting to the space service", loading:"Opening space", manage:"Open space management", stopped:"This space is not running. Start it in space management.", unsupported:"Embedded spaces require http://127.0.0.1.", unavailable:"The space service is unavailable.", entry:"Could not connect to the space view.", initBody:"Initialize the Spaces service to use the space bar.", startBody:"Open the workbench, or start it if stopped.", attention:"Needs attention", working:"Working" },
};

/** The dock words for the current locale. */
export function hostTexts(locale: SpacesLocale = inferSpacesLocale()): HostShellTexts {
  return texts[locale];
}
