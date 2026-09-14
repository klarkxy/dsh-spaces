#!/usr/bin/env node
/**
 * Bounded bare-DSH-Web theme acceptance for four community theme candidates
 * plus the packed Spaces plugin.
 *
 * Proves, when run by the orchestrator:
 *   one disposable DSH_HOME, official `dsh plugin add` of each pinned
 *   theme into its own profile, Spaces tarball on that same profile,
 *   serial `dsh --no-open` Web (not Electron), Playwright against the
 *   announced URL, skip intro + defer key, official New Session and
 *   Spaces panel reachable, host id + peer profiles visible, pageerrors,
 *   computed style / official theme injection evidence, chat.png +
 *   spaces.png. Cleans owned Hosts/ports; keeps Home and screenshots.
 *
 * Does not prove: visual difference (orchestrator audits screenshots),
 * model calls, production ~/.dsh, Electron, handwritten CSS.
 *
 * Run with Node 22.18+ or 24+: node scripts/verify-spaces-themes.mjs
 * DSH_TEST_PLAYWRIGHT_MODULE names the Playwright package directory.
 * DSH_TEST_THEMES_REUSE=1 preserves this script's existing test Home;
 * DSH_TEST_THEME_IDS selects comma-separated ids and writes results-selected.json.
 * This module does not execute Host/browser when imported.
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  HOST,
  REGISTRY,
  DUMP_MS,
  PLUGIN_MS,
  BOOT_MS,
  RPC_MS,
  PORT_MS,
  redact,
  refuseRealHome,
  writeJson,
  sha256File,
  resolveNode,
  resolveNpmCli,
  resolvePnpmCjs,
  dshBin,
  cliVersion,
  run,
  writePnpmShim,
  isolatedEnv,
  importCore,
  ephemeralPort,
  waitPortClosed,
  stopOwned,
  captureLaunchUrl,
  sessionCookie,
  rpc,
  assertRpcOk,
  rpcAvailable,
} from "./verify-spaces-distribution.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = join(REPO, ".sandbox", "spaces-themes-acceptance");
const DEFAULT_SPACES_TGZ = join(REPO, ".sandbox", "pluginization-delivery", "dsh-spaces-plugin-0.2.0.tgz");
const DEFAULT_PLAYWRIGHT =
  "C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
const CANONICAL_SPACES = "@dsh-spaces/plugin";
const SPACES_ROW_ID = "dsh-spaces";
const PEER_PROFILE = "notes";
const WEB_PROFILE = "web";
const NAV_MS = 30_000;
const UI_MS = 45_000;
const REUSE_HOME = process.env.DSH_TEST_THEMES_REUSE === "1";
const REQUESTED_IDS = process.env.DSH_TEST_THEME_IDS?.split(",").filter(Boolean);
const RESULT_PATH = join(ARTIFACT, REQUESTED_IDS ? "results-selected.json" : "results.json");

const THEMES = [
  {
    id: "zhongguo", profile: "theme-zhongguo", spec: "dsh-theme-plugin@0.3.3",
    packageName: "dsh-theme-plugin", version: "0.3.3", dumpIds: ["theme-zhongguo"],
    expectedFlavor: "zhuqing-light", hash: "theme=zhuqing-light", installArgs: ["--ignore-scripts"],
    visual: "Chinese traditional Zhu Qing light palette; --dsw-alias-bg-base rgb(239,248,241)",
  },
  {
    id: "catppuccin",
    profile: "theme-catppuccin",
    spec: "dsh-catppuccin@0.2.3",
    packageName: "dsh-catppuccin",
    version: "0.2.3",
    dumpIds: ["catppuccin", "dsh-catppuccin-tui-themes"],
    expectedFlavor: "catppuccin-mocha",
    visual: "official theme.register Mocha pastel tokens; --dsw-alias-bg-base #1e1e2e",
  },
  {
    id: "eternalnight",
    profile: "theme-eternalnight",
    spec: "@eternalnight/dsh-theme@0.5.1",
    packageName: "@eternalnight/dsh-theme",
    version: "0.5.1",
    dumpIds: ["dsh-theme"],
    expectedFlavor: "image:default.png",
    visual: "bundle default image wallpaper via .dt-bg + /dsh-theme/assets/import-images/default.png",
  },
  {
    id: "xp",
    profile: "theme-xp",
    spec: "dsh-client-ui-theme-xp@0.1.1",
    packageName: "dsh-client-ui-theme-xp",
    version: "0.1.1",
    dumpIds: ["ui-theme-xp"],
    expectedFlavor: "luna-desktop",
    visual: "Windows XP Luna desktop: [data-xp-desktop], #dsh-xp-taskbar, Tahoma",
  },
];

const proved = [];
const skipped = [];
const themeResults = [];

function info(m) {
  console.log(`INFO  ${redact(m)}`);
}
function pass(m) {
  proved.push(m);
  console.log(`PASS  ${redact(m)}`);
}

function themeEnv(home, nodeExe, tooling) {
  const env = isolatedEnv(home, nodeExe, tooling);
  env.HOME = home;
  env.USERPROFILE = home;
  return env;
}

function runThemeDsh(nodeExe, bin, home, tooling, args, timeoutMs, label, logPath) {
  return run(nodeExe, [bin, ...args], {
    env: themeEnv(home, nodeExe, tooling),
    timeoutMs,
    label,
    logPath,
  });
}

function runThemeDshRetry(nodeExe, bin, home, tooling, args, timeoutMs, label, logPath) {
  try {
    return runThemeDsh(nodeExe, bin, home, tooling, args, timeoutMs, label, logPath);
  } catch (error) {
    info(`${label} retrying once: ${error instanceof Error ? error.message : String(error)}`);
    return runThemeDsh(nodeExe, bin, home, tooling, args, timeoutMs, `${label} retry`, logPath);
  }
}

async function startThemeProfile(nodeExe, bin, home, tooling, profile, logPath) {
  const port = await ephemeralPort();
  writeFileSync(logPath, "", "utf8");
  const child = spawn(nodeExe, [bin, "--profile", profile, "--no-open", "--host", HOST, "--port", String(port)], {
    env: themeEnv(home, nodeExe, tooling),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!child.pid) throw new Error(`failed to spawn ${profile}`);
  child.stdout?.on("data", (chunk) => writeFileSync(logPath, redact(chunk.toString("utf8")), { flag: "a" }));
  child.stderr?.on("data", (chunk) => writeFileSync(logPath, redact(chunk.toString("utf8")), { flag: "a" }));
  try {
    const launchUrl = await captureLaunchUrl(child, port, BOOT_MS);
    return { child, port, launchUrl };
  } catch (error) {
    await stopOwned(child);
    throw error;
  }
}

function stageTarball(origin, stageName) {
  if (!existsSync(origin) || !/dsh-spaces-plugin-.*\.tgz$/i.test(origin.replaceAll("\\", "/"))) {
    throw new Error(`Spaces tarball missing or unexpected: ${origin}`);
  }
  if (!isAbsolute(origin)) throw new Error(`plugin tarball must be absolute, got ${origin}`);
  const stage = mkdtempSync(join(tmpdir(), stageName));
  if (/[\s"'&|<>^()%!]/.test(stage)) {
    throw new Error("DSH plugin CLI needs a shell-safe temp path; set TMP/TEMP to a path without spaces or shell metacharacters.");
  }
  const tarball = join(stage, "dsh-spaces-plugin-0.2.0.tgz");
  copyFileSync(origin, tarball);
  const hash = sha256File(tarball);
  if (hash !== sha256File(origin)) throw new Error("Staged Spaces tarball differs from the delivery artifact");
  return { origin, used: tarball, sha256: hash };
}

function readProfilePkg(home, name) {
  const path = join(home, "profiles", name, "package.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function pluginSet(home, name) {
  const pkg = readProfilePkg(home, name);
  const deps = pkg?.dependencies ?? {};
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
  return { deps, bundles, names: Object.keys(deps) };
}

function assertSingleTheme(home, profile, theme) {
  const state = pluginSet(home, profile);
  if (!Object.prototype.hasOwnProperty.call(state.deps, theme.packageName)) {
    throw new Error(`${profile} missing theme dep ${theme.packageName}: ${JSON.stringify(state.deps)}`);
  }
  if (!Object.prototype.hasOwnProperty.call(state.deps, CANONICAL_SPACES)) {
    throw new Error(`${profile} missing Spaces dep`);
  }
  if (!state.bundles.includes(theme.packageName)) {
    throw new Error(`${profile} bundles missing ${theme.packageName}: ${JSON.stringify(state.bundles)}`);
  }
  if (!state.bundles.includes(CANONICAL_SPACES)) {
    throw new Error(`${profile} bundles missing ${CANONICAL_SPACES}`);
  }
  const otherThemes = THEMES.filter((row) => row.id !== theme.id).map((row) => row.packageName);
  const leaked = otherThemes.filter((name) => state.bundles.includes(name) || Object.prototype.hasOwnProperty.call(state.deps, name));
  if (leaked.length) {
    throw new Error(`${profile} mixed extra themes ${leaked.join(", ")}`);
  }
  return state;
}

function dumpHasId(dump, id) {
  return new RegExp(`^- id:\\s*${id}\\b`, "m").test(dump);
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

async function skipIntro(page) {
  await waitUntil(async () => !new URL(page.url()).searchParams.has("token"), NAV_MS, "token redirect");
  const intro = page.getByRole("button", { name: /^(Continue|继续)$/ });
  await page.getByRole("button", { name: /^Continue$|^继续$|稍后配置|set up later|configure later/i }).first().waitFor({ timeout: UI_MS });
  if (await intro.isVisible()) await intro.click();
  const deferKey = page.getByRole("button", { name: /稍后配置|set up later|configure later/i });
  await deferKey.waitFor({ timeout: UI_MS });
  await deferKey.click();
}

async function openOfficialChat(page, themeId) {
  if (themeId === "xp") {
    await page.getByText("我的工作区", { exact: true }).first().dblclick();
    await page.locator('.xp-grid-item[data-kind="ws"]').first().dblclick();
    await page.locator('.xp-grid-item[data-kind="new"]').dblclick();
    await page.locator('.xp-window iframe').waitFor({ timeout: UI_MS });
    const frame = page.frameLocator('.xp-window iframe').last();
    const later = frame.getByRole("button", { name: /稍后配置|set up later|configure later/i });
    await later.waitFor({ timeout: UI_MS });
    await later.click();
    await frame.locator('[contenteditable="true"]').first().waitFor({ timeout: UI_MS });
    return frame;
  }
  const chat = page.getByText(/^(New Session|新会话)$/i).first();
  await chat.waitFor({ timeout: 8_000 });
  return page;
}

async function activateOfficialTheme(page, theme) {
  if (theme.id === "zhongguo") {
    await waitUntil(async () => (await readThemeProof(page)).bgBase.replace(/\s+/g, "") === "rgb(239,248,241)", UI_MS, "Zhu Qing registered theme tokens");
    return;
  }
  if (theme.id === "catppuccin") {
    const settings = page.getByRole("button", { name: /^(Settings|设置)$/ });
    await settings.click();
    await page.getByRole("button", { name: /^Mocha$/ }).waitFor({ timeout: UI_MS });
    await page.getByRole("button", { name: /^Mocha$/ }).click();
    await waitUntil(async () => {
      const bg = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--dsw-alias-bg-base").trim());
      return bg.replace(/\s+/g, "") === "#1e1e2e";
    }, UI_MS, "Catppuccin Mocha tokens");
    const close = page.getByRole("button", { name: /^(Close|关闭|Done|完成)$/ });
    if (await close.isVisible().catch(() => false)) await close.click().catch(() => undefined);
    return;
  }
  if (theme.id === "eternalnight") {
    await waitUntil(async () => page.locator(".dt-bg img, .dt-bg video").count().then((n) => n > 0), UI_MS, "eternalnight .dt-bg media");
    return;
  }
  if (theme.id === "xp") {
    await waitUntil(
      async () => page.locator("[data-xp-desktop], #dsh-xp-taskbar").count().then((n) => n > 0),
      UI_MS,
      "XP desktop/taskbar",
    );
  }
}

async function readThemeProof(page) {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.body);
    const img = document.querySelector(".dt-bg img");
    const video = document.querySelector(".dt-bg video");
    return {
      bg: cs.backgroundColor,
      bgBase: cs.getPropertyValue("--dsw-alias-bg-base").trim(),
      sidebarFill: cs.getPropertyValue("--dsw-specific-sidebar-fill").trim(),
      font: cs.fontFamily,
      darkAttr: document.body.getAttribute("data-ds-dark-theme"),
      dtBg: Boolean(document.querySelector(".dt-bg")),
      dtImgSrc: img instanceof HTMLImageElement ? img.currentSrc || img.getAttribute("src") : null,
      dtVideoSrc: video instanceof HTMLVideoElement ? video.currentSrc || video.getAttribute("src") : null,
      xpDesktop: Boolean(document.querySelector("[data-xp-desktop]")),
      xpTaskbar: Boolean(document.querySelector("#dsh-xp-taskbar")),
      localCatppuccin: (() => {
        try {
          return window.localStorage.getItem("dsh-catppuccin:skin");
        } catch {
          return null;
        }
      })(),
    };
  });
}

function assertThemeProof(theme, proof) {
  if (theme.id === "zhongguo") {
    if (proof.bgBase.replace(/\s+/g, "") !== "rgb(239,248,241)") throw new Error("Zhu Qing theme tokens not applied");
    return;
  }
  if (theme.id === "catppuccin") {
    if (proof.bgBase.replace(/\s+/g, "") !== "#1e1e2e") {
      throw new Error(`Catppuccin Mocha not applied: --dsw-alias-bg-base=${proof.bgBase}`);
    }
    if (proof.localCatppuccin && proof.localCatppuccin !== "catppuccin-mocha") {
      throw new Error(`Catppuccin storage ${proof.localCatppuccin}, expected catppuccin-mocha`);
    }
    return;
  }
  if (theme.id === "eternalnight") {
    if (!proof.dtBg) throw new Error("eternalnight missing .dt-bg (official wallpaper layer)");
    const src = `${proof.dtImgSrc || ""} ${proof.dtVideoSrc || ""}`;
    if (!/\/dsh-theme\/assets\//.test(src)) {
      throw new Error(`eternalnight media src is not official plugin assets: ${src}`);
    }
    return;
  }
  if (theme.id === "xp") {
    if (!proof.xpDesktop && !proof.xpTaskbar) {
      throw new Error("XP Luna desktop/taskbar markers missing");
    }
    if (!/tahoma/i.test(proof.font || "")) {
      info(`XP font-family without Tahoma (observed ${proof.font}); continuing if desktop markers exist`);
    }
  }
}

async function openSpacesPanel(page, hostProfile) {
  await page.getByRole("button", { name: "空间", exact: true }).click();
  await page.getByRole("heading", { name: "空间", exact: true }).waitFor({ timeout: UI_MS });
  await waitUntil(
    async () => {
      const text = await page.locator(".dsh-spaces").innerText();
      return text.includes(PEER_PROFILE) && text.includes(hostProfile) && text.includes(WEB_PROFILE);
    },
    UI_MS,
    "Spaces list render",
  );
}

async function browseTheme(page, launchUrl, theme, shotDir) {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const target = new URL(launchUrl.href);
  if (theme.hash) target.hash = theme.hash;
  await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: NAV_MS });
  await skipIntro(page);
  await activateOfficialTheme(page, theme);
  const surface = await openOfficialChat(page, theme.id);
  const proofAfterActivate = await readThemeProof(page);
  assertThemeProof(theme, proofAfterActivate);
  mkdirSync(shotDir, { recursive: true });
  const chatPng = join(shotDir, "chat.png");
  await page.screenshot({ path: chatPng, fullPage: true });
  if (theme.id === "xp") {
    const frameSpacesVisible = await surface.getByRole("button", { name: "空间", exact: true }).isVisible();
    let rootSpacesClickable = false;
    try { await page.getByRole("button", { name: "空间", exact: true }).click({ timeout: 3000 }); rootSpacesClickable = true; } catch {}
    if (!frameSpacesVisible && !rootSpacesClickable) {
      const spacesPng = join(shotDir, "spaces-blocked.png");
      await page.screenshot({ path: spacesPng, fullPage: true });
      return { pageErrors, proof: await readThemeProof(page), chatPng, spacesPng, spacesReachable: false,
        issue: "XP desktop intercepts the root Spaces button and hides the iframe sidebar." };
    }
  }
  await openSpacesPanel(page, theme.profile);
  const spacesPng = join(shotDir, "spaces.png");
  await page.screenshot({ path: spacesPng, fullPage: true });
  const proof = await readThemeProof(page);
  if (pageErrors.length) {
    throw new Error(`pageerrors: ${redact(pageErrors.join(" | "))}`);
  }
  return { pageErrors, proof, chatPng, spacesPng, spacesReachable: true };
}

function collectInventory(inventoryCall, theme) {
  const entries = inventoryCall.body?.result?.value?.entries ?? [];
  const themeHit = entries.filter(
    (row) =>
      row.moduleName === theme.packageName ||
      theme.dumpIds.some((id) => String(row.entryId ?? "").endsWith(id) || row.entryId === id),
  );
  const spacesHit = entries.find(
    (row) => row.moduleName === CANONICAL_SPACES || String(row.entryId ?? "").endsWith(SPACES_ROW_ID),
  );
  const extra = THEMES.filter((row) => row.id !== theme.id).flatMap((row) =>
    entries.filter((entry) => entry.moduleName === row.packageName),
  );
  return { entries: entries.map((row) => ({ entryId: row.entryId, moduleName: row.moduleName, enabled: row.enabled })), themeHit, spacesHit, extra };
}

async function runOneTheme(ctx, theme) {
  const { nodeExe, bin, home, tooling, spacesTarball, applyIsolationPatch, assertDumpPatched } = ctx;
  const profile = theme.profile;
  const addLog = join(ARTIFACT, `${theme.id}-plugin-add.log`);
  writeFileSync(addLog, "", "utf8");

  if (!REUSE_HOME || !existsSync(join(home, "profiles", profile, "package.json"))) {
  runThemeDsh(
    nodeExe,
    bin,
    home,
    tooling,
    ["--profile", profile, "--from-default-profile", WEB_PROFILE, "--dump-config"],
    DUMP_MS,
    `${profile} from-default-profile`,
    addLog,
  );
  const isolatedPatch = join(home, "profiles", profile, "cordis.patch.yml");
  writeFileSync(isolatedPatch, applyIsolationPatch(readFileSync(isolatedPatch, "utf8"), profile, isolatedPatch), "utf8");
  const dumpSeed = runThemeDsh(nodeExe, bin, home, tooling, ["--profile", profile, "--dump-config"], DUMP_MS, `${profile} dump after isolation`, addLog);
  assertDumpPatched(dumpSeed, profile);
  pass(`${profile} isolated from web`);

  info(`dsh plugin --profile ${profile} add Spaces tarball first`);
  runThemeDshRetry(
    nodeExe,
    bin,
    home,
    tooling,
    ["plugin", "--profile", profile, "add", spacesTarball.used, "--config.auto-install-peers=true"],
    PLUGIN_MS,
    `${theme.id} spaces add`,
    addLog,
  );
  info(`dsh plugin --profile ${profile} add ${theme.spec} without auto-installing old peers`);
  runThemeDshRetry(
    nodeExe,
    bin,
    home,
    tooling,
    ["plugin", "--profile", profile, "add", theme.spec, ...(theme.installArgs ?? [])],
    PLUGIN_MS,
    `${theme.id} plugin add`,
    addLog,
  );
  }

  const install = assertSingleTheme(home, profile, theme);
  const dump = runThemeDsh(nodeExe, bin, home, tooling, ["--profile", profile, "--dump-config"], DUMP_MS, `${profile} dump after add`, addLog);
  writeFileSync(join(ARTIFACT, `${theme.id}-dump.txt`), dump, "utf8");
  for (const id of theme.dumpIds) {
    if (!dumpHasId(dump, id)) throw new Error(`${profile} dump-config missing id: ${id}`);
  }
  if (!dumpHasId(dump, SPACES_ROW_ID) || !dump.includes(CANONICAL_SPACES)) {
    throw new Error(`${profile} dump-config missing Spaces auto-activation`);
  }
  for (const other of THEMES.filter((row) => row.id !== theme.id)) {
    if (dump.includes(other.packageName)) {
      throw new Error(`${profile} dump mentions extra theme ${other.packageName}`);
    }
  }
  const installedManifest = JSON.parse(
    readFileSync(join(home, "profiles", profile, "node_modules", ...theme.packageName.split("/"), "package.json"), "utf8"),
  );
  if (installedManifest.name !== theme.packageName || installedManifest.version !== theme.version) {
    throw new Error(`installed ${installedManifest.name}@${installedManifest.version}, expected ${theme.packageName}@${theme.version}`);
  }
  pass(`${profile} installed only ${theme.packageName}@${theme.version} + ${CANONICAL_SPACES}`);

  const webState = pluginSet(home, WEB_PROFILE);
  if (webState.bundles.includes(theme.packageName) || Object.prototype.hasOwnProperty.call(webState.deps, theme.packageName)) {
    throw new Error(`web baseline received ${theme.packageName}`);
  }

  const logPath = join(ARTIFACT, `${theme.id}-dsh.log`);
  const started = await startThemeProfile(nodeExe, bin, home, tooling, profile, logPath);
  let browser;
  let page;
  const shotDir = join(ARTIFACT, theme.id);
  mkdirSync(shotDir, { recursive: true });
  const result = {
    id: theme.id,
    profile,
    spec: theme.spec,
    packageName: theme.packageName,
    version: installedManifest.version,
    dumpIds: theme.dumpIds,
    bundles: install.bundles,
    visual: theme.visual,
  };
  try {
    const cookie = await sessionCookie(started.launchUrl);
    const overview = assertRpcOk(await rpc(started.port, cookie, "spaces/overview", {}), `${theme.id} spaces/overview`);
    const ids = (overview.spaces ?? []).map((row) => row.id);
    if (!ids.includes(profile) || !ids.includes(PEER_PROFILE) || !ids.includes(WEB_PROFILE)) {
      throw new Error(`${theme.id} overview missing profiles: ${ids.join(",")}`);
    }
    const hostId = overview.capabilities?.hostSpaceId;
    if (hostId !== profile) {
      throw new Error(`${theme.id} hostSpaceId=${hostId}, expected ${profile}`);
    }
    pass(`${theme.id} host=${hostId} spaces=${ids.join(",")}`);
    if (theme.id === "xp") {
      const workspacePath = join(ARTIFACT, "xp-empty-workspace");
      mkdirSync(workspacePath, { recursive: true });
      assertRpcOk(await rpc(started.port, cookie, "workspace/create", { request: { path: workspacePath } }), "XP empty workspace registration");
    }

    const inventoryCall = await rpc(started.port, cookie, "pluginInventory/list", {});
    if (!rpcAvailable(inventoryCall)) {
      throw new Error(`${theme.id} pluginInventory/list unavailable`);
    }
    const inventory = collectInventory(inventoryCall, theme);
    if (!inventory.themeHit.length) throw new Error(`${theme.id} inventory missing theme package`);
    if (!inventory.spacesHit) throw new Error(`${theme.id} inventory missing Spaces`);
    if (inventory.extra.length) throw new Error(`${theme.id} inventory mixed extra themes`);
    result.inventory = inventory;

    const playwrightModule = process.env.DSH_TEST_PLAYWRIGHT_MODULE || DEFAULT_PLAYWRIGHT;
    const { chromium } = await import(pathToFileURL(join(playwrightModule, "index.mjs")).href);
    browser = await chromium.launch({ headless: true, timeout: NAV_MS });
    page = await browser.newPage({ locale: "zh-CN" });
    page.setDefaultTimeout(UI_MS);
    const ui = await browseTheme(page, started.launchUrl, theme, shotDir);
    result.proof = ui.proof;
    result.screenshots = { chat: ui.chatPng, spaces: ui.spacesPng };
    result.pageErrors = ui.pageErrors;
    result.spacesReachable = ui.spacesReachable;
    result.issue = ui.issue;
    if (ui.spacesReachable) pass(`${theme.id} Playwright chat+Spaces screenshots; official theme markers present`);
    else info(`${theme.id} theme/chat rendered, but Spaces UI is blocked by the theme`);
  } catch (error) {
    if (page) await page.screenshot({ path: join(shotDir, "failure.png"), fullPage: true }).catch(() => undefined);
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await stopOwned(started.child);
    await waitPortClosed(started.port, PORT_MS);
    pass(`${theme.id} owned port :${started.port} closed`);
  }
  result.status = result.spacesReachable ? "pass" : "incompatible";
  return result;
}

async function main() {
  mkdirSync(ARTIFACT, { recursive: true });
  const nodeExe = resolveNode();
  const bin = dshBin();
  const version = cliVersion(bin);
  info(`compatible CLI ${version} at ${bin}`);
  if (version !== "0.1.5-rc.1") {
    info(`CLI is ${version}; pinned themes were reviewed against 0.1.5-rc.1`);
  }
  resolveNpmCli(nodeExe);
  const pnpmCjs = resolvePnpmCjs();
  info(`pnpm ${pnpmCjs} registry ${REGISTRY}`);

  const session = mkdtempSync(join(tmpdir(), "spaces-themes-"));
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

  const home = join(ARTIFACT, "home");
  refuseRealHome(home);
  if (home.toLowerCase().startsWith(resolve("C:/Users/admin/.dsh").toLowerCase() + sep)) {
    throw new Error("refusing real ~/.dsh");
  }
  if (!REUSE_HOME) {
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
  } else if (!existsSync(join(home, "profiles", WEB_PROFILE, "package.json"))) {
    throw new Error("Requested reuse but the owned test home has no web baseline");
  }

  const spacesOrigin = process.env.DSH_TEST_PLUGIN_TGZ?.trim() || DEFAULT_SPACES_TGZ;
  const spacesTarball = stageTarball(resolve(spacesOrigin), "spaces-theme-tgz-");
  writeJson(join(ARTIFACT, "tarball.json"), spacesTarball);
  info(`Spaces tarball ${spacesTarball.used} sha256=${spacesTarball.sha256}`);

  const { applyIsolationPatch, assertDumpPatched } = await importCore();
  if (!REUSE_HOME) {
  info("seed web --dump-config");
  runThemeDsh(nodeExe, bin, home, tooling, ["--profile", WEB_PROFILE, "--dump-config"], DUMP_MS, "web dump-config", join(ARTIFACT, "seed.log"));
  pass("seeded web baseline; no theme installed on web");
  runThemeDsh(
    nodeExe,
    bin,
    home,
    tooling,
    ["--profile", PEER_PROFILE, "--from-default-profile", WEB_PROFILE, "--dump-config"],
    DUMP_MS,
    "notes from-default-profile",
    join(ARTIFACT, "seed.log"),
  );
  const notesPatch = join(home, "profiles", PEER_PROFILE, "cordis.patch.yml");
  writeFileSync(notesPatch, applyIsolationPatch(readFileSync(notesPatch, "utf8"), PEER_PROFILE, notesPatch), "utf8");
  pass("peer notes isolated, no theme");
  }

  const ctx = { nodeExe, bin, home, tooling, spacesTarball, applyIsolationPatch, assertDumpPatched };
  const failures = [];
  const selected = REQUESTED_IDS ? THEMES.filter(theme => REQUESTED_IDS.includes(theme.id)) : THEMES;
  if (!selected.length || (REQUESTED_IDS && selected.length !== REQUESTED_IDS.length)) throw new Error("Unknown or duplicate requested theme ids");
  for (const theme of selected) {
    try {
      const result = await runOneTheme(ctx, theme);
      themeResults.push(result);
      if (result.status !== "pass") failures.push(`${theme.id}: ${result.issue}`);
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      console.error(`FAIL  ${theme.id}: ${message}`);
      themeResults.push({ id: theme.id, profile: theme.profile, spec: theme.spec, status: "fail", error: message });
      failures.push(`${theme.id}: ${message}`);
    }
  }

  const webFinal = pluginSet(home, WEB_PROFILE);
  for (const theme of THEMES) {
    if (webFinal.bundles.includes(theme.packageName)) {
      failures.push(`web baseline gained ${theme.packageName}`);
    }
  }

  writeJson(RESULT_PATH, {
    status: failures.length ? "fail" : "pass",
    proved,
    skipped,
    cli: { bin, version },
    home,
    spaces: spacesTarball,
    themes: themeResults,
    webBaseline: webFinal,
    note: "Script PASS is not user visual acceptance; orchestrator must audit chat.png/spaces.png.",
    at: new Date().toISOString(),
  });
  if (failures.length) {
    throw new Error(`theme acceptance incomplete: ${failures.join(" | ")}`);
  }
  console.log("\nTHEME ACCEPTANCE: PASS (screenshots still need human audit)");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`FAIL  ${redact(error instanceof Error ? error.stack || error.message : String(error))}`);
    writeJson(RESULT_PATH, {
      status: "fail",
      proved,
      skipped,
      themes: themeResults,
      error: redact(error instanceof Error ? error.message : String(error)),
      at: new Date().toISOString(),
    });
    process.exit(1);
  });
}

export { THEMES, startThemeProfile, readThemeProof, assertSingleTheme };
