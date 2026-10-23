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
}

const texts: Record<SpacesLocale, HostShellTexts> = {
  zh: { current:"当前应用", home:"Spaces 首页", title:"空间", initialize:"初始化 Spaces", start:"启动工作台", connecting:"正在连接空间服务", loading:"正在打开空间", manage:"打开空间管理", stopped:"该空间尚未运行。请在空间管理中明确启动。", unsupported:"当前宿主尚未提供兼容的嵌入通道。本版内置通道需要 http://127.0.0.1；没有启动或修改宿主。", unavailable:"空间服务或宿主身份不可用。当前应用仍可继续使用。", entry:"空间视图未能完成认证或握手。该次操作已失败，未自动重连。", initBody:"在当前应用中使用空间栏。初始化只准备 Spaces 的独立管理服务，不接管当前应用。", startBody:"当前空间不是管理工作台。这里只会打开已认证的工作台入口；若工作台已停止，请启动它。管理能力仍在专用管理空间。" },
  en: { current:"Current application", home:"Spaces Home", title:"Spaces", initialize:"Initialize Spaces", start:"Start workbench", connecting:"Connecting to the space service", loading:"Opening space", manage:"Open space management", stopped:"This space is not running. Start it explicitly in space management.", unsupported:"This host has no compatible embedding transport. The bundled transport requires http://127.0.0.1. No host was started or modified.", unavailable:"The space service or host identity is unavailable. The current application remains usable.", entry:"The space view could not authenticate or complete its handshake. This operation failed; it was not reconnected automatically.", initBody:"Use the space rail in this application. Initialization prepares the independent Spaces manager; it does not take over this application.", startBody:"This space is not the manager. Open the authenticated workbench, or start it if it is stopped. Management stays on the dedicated manager profile." },
};

/** The dock words for the current locale. */
export function hostTexts(locale: SpacesLocale = inferSpacesLocale()): HostShellTexts {
  return texts[locale];
}
