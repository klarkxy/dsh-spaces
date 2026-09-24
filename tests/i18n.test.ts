import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  catalogKeys,
  en,
  inferAppLocale,
  interpolate,
  resolveLocale,
  t,
  visibleError,
  zh,
} from "../src/shared/i18n/index.ts";
import { resolveColorScheme } from "../src/shared/theme.ts";
import { readSettings, writeSettings } from "../src/adapters/node/hub-settings.ts";
import { DEFAULT_HUB_SETTINGS } from "../src/shared/types.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("infers zh from Chinese locales and en otherwise", () => {
  assert.equal(inferAppLocale("zh-CN"), "zh");
  assert.equal(inferAppLocale("zh-TW"), "zh");
  assert.equal(inferAppLocale("zh"), "zh");
  assert.equal(inferAppLocale("en-US"), "en");
  assert.equal(inferAppLocale("ja-JP"), "en");
});

test("resolveColorScheme honors explicit appearance over the system", () => {
  assert.equal(resolveColorScheme("light", true), "light");
  assert.equal(resolveColorScheme("dark", false), "dark");
  assert.equal(resolveColorScheme("system", true), "dark");
  assert.equal(resolveColorScheme("system", false), "light");
});

test("resolveLocale honors explicit preference over the system", () => {
  assert.equal(resolveLocale("en", "zh-CN"), "en");
  assert.equal(resolveLocale("zh", "en-US"), "zh");
  assert.equal(resolveLocale("system", "zh-CN"), "zh");
  assert.equal(resolveLocale("system", "en-GB"), "en");
});

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

test("english and chinese catalogs have the same keys and non-empty values", () => {
  const enKeys = Object.keys(en).sort();
  const zhKeys = Object.keys(zh).sort();
  assert.deepEqual(zhKeys, enKeys);
  assert.deepEqual(catalogKeys().slice().sort(), enKeys);
  for (const key of enKeys) {
    const enText = en[key as keyof typeof en];
    const zhText = zh[key as keyof typeof zh];
    assert.ok(enText.length > 0, `empty en: ${key}`);
    assert.ok(zhText.length > 0, `empty zh: ${key}`);
    assert.deepEqual(placeholders(zhText), placeholders(enText), `placeholder mismatch: ${key}`);
  }
});

test("interpolate substitutes named placeholders", () => {
  assert.equal(interpolate("Hello {name}", { name: "Ada" }), "Hello Ada");
  assert.equal(interpolate("{count} pending", { count: 3 }), "3 pending");
  assert.equal(interpolate("keep {missing}", {}), "keep {missing}");
});

test("t uses the requested locale and interpolates placeholders", () => {
  assert.equal(t("common.cancel", undefined, "en"), "Cancel");
  assert.equal(t("common.cancel", undefined, "zh"), "取消");
  assert.equal(t("delete.title", { name: "coding" }, "en"), "Delete coding?");
  assert.equal(t("delete.title", { name: "coding" }, "zh"), "删除 coding？");
  assert.equal(
    t("onboarding.notice", undefined, "zh"),
    "你的历史聊天统一由 web 维护，工作台从全新会话开始",
  );
});

test("catalogs do not offer recovery actions", () => {
  const banned = /call recover first|restore a snapshot|needs recovery|pending recovery/i;
  for (const [key, text] of Object.entries(en)) {
    assert.doesNotMatch(text, banned, key);
  }
  for (const [key, text] of Object.entries(zh)) {
    assert.doesNotMatch(text, banned, key);
  }
});

test("name errors shown to users are the same human copy, not a regex", () => {
  for (const locale of ["en", "zh"] as const) {
    const fromMain = t("errors.nameInvalid", undefined, locale);
    const fromWizard = t("create.nameInvalid", undefined, locale);
    assert.equal(fromMain, fromWizard);
    assert.ok(!fromMain.includes("^"), locale);
    assert.ok(!fromMain.includes("$"), locale);
    assert.ok(!fromMain.includes("[a-z"), locale);
  }
});

test("empty, crash, and delete copy tell a non-engineer the next step", () => {
  assert.equal(t("empty.open", { name: "web" }, "en"), "Open web");
  assert.equal(t("empty.open", { name: "web" }, "zh"), "打开 web");
  assert.equal(t("starting.title", { name: "web" }, "en"), "Starting web…");
  assert.ok(t("starting.body", undefined, "en").includes("first start"));
  assert.equal(t("idle.open", { name: "Notes" }, "en"), "Open Notes");
  assert.ok(t("idle.body", undefined, "en").toLowerCase().includes("open"));
  assert.equal(t("idle.rename", undefined, "en"), "Rename");
  assert.equal(t("idle.remove", undefined, "zh"), "删除…");
  assert.ok(!t("menu.openFolder", undefined, "en").toLowerCase().includes("profile"));
  assert.ok(!t("menu.openFolder", undefined, "zh").includes("profile"));
  assert.ok(!t("queue.pluginAdd", { name: "notes" }, "en").includes("plugin add"));
  assert.equal(t("queue.pluginAdd", { name: "notes" }, "en"), "Installing plugin on notes");
  assert.ok(!t("onboarding.hide", undefined, "en").includes("profile"));
  assert.ok(!t("onboarding.hide", undefined, "zh").includes("profile"));
  assert.ok(t("empty.body", undefined, "en").includes("icons on the left"));
  assert.ok(!t("empty.body", undefined, "en").includes("rail"));
  assert.ok(!t("idle.body", undefined, "en").includes("rail"));
  assert.ok(!t("delete.removeRail", undefined, "en").includes("rail"));
  assert.ok(t("crash.hint", undefined, "en").toLowerCase().includes("error details"));
  assert.ok(!t("delete.removeRail", undefined, "en").includes("spaces.json"));
  assert.ok(!t("delete.deleteData", undefined, "en").includes("hub/"));
  assert.ok(!t("delete.alsoOfficial", undefined, "en").toLowerCase().includes("official"));
  assert.ok(!t("delete.alsoOfficial", undefined, "zh").includes("官方"));
  assert.ok(t("delete.alsoOfficial", undefined, "en").toLowerCase().includes("entire"));
  assert.ok(t("delete.alsoOfficial", undefined, "en").toLowerCase().includes("custom files"));
  assert.ok(t("delete.alsoOfficial", undefined, "zh").includes("整个"));
  assert.ok(t("delete.alsoOfficial", undefined, "zh").includes("自定义文件"));
  assert.equal(t("settings.tabGeneral", undefined, "en"), "General");
  assert.equal(t("settings.tabRuntime", undefined, "en"), "Versions");
  assert.equal(t("rail.plugins", undefined, "zh"), "插件管理");
  assert.equal(t("plugins.title", undefined, "en"), "Plugins");
  assert.equal(t("plugins.tabManage", undefined, "en"), "Manage");
  assert.equal(t("plugins.tabMarket", undefined, "en"), "Market");
  assert.ok(!t("create.intro", undefined, "en").toLowerCase().includes("isolated"));
  assert.ok(t("create.intro", undefined, "zh").includes("聊天"));
  assert.equal(t("settings.dshHome", undefined, "en"), "Data folder");
  assert.ok(!t("plugins.manageHint", undefined, "en").toLowerCase().includes("patch"));
  assert.ok(t("plugins.manageHint", undefined, "en").toLowerCase().includes("click"));
  assert.ok(t("plugins.marketHint", undefined, "en").toLowerCase().includes("download"));
  assert.equal(t("busy.select", { name: "Scratchpad" }, "en"), "Opening Scratchpad");
  assert.equal(t("busy.select", { name: "Scratchpad" }, "zh"), "正在打开 Scratchpad");
  assert.ok(!t("create.progressPatch", undefined, "en").toLowerCase().includes("dual-root"));
  assert.ok(!t("create.progressPatch", undefined, "en").toLowerCase().includes("patch"));
  assert.ok(!t("create.progressVerify", undefined, "en").includes("dump-config"));
  assert.ok(!t("create.progressPlugin", undefined, "en").includes("@deepseek-ai"));
  assert.ok(t("create.progressPatch", undefined, "zh").includes("聊天"));
  assert.ok(t("create.progressVerify", undefined, "en").toLowerCase().includes("start"));
  assert.equal(t("menu.openFolder", undefined, "en"), "Open folder");
  assert.ok(!t("menu.openFolder", undefined, "zh").includes("profile"));
  assert.ok(!t("settings.quitStop", undefined, "en").toLowerCase().includes("profile"));
  assert.ok(!t("settings.quitStop", undefined, "zh").includes("进程"));
  assert.ok(t("settings.quitStop", undefined, "en").toLowerCase().includes("space"));
  assert.ok(t("settings.quitHint", undefined, "en").toLowerCase().includes("tray"));
  assert.ok(t("settings.quitHint", undefined, "en").toLowerCase().includes("quit"));
  assert.ok(!t("settings.quitHint", undefined, "en").toLowerCase().includes("profile"));
  assert.ok(!t("settings.quitKeepMigrate", undefined, "en").toLowerCase().includes("profile"));
  assert.ok(t("tray.stopAll", undefined, "en").toLowerCase().includes("space"));
  assert.match(t("tray.stillRunning", undefined, "zh"), /托盘/);
  assert.match(t("tray.stillRunning", undefined, "en"), /tray/i);
  assert.ok(!t("errors.stopFailed", { detail: "x" }, "en").toLowerCase().includes("profile"));
  assert.ok(!t("errors.portNotReady", undefined, "en").toLowerCase().includes("port"));
  assert.ok(!t("errors.portNotReady", undefined, "zh").includes("端口"));
  assert.ok(t("errors.portNotReady", undefined, "en").toLowerCase().includes("restart"));
  assert.equal(
    visibleError("Error invoking remote method 'selectProfile': Error: 这个空间没能及时打开。请点重启。"),
    "这个空间没能及时打开。请点重启。",
  );
  assert.equal(visibleError(t("errors.portNotReady", undefined, "en")), t("errors.portNotReady", undefined, "en"));
  assert.ok(!t("plugins.catalogUrlHint", undefined, "en").includes("NanmiCoder"));
  assert.ok(!t("plugins.catalogUrlHint", undefined, "zh").includes("NanmiCoder"));
  assert.ok(!t("plugins.restartHint", { names: "web" }, "en").toLowerCase().includes("bundle"));
  assert.ok(!t("plugins.restartHint", { names: "web" }, "zh").includes("bundle"));
  assert.ok(t("plugins.restartHint", { names: "web" }, "en").toLowerCase().includes("plugin"));
  assert.ok(!t("create.folderHint", undefined, "en").toLowerCase().includes("official"));
  assert.ok(!t("create.folderHint", undefined, "zh").includes("官方"));
  assert.ok(t("create.folderHint", undefined, "en").toLowerCase().includes("disk"));
  assert.ok(t("icon.hint", undefined, "en").includes("Spaces icon"));
  assert.ok(t("icon.hint", undefined, "zh").includes("Spaces 图标"));
  assert.ok(t("icon.upload", undefined, "zh").includes("上传"));
});

test("settings persist locale and default missing values to system", () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-spaces-"));
  temps.push(home);
  const saved = writeSettings(home, { ...DEFAULT_HUB_SETTINGS, locale: "zh", theme: "light" });
  assert.equal(saved.locale, "zh");
  assert.equal(saved.theme, "light");
  const text = readFileSync(join(home, "hub", "settings.json"), "utf8");
  assert.match(text, /"locale": "zh"/);
  assert.match(text, /"theme": "light"/);
  assert.equal(readSettings(home).locale, "zh");
  assert.equal(readSettings(home).theme, "light");

  const other = mkdtempSync(join(tmpdir(), "dsh-spaces-"));
  temps.push(other);
  assert.equal(readSettings(other).locale, "system");
  assert.equal(readSettings(other).theme, "system");
});

test("readSettings keeps quitBehavior=keep and can store the one-time hint", () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-spaces-"));
  temps.push(home);
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(
    join(home, "hub", "settings.json"),
    `${JSON.stringify({ portStart: 3100, portEnd: 3199, quitBehavior: "keep" })}\n`,
  );
  const loaded = readSettings(home);
  assert.equal(loaded.quitBehavior, "keep");
  assert.equal(Boolean(loaded.quitKeepHintDismissed), false);
  const saved = writeSettings(home, { ...loaded, quitBehavior: "stop", quitKeepHintDismissed: true });
  assert.equal(saved.quitBehavior, "stop");
  assert.equal(saved.quitKeepHintDismissed, true);
  assert.equal(readSettings(home).quitKeepHintDismissed, true);
  assert.equal(readSettings(home).quitBehavior, "stop");
});
