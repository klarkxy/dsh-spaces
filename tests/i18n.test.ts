import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  zh,
} from "../src/shared/i18n/index.ts";
import { resolveColorScheme } from "../src/shared/theme.ts";
import { readSettings, writeSettings } from "../src/main/hub-settings.ts";
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
