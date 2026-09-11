import assert from "node:assert/strict";
import { test } from "node:test";
import { t } from "../src/shared/i18n/index.ts";
import {
  assertValidSpaceIcon,
  isUploadedSpaceIcon,
  sanitizeSpaceIcon,
  toSpaceIconDataUrl,
} from "../src/shared/space-icon.ts";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function dataUrl(mime: string, bytes: Buffer): string {
  return `data:image/${mime};base64,${bytes.toString("base64")}`;
}

test("uploaded icons are data URLs; missing and old presets are the whale", () => {
  assert.equal(isUploadedSpaceIcon(undefined), false);
  assert.equal(isUploadedSpaceIcon(""), false);
  assert.equal(isUploadedSpaceIcon("music"), false);
  assert.equal(isUploadedSpaceIcon("whale"), false);
  assert.equal(isUploadedSpaceIcon(dataUrl("png", PNG_1X1)), true);
  assert.equal(sanitizeSpaceIcon(undefined), "");
  assert.equal(sanitizeSpaceIcon(""), "");
  assert.equal(sanitizeSpaceIcon("  music  "), "");
  assert.equal(sanitizeSpaceIcon(dataUrl("png", PNG_1X1)), dataUrl("png", PNG_1X1));
});

test("valid PNG and SVG data URLs round-trip", () => {
  const png = toSpaceIconDataUrl("png", PNG_1X1);
  assert.ok(png.startsWith("data:image/png;base64,"));
  assertValidSpaceIcon(png);

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>');
  const encoded = toSpaceIconDataUrl("svg+xml", svg);
  assert.ok(encoded.startsWith("data:image/svg+xml;base64,"));
  assertValidSpaceIcon(encoded);
});

test("rejects scripts, non-images, and oversized payloads", () => {
  assert.equal(sanitizeSpaceIcon("https://example.com/x.png"), "");
  assert.throws(() => assertValidSpaceIcon("https://example.com/x.png"), { message: t("errors.iconInvalid") });
  assert.throws(() => assertValidSpaceIcon("data:image/png;base64,"), { message: t("errors.iconInvalid") });
  assert.throws(
    () =>
      toSpaceIconDataUrl(
        "svg+xml",
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      ),
    { message: t("errors.iconInvalid") },
  );
  assert.throws(
    () =>
      toSpaceIconDataUrl(
        "svg+xml",
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onclick="alert(1)"></svg>'),
      ),
    { message: t("errors.iconInvalid") },
  );
  const huge = `data:image/png;base64,${"A".repeat(240_001)}`;
  assert.throws(() => assertValidSpaceIcon(huge), { message: t("errors.iconTooLarge") });
});
