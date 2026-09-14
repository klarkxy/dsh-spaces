#!/usr/bin/env node
/**
 * Record first-cut Spaces usage footage with Playwright (real Host UI).
 *
 * Reuses startThemeProfile from verify-spaces-themes.mjs against the
 * existing theme-acceptance Home. Does not rebuild that Home, does not
 * touch production ~/.dsh, does not send model messages, and does not
 * install packages. This module does not start Host/browser when imported.
 *
 * Run:
 *   "D:/Program Files/nodejs/node.exe" scripts/record-spaces-demo.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  HOST,
  PORT_MS,
  redact,
  refuseRealHome,
  writeJson,
  resolveNode,
  resolvePnpmCjs,
  dshBin,
  cliVersion,
  writePnpmShim,
  stopOwned,
  waitPortClosed,
  sessionCookie,
  rpc,
  assertRpcOk,
} from "./verify-spaces-distribution.mjs";
import { startThemeProfile, readThemeProof } from "./verify-spaces-themes.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = join(REPO, ".sandbox", "spaces-themes-acceptance", "home");
const ARTIFACT = join(REPO, ".sandbox", "spaces-demo-video");
const CHAPTER_DIR = join(ARTIFACT, "chapters");
const MARK_DIR = join(ARTIFACT, "marks");
const RAW_DIR = join(ARTIFACT, "raw");
const LOG_DIR = join(ARTIFACT, "logs");
const RESULT_PATH = join(ARTIFACT, "results.json");
const TIMELINE_PATH = join(ARTIFACT, "timeline.json");
const DEFAULT_PLAYWRIGHT =
  "C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
const DEFAULT_BIN =
  "C:/Users/admin/AppData/Local/Temp/spaces-runtime-install-fIEaas/versions/0.1.5-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js";
const FFMPEG = "C:/Users/admin/AppData/Local/ms-playwright/ffmpeg-1011/ffmpeg-win64.exe";
const XP_WORKSPACE = join(REPO, ".sandbox", "spaces-themes-acceptance", "xp-empty-workspace");
const REAL_HOME = resolve("C:/Users/admin/.dsh");

const NAV_MS = 30_000;
const UI_MS = 45_000;
const CREATE_MS = 420_000;
const VIDEO = { width: 1920, height: 1080 };
const ACTION_MS = 1_100;
const HOLD_MS = 4_000;
const CATPPUCCIN_HOLD_MS = 3_000;

const owned = [];
const chapters = [];
const errors = [];
const unrecorded = [];

function info(m) {
  console.log(`INFO  ${redact(m)}`);
}

function failNote(m) {
  const text = redact(m);
  errors.push(text);
  console.error(`ERR   ${text}`);
}

function themeEnvHomeGuard() {
  refuseRealHome(HOME);
  if (HOME.toLowerCase().startsWith(REAL_HOME.toLowerCase() + sep) || resolve(HOME).toLowerCase() === REAL_HOME.toLowerCase()) {
    throw new Error("refusing real ~/.dsh");
  }
}

async function waitUntil(check, timeoutMs, label) {
  const start = Date.now();
  let last = "not tried";
  while (Date.now() - start < timeoutMs) {
    try {
      if (await check()) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms (${redact(last)})`);
}

function videoMeta(file) {
  const st = existsSync(file) ? statSync(file) : null;
  const meta = {
    path: file,
    bytes: st?.size ?? 0,
    width: null,
    height: null,
    durationSec: null,
  };
  if (!st || !existsSync(FFMPEG)) return meta;
  const probe = spawnSync(FFMPEG, ["-i", file], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  const text = `${probe.stdout || ""}${probe.stderr || ""}`;
  const dur = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dur) {
    meta.durationSec = Number((Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])).toFixed(3));
  }
  const dim = text.match(/, (\d{2,5})x(\d{2,5})/);
  if (dim) {
    meta.width = Number(dim[1]);
    meta.height = Number(dim[2]);
  }
  return meta;
}

function makeClock() {
  const t0 = Date.now();
  const sec = () => Number(((Date.now() - t0) / 1000).toFixed(3));
  return { t0, sec };
}

async function pause(ms = ACTION_MS) {
  await delay(ms);
}

async function hold(ms = HOLD_MS) {
  await delay(ms);
}

async function skipOnboarding(page) {
  await waitUntil(async () => !new URL(page.url()).searchParams.has("token"), NAV_MS, "token redirect");
  const deadline = Date.now() + UI_MS;
  let deferred = false;
  while (Date.now() < deadline) {
    const intro = page.getByRole("button", { name: /^(Continue|继续)$/ });
    if (await intro.isVisible().catch(() => false)) {
      await pause();
      await intro.click();
      await pause();
      continue;
    }
    const deferKey = page.getByRole("button", { name: /稍后配置|set up later|configure later/i });
    if (await deferKey.isVisible().catch(() => false)) {
      await pause();
      await deferKey.click();
      deferred = true;
      await pause();
      continue;
    }
    const keyDialog = await page.getByText(/添加一个 API Key|输入 API 密钥/i).first().isVisible().catch(() => false);
    if (keyDialog) {
      await delay(300);
      continue;
    }
    const ready = await page.getByText(/^(New Session|新会话)$/i).first().isVisible().catch(() => false);
    const xp = (await page.locator("[data-xp-desktop], #dsh-xp-taskbar").count()) > 0;
    const failed = await page.getByText(/Failed to load plugins|插件加载失败/i).first().isVisible().catch(() => false);
    if (ready || xp || failed) {
      await delay(800);
      const lateDefer = page.getByRole("button", { name: /稍后配置|set up later|configure later/i });
      const lateKey = await page.getByText(/添加一个 API Key|输入 API 密钥/i).first().isVisible().catch(() => false);
      if ((await lateDefer.isVisible().catch(() => false)) || lateKey) continue;
      return deferred ? "deferred-key" : "already-ready";
    }
    await delay(300);
  }
  return deferred ? "deferred-key" : "timeout";
}

async function openSpaces(page) {
  await pause();
  await page.getByRole("button", { name: "空间", exact: true }).click();
  await page.getByRole("heading", { name: "空间", exact: true }).waitFor({ timeout: UI_MS });
  await page.locator(".dsh-spaces").waitFor({ timeout: UI_MS });
}

async function selectListedSpace(page, name) {
  const item = page.locator(".dsh-spaces-item").filter({
    has: page.locator(".dsh-spaces-item-name", { hasText: new RegExp(`^${name}$`) }),
  });
  await item.first().waitFor({ timeout: UI_MS });
  await pause();
  await item.first().click();
  await page.locator(".dsh-spaces-detail-title").waitFor({ timeout: UI_MS });
}

function gotoUrl(launchUrl, hash) {
  const target = new URL(launchUrl.href);
  if (hash) target.hash = hash;
  return target.href;
}

async function withThemeHost(nodeExe, bin, home, tooling, profile, fn) {
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `${profile}.log`);
  info(`start Host profile=${profile}`);
  const started = await startThemeProfile(nodeExe, bin, home, tooling, profile, logPath);
  owned.push(started);
  try {
    const cookie = await sessionCookie(started.launchUrl);
    return await fn({ ...started, cookie, profile });
  } finally {
    await stopOwned(started.child);
    await waitPortClosed(started.port, PORT_MS);
    info(`Host ${profile} port :${started.port} closed`);
    const idx = owned.indexOf(started);
    if (idx >= 0) owned.splice(idx, 1);
  }
}

async function recordChapter(browser, launchUrl, chapter) {
  mkdirSync(CHAPTER_DIR, { recursive: true });
  mkdirSync(MARK_DIR, { recursive: true });
  mkdirSync(RAW_DIR, { recursive: true });
  const dest = join(CHAPTER_DIR, `${chapter.id}.webm`);
  const marks = [];
  const pageErrors = [];
  const clock = makeClock();
  const context = await browser.newContext({
    viewport: VIDEO,
    screen: VIDEO,
    deviceScaleFactor: 1,
    locale: "zh-CN",
    recordVideo: { dir: RAW_DIR, size: VIDEO },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(UI_MS);
  page.on("pageerror", (error) => pageErrors.push(redact(error.message)));
  const mark = async (action, extra = {}) => {
    const tSec = clock.sec();
    const shotName = `${chapter.id}-${String(marks.length + 1).padStart(2, "0")}-${action.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40)}.png`;
    const shotPath = join(MARK_DIR, shotName);
    try {
      await page.screenshot({ path: shotPath, fullPage: false });
    } catch (error) {
      failNote(`${chapter.id} screenshot ${action}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const row = { tSec, action, screenshot: shotPath, ...extra };
    marks.push(row);
    info(`${chapter.id} @${tSec}s ${action}`);
    return row;
  };
  const rec = { page, context, clock, mark, marks, pageErrors, launchUrl };
  let trimStartSec = null;
  let trimEndSec = null;
  let status = "recorded";
  let detail = {};
  try {
    const result = await chapter.run(rec);
    detail = result && typeof result === "object" ? result : {};
    trimStartSec = detail.trimStartSec ?? null;
    trimEndSec = detail.trimEndSec ?? clock.sec();
    if (detail.unrecorded) {
      status = "partial";
      unrecorded.push(`${chapter.id}: ${detail.unrecorded}`);
    }
  } catch (error) {
    status = "error";
    const message = redact(error instanceof Error ? error.message : String(error));
    failNote(`${chapter.id}: ${message}`);
    detail = { ...detail, error: message };
    await mark("failure").catch(() => undefined);
    trimEndSec = clock.sec();
  }
  const video = page.video();
  await context.close();
  if (video) {
    await video.saveAs(dest);
  }
  const meta = videoMeta(dest);
  const row = {
    id: chapter.id,
    title: chapter.title,
    status,
    video: meta,
    trimStartSec,
    trimEndSec,
    recordedWallSec: clock.sec(),
    marks,
    pageErrors,
    ...detail,
  };
  chapters.push(row);
  return row;
}

async function chapterZhongguoWelcome(rec) {
  await rec.page.goto(gotoUrl(rec.launchUrl, "theme=zhuqing-light"), { waitUntil: "domcontentloaded", timeout: NAV_MS });
  await rec.mark("goto");
  await skipOnboarding(rec.page);
  const trimStartSec = rec.clock.sec();
  await rec.page.getByText(/^(New Session|新会话)$/i).first().waitFor({ timeout: UI_MS });
  const proof = await readThemeProof(rec.page);
  await rec.mark("welcome-new-session", { proof });
  await hold();
  await openSpaces(rec.page);
  await waitUntil(async () => {
    const text = await rec.page.locator(".dsh-spaces").innerText();
    return text.includes("theme-zhongguo") && text.includes("宿主") && text.includes("notes");
  }, UI_MS, "Spaces list + host badge");
  await rec.mark("spaces-list-host");
  await hold();
  const trimEndSec = rec.clock.sec();
  return { trimStartSec, trimEndSec, proof, hostVisible: true };
}

async function chapterZhongguoCreate(rec, created) {
  await rec.page.goto(gotoUrl(rec.launchUrl, "theme=zhuqing-light"), { waitUntil: "domcontentloaded", timeout: NAV_MS });
  await rec.mark("goto");
  await skipOnboarding(rec.page);
  const trimStartSec = rec.clock.sec();
  await rec.page.getByText(/^(New Session|新会话)$/i).first().waitFor({ timeout: UI_MS });
  await openSpaces(rec.page);
  await rec.mark("spaces-before-create");
  const form = rec.page.getByRole("form", { name: "创建空间", exact: true });
  await form.getByLabel("名称", { exact: true }).waitFor({ timeout: UI_MS });
  await pause();
  await form.getByLabel("名称", { exact: true }).fill(created.name);
  await pause();
  await form.getByLabel("显示名称（可选）", { exact: true }).fill(created.displayName);
  await rec.mark("create-form-filled", { name: created.name, displayName: created.displayName });
  await pause();
  await form.getByRole("button", { name: "创建", exact: true }).click();
  await rec.mark("create-clicked");
  await rec.page.getByRole("heading", { name: created.displayName, exact: true }).waitFor({ timeout: CREATE_MS });
  await rec.mark("create-success");
  await hold();
  const verify = rec.page.getByRole("button", { name: "验证隔离", exact: true });
  await verify.waitFor({ timeout: UI_MS });
  await pause();
  await verify.click();
  await rec.page.getByText("隔离与当前组合配置一致。", { exact: true }).waitFor({ timeout: UI_MS });
  await rec.mark("verify-passed");
  await hold();
  const trimEndSec = rec.clock.sec();
  created.ok = true;
  created.verify = "passed";
  return { trimStartSec, trimEndSec, created };
}

async function chapterZhongguoPluginsI18n(rec) {
  await rec.page.goto(gotoUrl(rec.launchUrl, "theme=zhuqing-light"), { waitUntil: "domcontentloaded", timeout: NAV_MS });
  await rec.mark("goto");
  await skipOnboarding(rec.page);
  const trimStartSec = rec.clock.sec();
  await rec.page.getByText(/^(New Session|新会话)$/i).first().waitFor({ timeout: UI_MS });
  await openSpaces(rec.page);
  await selectListedSpace(rec.page, "theme-zhongguo");
  await rec.page.getByText("dsh-theme-plugin", { exact: true }).waitFor({ timeout: UI_MS });
  await rec.mark("host-theme-plugins");
  await hold();
  await selectListedSpace(rec.page, "theme-eternalnight");
  await rec.page.getByText("@eternalnight/dsh-theme", { exact: true }).waitFor({ timeout: UI_MS });
  await rec.mark("eternalnight-plugins-from-zhongguo-host");
  await hold();
  await pause();
  await rec.page.getByRole("button", { name: "English", exact: true }).click();
  await rec.page.getByRole("heading", { name: "Spaces", exact: true }).waitFor({ timeout: UI_MS });
  await rec.page.getByRole("heading", { name: "Plugins", exact: true }).waitFor({ timeout: UI_MS });
  await rec.mark("locale-english");
  await hold();
  await pause();
  await rec.page.getByRole("button", { name: "中文", exact: true }).click();
  await rec.page.getByRole("heading", { name: "空间", exact: true }).waitFor({ timeout: UI_MS });
  await rec.page.getByRole("heading", { name: "插件", exact: true }).waitFor({ timeout: UI_MS });
  await rec.mark("locale-zh");
  await hold();
  const trimEndSec = rec.clock.sec();
  return { trimStartSec, trimEndSec };
}

async function chapterEternalNight(rec) {
  await rec.page.goto(gotoUrl(rec.launchUrl), { waitUntil: "domcontentloaded", timeout: NAV_MS });
  await rec.mark("goto");
  await skipOnboarding(rec.page);
  const trimStartSec = rec.clock.sec();
  await rec.page.getByText(/^(New Session|新会话)$/i).first().waitFor({ timeout: UI_MS });
  await waitUntil(async () => rec.page.locator(".dt-bg img, .dt-bg video").count().then((n) => n > 0), UI_MS, "eternalnight wallpaper");
  const proof = await readThemeProof(rec.page);
  await rec.mark("wallpaper-welcome", { proof });
  await hold();
  await openSpaces(rec.page);
  await waitUntil(async () => {
    const text = await rec.page.locator(".dsh-spaces").innerText();
    return text.includes("theme-eternalnight") && text.includes("宿主");
  }, UI_MS, "EternalNight Spaces list");
  await rec.mark("spaces-on-wallpaper-host");
  await hold();
  const trimEndSec = rec.clock.sec();
  return { trimStartSec, trimEndSec, proof };
}

async function chapterXp(rec) {
  await rec.page.goto(gotoUrl(rec.launchUrl), { waitUntil: "domcontentloaded", timeout: NAV_MS });
  await rec.mark("goto");
  await skipOnboarding(rec.page);
  await waitUntil(
    async () => rec.page.locator("[data-xp-desktop], #dsh-xp-taskbar").count().then((n) => n > 0),
    UI_MS,
    "XP desktop",
  );
  await waitUntil(
    async () => {
      const defer = rec.page.getByRole("button", { name: /稍后配置|set up later|configure later/i });
      if (await defer.isVisible().catch(() => false)) {
        await defer.click().catch(() => undefined);
        return false;
      }
      const keyDialog = await rec.page.getByText(/添加一个 API Key|输入 API 密钥/i).first().isVisible().catch(() => false);
      return !keyDialog;
    },
    UI_MS,
    "XP API-key dialog dismissed",
  );
  const trimStartSec = rec.clock.sec();
  const proof = await readThemeProof(rec.page);
  await rec.mark("xp-desktop", { proof });
  await hold();
  await pause();
  await rec.page.getByText("我的工作区", { exact: true }).first().dblclick();
  await rec.mark("xp-open-workspaces");
  await hold(2_000);
  const ws = rec.page.locator('.xp-grid-item[data-kind="ws"]').first();
  if (await ws.isVisible().catch(() => false)) {
    await pause();
    await ws.dblclick();
    await rec.mark("xp-open-workspace-folder");
    await hold(2_000);
  }
  const neu = rec.page.locator('.xp-grid-item[data-kind="new"]');
  if (await neu.first().isVisible().catch(() => false)) {
    await pause();
    await neu.first().dblclick();
    await rec.mark("xp-new-session");
  }
  await rec.page.locator(".xp-window iframe").waitFor({ timeout: UI_MS });
  const frame = rec.page.frameLocator(".xp-window iframe").last();
  const later = frame.getByRole("button", { name: /稍后配置|set up later|configure later/i });
  try {
    await later.waitFor({ timeout: UI_MS });
    await pause();
    await later.click();
    await later.waitFor({ state: "hidden", timeout: UI_MS });
  } catch {
    /* iframe may already be past the key dialog */
  }
  await frame.locator('[contenteditable="true"]').first().waitFor({ timeout: UI_MS });
  await waitUntil(
    async () => !(await frame.getByText(/添加一个 API Key|输入 API 密钥/i).first().isVisible().catch(() => false)),
    UI_MS,
    "iframe API-key dialog dismissed",
  );
  await rec.mark("xp-session-iframe");
  await hold();
  const frameSpacesVisible = await frame.getByRole("button", { name: "空间", exact: true }).isVisible().catch(() => false);
  const occlusion = await rec.page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")].filter((el) => el.textContent?.trim() === "空间");
    return buttons.map((el) => {
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      const top = document.elementFromPoint(x, y);
      return {
        box: { x: r.x, y: r.y, w: r.width, h: r.height },
        topTag: top?.tagName ?? null,
        topId: top?.id ?? null,
        covered: Boolean(top && top !== el && !el.contains(top)),
      };
    });
  });
  await rec.mark("xp-spaces-unreachable-observed", { frameSpacesVisible, occlusion, forcedClick: false });
  await hold();
  const trimEndSec = rec.clock.sec();
  return {
    trimStartSec,
    trimEndSec,
    proof,
    spacesReachable: Boolean(frameSpacesVisible),
    frameSpacesVisible,
    occlusion,
    forcedClick: false,
  };
}

async function chapterCatppuccin(rec) {
  await rec.page.goto(gotoUrl(rec.launchUrl), { waitUntil: "domcontentloaded", timeout: NAV_MS });
  await rec.mark("goto");
  await waitUntil(
    async () => rec.page.getByText(/Failed to load plugins|插件加载失败/i).first().isVisible().catch(() => false),
    UI_MS,
    "Catppuccin plugin failure",
  );
  const trimStartSec = rec.clock.sec();
  await rec.mark("plugin-load-failure");
  await hold(CATPPUCCIN_HOLD_MS);
  const trimEndSec = rec.clock.sec();
  return { trimStartSec, trimEndSec, limitation: true };
}

async function stopLeftovers() {
  for (const started of [...owned]) {
    await stopOwned(started.child).catch(() => undefined);
    if (started.port) await waitPortClosed(started.port, PORT_MS).catch(() => undefined);
  }
  owned.length = 0;
}

async function main() {
  mkdirSync(ARTIFACT, { recursive: true });
  mkdirSync(CHAPTER_DIR, { recursive: true });
  mkdirSync(MARK_DIR, { recursive: true });
  mkdirSync(RAW_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  themeEnvHomeGuard();
  if (!existsSync(join(HOME, "profiles", "theme-zhongguo", "package.json"))) {
    throw new Error("dedicated theme Home missing theme-zhongguo; refuse to rebuild");
  }

  process.env.DSH_TEST_BIN = process.env.DSH_TEST_BIN?.trim() || DEFAULT_BIN;
  const nodeExe = resolveNode();
  const bin = dshBin();
  const version = cliVersion(bin);
  info(`CLI ${version} at ${bin}`);
  info(`node ${nodeExe}`);
  const pnpmCjs = resolvePnpmCjs();
  const session = mkdtempSync(join(tmpdir(), "spaces-demo-tooling-"));
  const sessionRel = relative(tmpdir(), session);
  if (isAbsolute(sessionRel) || sessionRel.startsWith("..")) {
    throw new Error("session root escaped tmpdir");
  }
  const tooling = {
    shim: join(session, "bin"),
    pnpmHome: join(session, "pnpm-home"),
    store: join(session, "store"),
    cache: join(session, "npm-cache"),
  };
  mkdirSync(tooling.pnpmHome, { recursive: true });
  mkdirSync(tooling.store, { recursive: true });
  mkdirSync(tooling.cache, { recursive: true });
  writePnpmShim(tooling.shim, nodeExe, pnpmCjs);

  const playwrightModule = process.env.DSH_TEST_PLAYWRIGHT_MODULE || DEFAULT_PLAYWRIGHT;
  const { chromium } = await import(pathToFileURL(join(playwrightModule, "index.mjs")).href);

  const requested = (process.env.DSH_TEST_DEMO_CHAPTERS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const want = (id) => !requested.length || requested.includes(id);
  const prior = existsSync(RESULT_PATH) ? JSON.parse(readFileSync(RESULT_PATH, "utf8")) : null;

  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(8, 14);
  const created = prior?.createdProfile?.ok
    ? { ...prior.createdProfile }
    : {
        name: `video-demo-${stamp}`,
        displayName: `演示空间 ${stamp}`,
        ok: false,
        verify: null,
      };
  if (!created.ok && existsSync(join(HOME, "profiles", created.name, "package.json"))) {
    created.name = `video-demo-${Date.now().toString(36).slice(-6)}`;
    created.displayName = `演示空间 ${created.name.slice("video-demo-".length)}`;
  }

  const playwrightHref = pathToFileURL(join(playwrightModule, "index.mjs")).href;
  info(`Playwright ${playwrightHref}`);
  let browser;

  try {
    browser = await chromium.launch({ headless: true, timeout: NAV_MS });

    if (want("01-zhongguo-welcome-spaces") || want("02-zhongguo-create-verify") || want("03-zhongguo-plugins-i18n")) {
    await withThemeHost(nodeExe, bin, HOME, tooling, "theme-zhongguo", async (host) => {
      info(`zhongguo URL ${redact(host.launchUrl.href)}`);
      if (want("01-zhongguo-welcome-spaces")) {
      await recordChapter(browser, host.launchUrl, {
        id: "01-zhongguo-welcome-spaces",
        title: "竹青欢迎页与 Spaces 列表/宿主标记",
        run: chapterZhongguoWelcome,
      });
      }
      if (want("02-zhongguo-create-verify")) {
      try {
        await recordChapter(browser, host.launchUrl, {
          id: "02-zhongguo-create-verify",
          title: "UI 创建唯一演示空间并验证隔离",
          run: (rec) => chapterZhongguoCreate(rec, created),
        });
      } catch (error) {
        created.ok = false;
        created.error = redact(error instanceof Error ? error.message : String(error));
        unrecorded.push("02-zhongguo-create-verify continued as chapter error");
      }
      }
      if (want("03-zhongguo-plugins-i18n")) {
      await recordChapter(browser, host.launchUrl, {
        id: "03-zhongguo-plugins-i18n",
        title: "已有主题 profile 插件清单与中英切换",
        run: chapterZhongguoPluginsI18n,
      });
      }
    });
    }

    if (want("04-eternalnight-wallpaper-spaces")) {
    await withThemeHost(nodeExe, bin, HOME, tooling, "theme-eternalnight", async (host) => {
      await recordChapter(browser, host.launchUrl, {
        id: "04-eternalnight-wallpaper-spaces",
        title: "EternalNight 壁纸与 Spaces",
        run: chapterEternalNight,
      });
    });
    }

    if (want("05-xp-desktop-session")) {
    await withThemeHost(nodeExe, bin, HOME, tooling, "theme-xp", async (host) => {
      try {
        assertRpcOk(
          await rpc(host.port, host.cookie, "workspace/create", { request: { path: XP_WORKSPACE } }),
          "XP empty workspace registration",
        );
        info("XP workspace/create accepted");
      } catch (error) {
        info(`XP workspace/create: ${redact(error instanceof Error ? error.message : String(error))} (continue if already registered)`);
      }
      await recordChapter(browser, host.launchUrl, {
        id: "05-xp-desktop-session",
        title: "XP 桌面进入空 workspace 会话 iframe（Spaces 不可达）",
        run: chapterXp,
      });
    });
    }

    if (want("06-catppuccin-failure")) {
    await withThemeHost(nodeExe, bin, HOME, tooling, "theme-catppuccin", async (host) => {
      await recordChapter(browser, host.launchUrl, {
        id: "06-catppuccin-failure",
        title: "Catppuccin 真实失败页（限制素材）",
        run: chapterCatppuccin,
      });
    });
    }
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await stopLeftovers();
  }

  const expected = [
    "01-zhongguo-welcome-spaces",
    "02-zhongguo-create-verify",
    "03-zhongguo-plugins-i18n",
    "04-eternalnight-wallpaper-spaces",
    "05-xp-desktop-session",
    "06-catppuccin-failure",
  ];
  const mergedChapters = [];
  for (const id of expected) {
    const fresh = chapters.find((row) => row.id === id);
    const old = prior?.chapters?.find((row) => row.id === id);
    const row = fresh || old;
    if (!row) unrecorded.push(id);
    else mergedChapters.push(row);
  }

  const summary = {
    status: errors.length ? "recorded-with-errors" : "recorded",
    at: new Date().toISOString(),
    cli: { bin, version },
    node: nodeExe,
    home: HOME,
    playwright: playwrightModule,
    viewport: VIDEO,
    createdProfile: created,
    chapters: mergedChapters.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      video: row.video,
      trimStartSec: row.trimStartSec,
      trimEndSec: row.trimEndSec,
      recordedWallSec: row.recordedWallSec,
      marks: row.marks,
      pageErrors: row.pageErrors,
      error: row.error,
      spacesReachable: row.spacesReachable,
      frameSpacesVisible: row.frameSpacesVisible,
      occlusion: row.occlusion,
      limitation: row.limitation,
      hostVisible: row.hostVisible,
      proof: row.proof,
    })),
    errors,
    unrecorded,
    note: "Footage only. Voiceover/edit is the orchestrator's job. Browser actions were not simulated.",
  };
  writeJson(RESULT_PATH, summary);
  writeJson(TIMELINE_PATH, {
    createdProfile: created,
    chapters: summary.chapters.map((row) => ({
      id: row.id,
      video: row.video?.path,
      durationSec: row.video?.durationSec,
      trimStartSec: row.trimStartSec,
      trimEndSec: row.trimEndSec,
      marks: row.marks,
    })),
  });
  info(`results ${RESULT_PATH}`);
  console.log("\nSPACES DEMO RECORD: done");
}

if (import.meta.main) {
  main().catch(async (error) => {
    const message = redact(error instanceof Error ? error.stack || error.message : String(error));
    console.error(`FAIL  ${message}`);
    await stopLeftovers();
    writeJson(RESULT_PATH, {
      status: "fail",
      error: redact(error instanceof Error ? error.message : String(error)),
      chapters,
      errors,
      unrecorded,
      at: new Date().toISOString(),
    });
    process.exit(1);
  });
}

export { ARTIFACT, HOME };
