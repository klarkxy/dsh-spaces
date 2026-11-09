/**
 * playwright-core engine adapter for the Supervisor's UI automation.
 *
 * Distribution: playwright-core is shipped inside the immutable component
 * payload, not bundled into the supervisor JS (the package loads its own
 * sub-paths dynamically and cannot survive esbuild) and not resolved through
 * node_modules — a staged payload under <toolsRoot>/components/<digest>/lib/
 * has no node_modules ancestors that contain it. The build copies the
 * checkout's pinned playwright-core@1.62.1 verbatim to
 * ./ui-engine/node_modules/playwright-core/ next to the supervisor bundle
 * (packages/supervisor/lib ↔ plugin lib/supervisor), and the loader imports
 * exactly that one URL. Dev-source runs (tests, tsx) anchor at the same
 * packaged layout instead — see THIS_BUNDLE_URL.
 *
 * Browser source: the user's installed system browser only — Edge or Chrome
 * via Playwright `channel`. Chromium is never downloaded. The channel is
 * chosen deterministically once per service epoch by findBrowserChannel():
 * "msedge" first, then "chrome", each checked at the platform's installed
 * executable locations. The first hit wins and is launched exactly once; a
 * launch failure is terminal for the epoch (no fallback to the other
 * channel — that would be a second launch attempt, i.e. a retry).
 */
/// <reference lib="dom" />
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ControlUiAct } from "../../../shared/control";
import { pageFunction, SCROLL_BY_SOURCE } from "./ui-shared";

export type UiBrowserChannel = "msedge" | "chrome";

/** Minimal structural surface the manager needs; stubs implement this. */
export interface UiLocator {
  click(options?: { button?: "left" | "right"; clickCount?: number; timeout?: number }): Promise<void>;
  fill(text: string, options?: { timeout?: number }): Promise<void>;
  press(key: string, options?: { timeout?: number }): Promise<void>;
  hover(options?: { timeout?: number }): Promise<void>;
  selectOption(value: string, options?: { timeout?: number }): Promise<void>;
  scrollIntoViewIfNeeded(options?: { timeout?: number }): Promise<void>;
  ariaSnapshot(options?: { mode?: "ai" | "default"; timeout?: number }): Promise<string>;
  innerText(options?: { timeout?: number }): Promise<string>;
  evaluate<T, A = undefined>(fn: string | ((el: Element, arg: A) => T), arg?: A, options?: { timeout?: number }): Promise<T>;
  screenshot(options?: { type?: "png" }): Promise<Buffer>;
  elementHandle(options?: { timeout?: number }): Promise<UiElementHandle | null>;
}

export interface UiElementHandle {
  asElement(): UiElementHandle;
}

export interface UiPage {
  locator(selector: string): UiLocator;
  goto(url: string, options?: { timeout?: number; waitUntil?: "domcontentloaded" | "load" }): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  ariaSnapshot(options?: { mode?: "ai" | "default"; timeout?: number }): Promise<string>;
  innerText(selector: string, options?: { timeout?: number }): Promise<string>;
  evaluate<T, A>(fn: string | ((arg: A) => T), arg: A, options?: { timeout?: number }): Promise<T>;
  mouse: {
    click(x: number, y: number, options?: { button?: "left" | "right"; clickCount?: number }): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  screenshot(options?: { type?: "png"; fullPage?: boolean }): Promise<Buffer>;
  waitForTimeout(ms: number): Promise<void>;
  isClosed(): boolean;
  on(event: "close" | "crash", listener: () => void): void;
  close(): Promise<void>;
}

export interface UiContext {
  newPage(): Promise<UiPage>;
  addCookies(cookies: Array<{ name: string; value: string; url: string; httpOnly: true; sameSite: "Strict" }>): Promise<void>;
  close(): Promise<void>;
  on(event: "close", listener: () => void): void;
}

export interface UiEngine {
  newContext(): Promise<UiContext>;
  close(): Promise<void>;
}

/** A chromium.launch compatible factory — injectable for tests. */
export type UiChromiumLauncher = {
  launch(options: { channel: string; headless: boolean; timeout?: number }): Promise<UiEngine>;
};

export type UiEngineLoader = () => Promise<UiChromiumLauncher>;

/**
 * The one module location the payload ships: the playwright-core ESM entry
 * copied next to this supervisor bundle by the build. `bundleUrl` is the URL
 * of the running bundle file (import.meta.url in the packaged build); a
 * different bundle URL anchors the same relative layout for tests.
 */
export const UI_ENGINE_ENTRY_REL = "./ui-engine/node_modules/playwright-core/index.mjs";

/**
 * Build an engine loader anchored at a supervisor bundle URL. There is one
 * candidate and no fallback: a missing or unreadable engine file is the
 * caller's terminal engine-unavailable, never a lookup elsewhere.
 */
export function uiEngineLoader(bundleUrl: string): UiEngineLoader {
  const entry = new URL(UI_ENGINE_ENTRY_REL, bundleUrl);
  return async () => {
    const path = fileURLToPath(entry);
    if (!existsSync(path)) {
      throw new Error(`playwright-core payload is missing at ${UI_ENGINE_ENTRY_REL} next to this supervisor bundle`);
    }
    const mod = await import(entry.href);
    return mod.chromium as unknown as UiChromiumLauncher;
  };
}

/**
 * The module URL the default loader anchors at. A built bundle lives next to
 * its ui-engine directory directly; the .ts source runs during dev/tests and
 * anchors at the same packaged layout in packages/supervisor/lib — one fixed
 * position in each shape, never a lookup chain.
 */
const THIS_BUNDLE_URL = import.meta.url.endsWith(".ts")
  ? new URL("../../../../packages/supervisor/lib/index.js", import.meta.url).href
  : import.meta.url;

/** The default loader: the payload's own playwright-core, next to this bundle. */
export const playwrightCoreLoader: UiEngineLoader = uiEngineLoader(THIS_BUNDLE_URL);

/**
 * Deterministic channel choice: "msedge" first at the platform's installed
 * locations, "chrome" second; the first existing executable wins and the
 * result is probed once per service epoch. `exists` is injectable so tests
 * can exercise every platform without the real files.
 */
export function findBrowserChannel(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): UiBrowserChannel | undefined {
  const candidates = browserChannelCandidates(platform, env);
  for (const channel of ["msedge", "chrome"] as const) {
    for (const path of candidates[channel]) {
      if (exists(path)) return channel;
    }
  }
  return undefined;
}

/** Installed executable locations per channel, most specific first. */
export function browserChannelCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Record<UiBrowserChannel, string[]> {
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const edge = roots.map((root) => join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
    const chrome = roots.map((root) => join(root, "Google", "Chrome", "Application", "chrome.exe"));
    return { msedge: edge, chrome: chrome };
  }
  if (platform === "darwin") {
    return {
      msedge: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
      chrome: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    };
  }
  const onPath = (names: string[], pathEnv: string | undefined): string[] => {
    const out: string[] = [];
    // POSIX PATH is always colon-separated and slash-joined, regardless of
    // the platform this supervisor itself runs on (tests simulate linux).
    for (const dir of (pathEnv ?? "").split(":").filter(Boolean)) {
      for (const name of names) out.push(`${dir}/${name}`);
    }
    return out;
  };
  return {
    msedge: onPath(["microsoft-edge", "microsoft-edge-stable", "msedge"], env.PATH),
    chrome: onPath(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"], env.PATH),
  };
}

/** aria-ref selector the page resolves against the last aria snapshot. */
export function ariaRefSelector(ref: string): string {
  return `aria-ref=${ref}`;
}

/** Playwright engine wiring shared by every UiAutomationManager session. */
export class PlaywrightUiEngine {
  private constructor(
    private readonly launcher: UiChromiumLauncher,
    private readonly channel: UiBrowserChannel,
  ) {}

  /** Resolve the module and the channel; either failure is terminal for the caller. */
  static async create(loader: UiEngineLoader = playwrightCoreLoader): Promise<PlaywrightUiEngine | undefined> {
    const channel = findBrowserChannel();
    if (!channel) return undefined;
    const launcher = await loader();
    return new PlaywrightUiEngine(launcher, channel);
  }

  async launch(timeoutMs: number): Promise<UiEngine> {
    // One launch against the chosen channel. A failure propagates; there is
    // no second channel attempt — that would be a retry under another name.
    return await this.launcher.launch({ channel: this.channel, headless: true, timeout: timeoutMs });
  }
}

const SCROLL_BY_FN = pageFunction<[Element, number], unknown>(SCROLL_BY_SOURCE);

/** Act dispatch against a live page; timeoutMs applies per Playwright call. */
export async function runActOnPage(page: UiPage, act: ControlUiAct, baseUrl: string, timeoutMs: number): Promise<void> {
  const opt = { timeout: timeoutMs };
  switch (act.kind) {
    case "click":
      if (act.ref) {
        await page.locator(ariaRefSelector(act.ref)).click({
          button: act.button ?? "left",
          clickCount: act.clickCount ?? 1,
          timeout: timeoutMs,
        });
      } else {
        await page.mouse.click(act.x!, act.y!, {
          button: act.button ?? "left",
          clickCount: act.clickCount ?? 1,
        });
      }
      return;
    case "type":
      // fill semantics: clear then insert the text; no per-key events.
      await page.locator(ariaRefSelector(act.ref)).fill(act.text, opt);
      return;
    case "press":
      if (act.ref) await page.locator(ariaRefSelector(act.ref)).press(act.key, opt);
      else await page.locator("body").press(act.key, opt);
      return;
    case "scroll":
      if (act.ref) {
        const locator = page.locator(ariaRefSelector(act.ref));
        await locator.scrollIntoViewIfNeeded(opt);
        // Rebuilt from the verbatim constant: toString() is exactly the
        // source, so the page gets clean, helper-free code.
        await locator.evaluate(SCROLL_BY_FN, act.deltaY, opt);
      } else {
        await page.mouse.wheel(0, act.deltaY);
      }
      return;
    case "select":
      await page.locator(ariaRefSelector(act.ref)).selectOption(act.value, opt);
      return;
    case "hover":
      await page.locator(ariaRefSelector(act.ref)).hover(opt);
      return;
    case "navigate":
      await page.goto(new URL(act.path, baseUrl).href, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
      return;
    case "wait":
      await page.waitForTimeout(act.ms);
      return;
  }
}
