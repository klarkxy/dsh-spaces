#!/usr/bin/env node
/**
 * Record workbench intro footage against the already-verified theme Home.
 * Real DSH + Playwright; not screenshot slides, not mocked window APIs.
 *
 * Trusts only .sandbox/workbench-product-themes/results.json (status=pass)
 * and prior.home as a child of that output directory, plus that Home's
 * toolchain.json private roots and packed plugin artifacts. Never a hardcoded
 * leftover Home.
 * Does not import verify-workbench-interactions.mjs / verify-workbench-product.mjs
 * (those execute on import). Does not start supervisor/browser when imported.
 *
 * Run (orchestrator, after dual-end acceptance):
 *   "D:/Program Files/nodejs/node.exe" scripts/record-workbench-demo.mjs
 * Partial: DSH_TEST_DEMO_CHAPTERS=01-workbench,02-themes
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  redact as redactBase,
  refuseRealHome,
  writeJson,
  sha256File,
  isolatedEnv,
  stopOwned,
  rpc,
  assertRpcOk,
} from "./verify-spaces-distribution.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const THEMES_ROOT = join(REPO, ".sandbox", "workbench-product-themes");
const ARTIFACT = join(REPO, ".sandbox", "workbench-demo-video");
const CHAPTER_DIR = join(ARTIFACT, "chapters");
const MARK_DIR = join(ARTIFACT, "marks");
const RAW_DIR = join(ARTIFACT, "raw");
const LOG_DIR = join(ARTIFACT, "logs");
const RESULT_PATH = join(ARTIFACT, "results.json");
const TIMELINE_PATH = join(ARTIFACT, "timeline.json");
const NARRATION_PATH = join(REPO, "tasks", "workbench-demo-narration.json");
const SUPERVISOR = join(REPO, "packages", "supervisor", "lib", "index.js");
const SNAPSHOT_WORKER = join(REPO, "packages", "supervisor", "lib", "snapshot-worker.mjs");
const DEFAULT_PLAYWRIGHT =
  "C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
const FFMPEG = join(
  REPO,
  ".sandbox",
  "spaces-demo-tools",
  "ffmpeg",
  "ffmpeg-9.0.1-essentials_build",
  "bin",
  "ffmpeg.exe",
);
const REAL_HOME = resolve(join(homedir(), ".dsh"));
const VIDEO = { width: 1920, height: 1080 };
const NAV_MS = 30_000;
const UI_MS = 65_000;
const START_MS = 180_000;
const CREATE_MS = 420_000;
const ACTION_MS = 1_100;
const HOLD_MS = 3_200;
const CHAPTER_IDS = ["01-workbench", "02-themes", "03-manage", "04-maintenance"];

const owned = [];
const chapters = [];
const errors = [];
const unrecorded = [];

function redact(value) {
  return redactBase(value)
    .replace(/\/bootstrap\/[^\s"'<>]+/g, "/bootstrap/[redacted]")
    .replace(/([?&]token=)[^\s&"']+/gi, "$1[redacted]");
}

function info(m) {
  console.log(`INFO  ${redact(m)}`);
}

function failNote(m) {
  const text = redact(m);
  errors.push(text);
  console.error(`ERR   ${text}`);
}

function realPath(path) {
  return resolve(path);
}

function isChildPath(path, root) {
  const resolved = realPath(path);
  const base = realPath(root);
  return resolved.toLowerCase().startsWith(base.toLowerCase() + sep);
}

function assertChildPath(path, root, label) {
  if (!isChildPath(path, root)) throw new Error(`${label} is not inside ${root}: ${realPath(path)}`);
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
    await delay(200);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms (${redact(last)})`);
}

function videoMeta(file) {
  const st = existsSync(file) ? statSync(file) : null;
  const meta = {
    path: file,
    bytes: st?.size ?? 0,
    sha256: st ? sha256File(file) : null,
    width: null,
    height: null,
    durationSec: null,
  };
  if (!st || !existsSync(FFMPEG)) return meta;
  const probe = spawnSync(FFMPEG, ["-i", file], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  const text = `${probe.stdout || ""}${probe.stderr || ""}`;
  const dur = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dur) meta.durationSec = Number((Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])).toFixed(3));
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

function omitLongWait(marks, fromAction, toAction, reason, minSec = 6) {
  const a = marks.find((row) => row.action === fromAction);
  const b = [...marks].reverse().find((row) => row.action === toAction);
  if (!a || !b || b.tSec - a.tSec < minSec) return [];
  const startSec = Number((a.tSec + 1.1).toFixed(3));
  const endSec = Number(Math.max(startSec + 0.4, b.tSec - 0.35).toFixed(3));
  if (endSec <= startSec) return [];
  return [{ startSec, endSec, reason }];
}

function playwrightHref() {
  const raw = process.env.DSH_TEST_PLAYWRIGHT || DEFAULT_PLAYWRIGHT;
  const file = raw.endsWith("index.mjs") ? raw : join(raw, "index.mjs");
  if (!existsSync(file)) throw new Error(`Playwright missing: ${file}`);
  return pathToFileURL(file).href;
}

function loadPrior() {
  const proofPath = join(THEMES_ROOT, "results.json");
  if (!existsSync(proofPath)) throw new Error("missing theme proof .sandbox/workbench-product-themes/results.json");
  const prior = JSON.parse(readFileSync(proofPath, "utf8"));
  if (prior.status !== "pass") throw new Error(`theme Home is not pass: ${prior.status}`);
  if (!prior.home) throw new Error("theme proof missing home");
  const home = realPath(prior.home);
  assertChildPath(home, THEMES_ROOT, "home");
  refuseRealHome(home);
  if (home.toLowerCase() === REAL_HOME.toLowerCase() || home.toLowerCase().startsWith(REAL_HOME.toLowerCase() + sep)) {
    throw new Error("refusing real ~/.dsh");
  }
  if (!existsSync(home)) throw new Error(`theme Home missing: ${home}`);
  const toolchainPath = join(home, ".dsh-spaces-control", "toolchain.json");
  if (!existsSync(toolchainPath)) throw new Error("home toolchain.json missing");
  const binding = JSON.parse(readFileSync(toolchainPath, "utf8"));
  for (const key of ["toolchainRoot", "runtimeRoot", "snapshotRoot"]) {
    if (!binding[key]) throw new Error(`toolchain.json missing ${key}`);
    const bound = realPath(binding[key]);
    assertChildPath(bound, THEMES_ROOT, key);
    refuseRealHome(bound);
  }
  const plugin = realPath(prior.artifacts?.plugin?.path || "");
  const bridge = realPath(prior.artifacts?.bridge?.path || "");
  if (!existsSync(plugin) || !existsSync(bridge)) throw new Error("packed plugin/bridge missing");
  assertChildPath(plugin, THEMES_ROOT, "plugin artifact");
  assertChildPath(bridge, THEMES_ROOT, "bridge artifact");
  if (!existsSync(binding.bin) || !existsSync(binding.nodeExe)) throw new Error("toolchain bin/node missing");
  if (!existsSync(SUPERVISOR) || !existsSync(SNAPSHOT_WORKER)) throw new Error("supervisor lib missing");
  return { prior, home, binding, plugin, bridge, toolchainPath };
}

function stripSecrets(env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (/^(?:DEEPSEEK|OPENAI|ANTHROPIC|MINIMAX|GEMINI|GOOGLE|AZURE|DSH).*(?:API_KEY|ACCESS_TOKEN|SECRET)$/i.test(key)) {
      delete next[key];
    }
  }
  return next;
}

async function dismissIntro(frame) {
  for (const name of [/^(Continue|继续)$/, /稍后配置|set up later|configure later/i]) {
    const button = frame.getByRole("button", { name }).first();
    await button.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    if (await button.isVisible().catch(() => false)) await button.click();
  }
}

async function managerHub(page, api) {
  const state = await api("state");
  if (!state?.writable || !state.managerId) throw new Error("workbench is not writable manager");
  const managerView = await api("view", { spaceId: state.managerId });
  await waitUntil(
    () => page.frames().some((frame) => frame.url().startsWith(managerView.origin + "/")),
    START_MS,
    "manager iframe",
  );
  const hub = page.frames().find((frame) => frame.url().startsWith(managerView.origin + "/"));
  await hub.locator(".dsh-wb-rail").waitFor({ state: "visible", timeout: UI_MS });
  return { state, hub, managerView };
}

async function railWidth(hub) {
  return hub.locator(".dsh-wb-rail").evaluate((el) => Math.round(el.getBoundingClientRect().width));
}

async function selectLabel(hub, label) {
  await pause();
  await hub.getByRole("button", { name: label, exact: true }).first().click();
  await hub.locator('.dsh-wb-rail button[aria-current="true"]').filter({ hasText: label }).waitFor({ timeout: UI_MS });
}

async function workspaceChild(page, hub, api, spaceId) {
  const view = await api("view", { spaceId });
  await waitUntil(() => {
    return page.frames().some((frame) => frame.url().startsWith(view.origin + "/") && frame.parentFrame() === hub);
  }, START_MS, `workspace ${spaceId}`);
  return {
    view,
    frame: page.frames().find((frame) => frame.url().startsWith(view.origin + "/") && frame.parentFrame() === hub),
  };
}

async function ensureXpWorkspace(page, api, themesRoot) {
  const view = await api("view", { spaceId: "xp" });
  const origin = view.origin;
  const cookies = (await page.context().cookies(origin)).map((row) => `${row.name}=${row.value}`).join("; ");
  const workspacePath = join(themesRoot, "empty-workspace-xp");
  mkdirSync(workspacePath, { recursive: true });
  try {
    assertRpcOk(
      await rpc(Number(new URL(origin).port), cookies, "workspace/create", { request: { path: workspacePath } }),
      "XP empty workspace",
    );
  } catch (error) {
    info(`XP workspace/create: ${redact(error instanceof Error ? error.message : String(error))} (continue if registered)`);
  }
}

async function recordChapter(browser, session, chapter) {
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
  const api = async (method, data = {}) => {
    const response = await context.request.post(`${session.origin}/api/workbench/${method}`, {
      headers: { origin: session.origin },
      data,
      timeout: 30_000,
    });
    const body = await response.json();
    if (!body?.ok) throw new Error(`${method}: ${body?.error?.code || ""} ${body?.error?.message || JSON.stringify(body)}`);
    return body.value;
  };
  const job = async (command, timeoutMs = START_MS) => {
    const submitted = await api("submit", { command, requestId: randomUUID() });
    let latest = submitted;
    await waitUntil(async () => {
      latest = await api("job", { id: submitted.id });
      return !["queued", "running"].includes(latest.status);
    }, timeoutMs, command.kind);
    if (latest.status !== "succeeded") throw new Error(`${command.kind}: ${JSON.stringify(latest.error)}`);
    return latest;
  };
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
  const rec = { page, context, clock, mark, marks, pageErrors, api, job, session };
  let trimStartSec = null;
  let trimEndSec = null;
  let status = "recorded";
  let detail = {};
  try {
    await page.goto(session.bootstrap, { waitUntil: "domcontentloaded", timeout: NAV_MS });
    await waitUntil(() => page.url() === `${session.origin}/`, NAV_MS, "clean stable entry URL");
    await mark("goto");
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
  if (video) await video.saveAs(dest);
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

async function chapterHome(rec) {
  const { hub } = await managerHub(rec.page, rec.api);
  const width = await railWidth(hub);
  if (Math.abs(width - 72) >= 1) throw new Error(`rail width ${width}px, expected 72`);
  await selectLabel(hub, "首页");
  await hub.locator(".dsh-wb-home").waitFor({ timeout: UI_MS });
  await hub.getByRole("heading", { name: "首页", exact: true }).waitFor({ timeout: UI_MS });
  const trimStartSec = rec.clock.sec();
  await rec.mark("home-overview", { railWidthPx: width });
  await hold();
  await selectLabel(hub, "竹青");
  await rec.mark("enter-zhuqing-clicked");
  await workspaceChild(rec.page, hub, rec.api, "zhuqing");
  await rec.mark("enter-zhuqing");
  await hold();
  await selectLabel(hub, "首页");
  await hub.locator(".dsh-wb-home").waitFor({ timeout: UI_MS });
  await rec.mark("back-home");
  await hold(2_000);
  await selectLabel(hub, "EternalNight");
  await rec.mark("enter-eternalnight-clicked");
  await workspaceChild(rec.page, hub, rec.api, "eternalnight");
  await rec.mark("enter-eternalnight");
  await hold();
  await selectLabel(hub, "首页");
  await hub.locator(".dsh-wb-tab").first().waitFor({ timeout: UI_MS });
  await rec.mark("home-and-rail", { railWidthPx: await railWidth(hub) });
  await hold();
  const trimEndSec = rec.clock.sec();
  return {
    trimStartSec,
    trimEndSec,
    railWidthPx: width,
    omitRanges: [
      ...omitLongWait(rec.marks, "enter-zhuqing-clicked", "enter-zhuqing", "zhuqing start wait"),
      ...omitLongWait(rec.marks, "enter-eternalnight-clicked", "enter-eternalnight", "eternalnight start wait"),
    ],
  };
}

async function chapterThemes(rec) {
  const { hub } = await managerHub(rec.page, rec.api);
  await selectLabel(hub, "竹青");
  const zhuqing = await workspaceChild(rec.page, hub, rec.api, "zhuqing");
  await dismissIntro(zhuqing.frame);
  const trimStartSec = rec.clock.sec();
  await rec.mark("zhuqing-workspace");
  await hold();
  await selectLabel(hub, "EternalNight");
  const night = await workspaceChild(rec.page, hub, rec.api, "eternalnight");
  await dismissIntro(night.frame);
  await rec.mark("eternalnight-workspace");
  await hold();
  await selectLabel(hub, "XP");
  await ensureXpWorkspace(rec.page, rec.api, THEMES_ROOT);
  const xpWrap = await workspaceChild(rec.page, hub, rec.api, "xp");
  const xp = xpWrap.frame;
  await dismissIntro(xp);
  await xp.locator("[data-xp-desktop], #dsh-xp-taskbar").first().waitFor({ timeout: UI_MS });
  await dismissIntro(xp);
  const outerRail = await railWidth(hub);
  if (Math.abs(outerRail - 72) >= 1) throw new Error(`outer rail lost on XP: ${outerRail}`);
  await rec.mark("xp-desktop", { railWidthPx: outerRail });
  await hold(2_000);
  await pause();
  await xp.locator('[data-icon="browse"]').dblclick();
  await rec.mark("xp-browse");
  await hold(1_600);
  const folder = xp.locator('.xp-grid-item[data-kind="ws"]').filter({ hasText: "empty-workspace-xp" });
  await folder.first().waitFor({ timeout: UI_MS });
  await folder.first().dblclick();
  await rec.mark("xp-open-workspace");
  await hold(1_600);
  await xp.locator('.xp-grid-item[data-kind="new"]').first().dblclick();
  await rec.mark("xp-new-session");
  await waitUntil(() => xp.childFrames().length > 0, UI_MS, "XP inner chat");
  const chat = xp.childFrames()[0];
  await dismissIntro(chat);
  const editor = chat.locator('[contenteditable="true"]').first();
  await editor.waitFor({ timeout: 30_000 });
  if ((await chat.locator("#dsh-xp-taskbar").count()) !== 0) throw new Error("XP inner chat rendered a recursive desktop");
  const draft = "工作台演示草稿，请勿发送";
  await editor.fill(draft);
  await rec.mark("xp-draft");
  await hold();
  await selectLabel(hub, "竹青");
  await rec.mark("switch-away-zhuqing");
  await hold(2_000);
  await selectLabel(hub, "XP");
  await waitUntil(async () => (await editor.innerText().catch(() => "")) === draft, UI_MS, "XP draft retained");
  await rec.mark("xp-draft-retained", { draft, railWidthPx: await railWidth(hub) });
  await hold();
  const trimEndSec = rec.clock.sec();
  return { trimStartSec, trimEndSec, draft, omitRanges: omitLongWait(rec.marks, "xp-new-session", "xp-draft", "xp session start") };
}

async function chapterManage(rec) {
  const { hub } = await managerHub(rec.page, rec.api);
  await selectLabel(hub, "竹青");
  const trimStartSec = rec.clock.sec();
  await rec.mark("daily-click-zhuqing");
  await hold();
  await hub.getByRole("button", { name: "竹青", exact: true }).first().click({ button: "right" });
  await hub.getByRole("menu", { name: "空间操作" }).waitFor({ timeout: UI_MS });
  await hub.getByRole("menuitem", { name: "重命名" }).waitFor({ timeout: UI_MS });
  await hub.getByRole("menuitem", { name: "更换图标" }).waitFor({ timeout: UI_MS });
  await hub.getByRole("menuitem", { name: "停止" }).waitFor({ timeout: UI_MS });
  await rec.mark("context-menu");
  await hold();
  await hub.locator(".dsh-wb-overlay").click({ position: { x: 640, y: 80 } });
  await hub.getByRole("menu", { name: "空间操作" }).waitFor({ state: "hidden", timeout: UI_MS }).catch(() => undefined);
  const stamp = Date.now().toString(36).slice(-6);
  const created = { name: `demo-video-${stamp}`, displayName: `演示空间 ${stamp}` };
  await pause();
  await hub.getByRole("button", { name: "新建空间", exact: true }).click();
  const form = hub.getByRole("form", { name: "创建空间" });
  await form.waitFor({ timeout: UI_MS });
  await form.locator('input[name="name"]').fill(created.name);
  await pause();
  await form.locator('input[name="displayName"]').fill(created.displayName);
  await form.getByRole("button", { name: "对话", exact: true }).click();
  await rec.mark("create-form", created);
  await pause();
  await form.getByRole("button", { name: "创建", exact: true }).click();
  await rec.mark("create-clicked");
  await hub.locator(".dsh-wb-banner[data-created]").waitFor({ timeout: CREATE_MS });
  await hub.getByText("已创建", { exact: true }).waitFor({ timeout: UI_MS });
  await hub.getByRole("button", { name: "进入空间", exact: true }).waitFor({ timeout: UI_MS });
  await hub.locator('.dsh-wb-rail button[aria-current="true"]').filter({ hasText: "竹青" }).waitFor({ timeout: UI_MS });
  await rec.mark("create-success-not-entered", { ...created, selectionPreserved: "竹青" });
  await hold();
  const createdBtn = hub.getByRole("button", { name: created.displayName, exact: true }).first();
  await createdBtn.click({ button: "right" });
  await hub.getByRole("menuitem", { name: "重命名" }).click();
  const renamed = `${created.displayName} · 已改名`;
  const renameDlg = hub.locator(".dsh-wb-dialog").filter({ has: hub.getByRole("heading", { name: "重命名空间", exact: true }) });
  await renameDlg.waitFor({ timeout: UI_MS });
  await renameDlg.locator('input[name="displayName"]').fill(renamed);
  await rec.mark("rename-form");
  await renameDlg.getByRole("button", { name: "保存", exact: true }).click();
  await hub.getByRole("button", { name: renamed, exact: true }).first().waitFor({ timeout: UI_MS });
  await rec.mark("renamed", { renamed });
  await hold(1_600);
  await hub.getByRole("button", { name: renamed, exact: true }).first().click({ button: "right" });
  await hub.getByRole("menuitem", { name: "更换图标" }).click();
  const iconDlg = hub.locator(".dsh-wb-dialog").filter({ has: hub.getByRole("heading", { name: "空间图标", exact: true }) });
  await iconDlg.waitFor({ timeout: UI_MS });
  await iconDlg.getByRole("button", { name: "代码", exact: true }).click();
  await rec.mark("icon-picker");
  await iconDlg.getByRole("button", { name: "保存", exact: true }).click();
  await rec.mark("icon-saved");
  await hold(1_600);
  await selectLabel(hub, "误装测试");
  await rec.mark("misinstalled-clicked");
  const mis = await workspaceChild(rec.page, hub, rec.api, "misinstalled");
  await mis.frame.getByRole("heading", { name: "返回工作台" }).waitFor({ timeout: START_MS });
  await mis.frame.getByRole("button", { name: "返回工作台", exact: true }).waitFor({ timeout: UI_MS });
  if ((await mis.frame.locator(".dsh-wb-rail").count()) !== 0) throw new Error("misinstalled nested rail");
  await rec.mark("misinstalled-guide");
  await hold();
  await selectLabel(hub, "首页");
  await rec.mark("back-home-after-manage");
  await hold();
  const trimEndSec = rec.clock.sec();
  return {
    trimStartSec,
    trimEndSec,
    created: { ...created, displayName: renamed, icon: "code", entered: false },
    omitRanges: [
      ...omitLongWait(rec.marks, "create-clicked", "create-success-not-entered", "space.create install wait", 5),
      ...omitLongWait(rec.marks, "misinstalled-clicked", "misinstalled-guide", "misinstalled start wait"),
    ],
  };
}

async function chapterMaintenance(rec) {
  const { hub, state } = await managerHub(rec.page, rec.api);
  await selectLabel(hub, "首页");
  const trimStartSec = rec.clock.sec();
  await rec.mark("home-maintenance");
  await hold(1_600);
  await hub.getByRole("tab", { name: "插件", exact: true }).click();
  await hub.getByText("精确版本", { exact: true }).waitFor({ timeout: UI_MS });
  await rec.mark("plugins-tab");
  await hold();
  await hub.getByRole("tab", { name: "快照", exact: true }).click();
  await hub.getByText("会先停止运行中的空间，再快照整个 Home。完成后空间保持停止。").waitFor({ timeout: UI_MS });
  await rec.mark("snapshots-whole-home");
  await hold();
  const restore = hub.getByRole("button", { name: "预览恢复" }).first();
  if ((await restore.isVisible().catch(() => false)) && (await restore.isEnabled().catch(() => false))) {
    await restore.click();
    await hub.getByRole("heading", { name: "确认这项更改" }).waitFor({ timeout: UI_MS });
    await hub.getByText("Home", { exact: true }).waitFor({ timeout: UI_MS });
    await rec.mark("snapshot-restore-preview-cancelled");
    await hub.getByRole("button", { name: "取消", exact: true }).click();
    await hold(1_200);
  }
  await hub.getByRole("tab", { name: "运行时", exact: true }).click();
  await hub.getByText("当前运行时", { exact: false }).first().waitFor({ timeout: UI_MS });
  await rec.mark("runtime-tab-no-install");
  await hold();
  await hub.getByRole("button", { name: "设置", exact: true }).click();
  await hub.getByText("关闭浏览器标签不会停止实例。只有在需要监督进程退出时才使用此项。").waitFor({ timeout: UI_MS });
  await rec.mark("settings-independent-entry-hint");
  await hold();
  await hub.getByRole("button", { name: "关闭", exact: true }).click();
  const managerId = state.managerId;
  const plan = await rec.api("preview", { request: { kind: "space.stop", spaceId: managerId } });
  await rec.mark("manager-stop-preview", { managerId, planId: plan.id, scope: plan.scope });
  await rec.job({ kind: "plan.execute", planId: plan.id }, START_MS);
  await waitUntil(async () => {
    const next = await rec.api("state");
    return next.spaces.find((row) => row.id === managerId)?.status === "stopped";
  }, START_MS, "manager stopped");
  await rec.page.getByText(/检查并恢复|救援入口|需要恢复|管理环境不可用/).first().waitFor({ timeout: UI_MS });
  await rec.page.getByText(/救援入口|管理环境不可用，稳定入口仍在线/).first().waitFor({ timeout: UI_MS });
  await rec.mark("rescue-after-manager-stop", { managerId, executed: "space.stop", longInstallOrRestore: false });
  await hold(4_000);
  const trimEndSec = rec.clock.sec();
  return {
    trimStartSec,
    trimEndSec,
    managerStopped: true,
    longMaintenanceExecuted: false,
    omitRanges: omitLongWait(rec.marks, "manager-stop-preview", "rescue-after-manager-stop", "manager stop wait", 5),
  };
}

async function startSupervisor(loaded) {
  mkdirSync(LOG_DIR, { recursive: true });
  const tooling = Object.fromEntries(["shim", "pnpmHome", "store", "cache"].map((key) => [key, join(THEMES_ROOT, key)]));
  const env = stripSecrets(isolatedEnv(loaded.home, loaded.binding.nodeExe, tooling));
  const child = spawn(
    loaded.binding.nodeExe,
    [
      SUPERVISOR,
      "--home",
      loaded.home,
      "--bin",
      loaded.binding.bin,
      "--node",
      loaded.binding.nodeExe,
      "--port",
      "0",
      "--plugin-artifact",
      loaded.plugin,
      "--view-bridge-artifact",
      loaded.bridge,
      "--control-tool-root",
      loaded.binding.toolchainRoot,
      "--snapshot-root",
      loaded.binding.snapshotRoot,
      "--snapshot-worker",
      SNAPSHOT_WORKER,
    ],
    { cwd: REPO, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  owned.push(child);
  let launch = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    launch = (launch + chunk.toString()).slice(-32768);
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-32768);
  });
  await waitUntil(() => {
    if (child.exitCode !== null) throw new Error(`supervisor exited ${child.exitCode}: ${redact(stderr)}`);
    return /bootstrap=(http:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.test(launch);
  }, 240_000, "supervisor");
  const bootstrap = launch.match(/bootstrap=(http:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)[1];
  writeFileSync(join(LOG_DIR, "supervisor.log"), redact(`${launch}\n${stderr}`));
  return { child, bootstrap, origin: new URL(bootstrap).origin, launch, stderr };
}

async function shutdownOwned(session) {
  if (session?.origin) {
    try {
      const response = await fetch(`${session.origin}/api/workbench/preview`, {
        method: "POST",
        headers: { origin: session.origin, "content-type": "application/json" },
        body: JSON.stringify({ request: { kind: "controller.shutdown" } }),
        signal: AbortSignal.timeout(8000),
      });
      const body = await response.json();
      if (body?.ok && body.value?.id) {
        await fetch(`${session.origin}/api/workbench/submit`, {
          method: "POST",
          headers: { origin: session.origin, "content-type": "application/json" },
          body: JSON.stringify({ command: { kind: "plan.execute", planId: body.value.id }, requestId: randomUUID() }),
          signal: AbortSignal.timeout(8000),
        }).catch(() => undefined);
      }
    } catch {
      /* owned tree is stopped below; never other Home processes */
    }
  }
  for (const child of [...owned]) {
    await stopOwned(child).catch(() => undefined);
  }
  owned.length = 0;
}

async function main() {
  mkdirSync(ARTIFACT, { recursive: true });
  mkdirSync(CHAPTER_DIR, { recursive: true });
  mkdirSync(MARK_DIR, { recursive: true });
  mkdirSync(RAW_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  const loaded = loadPrior();
  const narration = JSON.parse(readFileSync(NARRATION_PATH, "utf8"));
  if (narration.length !== 4) throw new Error("expected 4 narration chapters");
  info(`home ${loaded.home}`);
  info(`plugin ${loaded.plugin}`);
  info(`bridge ${loaded.bridge}`);
  const requested = (process.env.DSH_TEST_DEMO_CHAPTERS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const want = (id) => !requested.length || requested.includes(id);
  const priorResults = existsSync(RESULT_PATH) ? JSON.parse(readFileSync(RESULT_PATH, "utf8")) : null;
  const href = playwrightHref();
  info(`Playwright ${href}`);
  const { chromium } = await import(href);
  let browser;
  let session;
  try {
    session = await startSupervisor(loaded);
    info(`entry ${redact(session.bootstrap)}`);
    browser = await chromium.launch({
      headless: process.env.DSH_TEST_HEADED === "1" ? false : true,
      timeout: NAV_MS,
    });
    const defs = [
      { id: "01-workbench", title: narration[0].title, run: chapterHome },
      { id: "02-themes", title: narration[1].title, run: chapterThemes },
      { id: "03-manage", title: narration[2].title, run: chapterManage },
      { id: "04-maintenance", title: narration[3].title, run: chapterMaintenance },
    ];
    for (const def of defs) {
      if (want(def.id)) await recordChapter(browser, session, def);
    }
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await shutdownOwned(session);
  }

  const merged = [];
  for (const id of CHAPTER_IDS) {
    const fresh = chapters.find((row) => row.id === id);
    const old = priorResults?.chapters?.find((row) => row.id === id);
    const row = fresh || old;
    if (!row) unrecorded.push(id);
    else merged.push(row);
  }
  const summary = {
    status: errors.length ? "recorded-with-errors" : unrecorded.length ? "partial" : "recorded",
    at: new Date().toISOString(),
    realDsh: true,
    modelCalls: false,
    mockedWindowApi: false,
    home: loaded.home,
    toolchain: loaded.toolchainPath,
    artifacts: loaded.prior.artifacts,
    playwright: href,
    viewport: VIDEO,
    railCssPx: 72,
    chapters: merged,
    errors,
    unrecorded,
    note: "Footage only. Voiceover/edit is assemble-workbench-demo.mjs. Cleanup stopped only this script's supervisor/browser.",
  };
  writeJson(RESULT_PATH, summary);
  writeJson(TIMELINE_PATH, {
    home: loaded.home,
    chapters: merged.map((row) => ({
      id: row.id,
      video: row.video?.path,
      sha256: row.video?.sha256,
      durationSec: row.video?.durationSec,
      trimStartSec: row.trimStartSec,
      trimEndSec: row.trimEndSec,
      omitRanges: row.omitRanges || [],
      marks: row.marks,
    })),
  });
  info(`results ${RESULT_PATH}`);
  console.log("\nWORKBENCH DEMO RECORD: done");
}

if (import.meta.main) {
  main().catch(async (error) => {
    const message = redact(error instanceof Error ? error.stack || error.message : String(error));
    console.error(`FAIL  ${message}`);
    await shutdownOwned();
    writeJson(RESULT_PATH, {
      status: "fail",
      error: redact(error instanceof Error ? error.message : String(error)),
      chapters,
      errors,
      unrecorded,
      at: new Date().toISOString(),
      realRun: true,
    });
    process.exit(1);
  });
}

export { ARTIFACT, NARRATION_PATH, THEMES_ROOT };
