import assert from "node:assert/strict";
import { test } from "node:test";
import { fitEncodedIcon, iconShrinkSteps, svgIconDataUrl } from "../packages/plugin/src/workbench/fit-icon.ts";
import { validateWorkbenchIcon } from "../packages/plugin/src/workbench/icons.ts";

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("shrink steps keep aspect ratio and do not enlarge a small image", () => {
  const wide = iconShrinkSteps(1600, 900);
  assert.equal(wide[0]?.width, 256);
  assert.equal(wide[0]?.height, 144);
  assert.equal(wide[0]?.type, "image/png");

  const small = iconShrinkSteps(32, 16);
  assert.deepEqual(
    small.map((step) => [step.width, step.height, step.type]),
    [
      [32, 16, "image/png"],
      [32, 16, "image/jpeg"],
      [32, 16, "image/jpeg"],
      [32, 16, "image/jpeg"],
    ],
  );
});

test("encoded icons step down until the stored data URL fits", () => {
  const seen: number[] = [];
  const fitted = fitEncodedIcon(1600, 900, (step) => {
    seen.push(step.width);
    return step.width <= 64 && step.type === "image/png" ? TINY_PNG : `data:image/png;base64,${"A".repeat(240_000)}`;
  });
  assert.equal(fitted, TINY_PNG);
  assert.equal(seen[0], 256);
  assert.equal(seen.at(-1), 64);
  assert.equal(validateWorkbenchIcon(fitted ?? "").ok, true);
  assert.equal(
    fitEncodedIcon(80, 80, () => `data:image/png;base64,${"A".repeat(240_000)}`),
    null,
  );
});

test("small SVG icons stay vectors; scripts are rejected; oversized SVG is rasterized", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>';
  const encoded = svgIconDataUrl(svg);
  assert.equal(encoded.ok, true);
  if (encoded.ok) {
    assert.equal(encoded.icon.startsWith("data:image/svg+xml;base64,"), true);
    assert.equal(validateWorkbenchIcon(encoded.icon).ok, true);
  }
  assert.deepEqual(svgIconDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), {
    ok: false,
    reason: "invalid",
  });
  const huge = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><!--${"x".repeat(70_000)}--></svg>`;
  assert.deepEqual(svgIconDataUrl(huge), { ok: false, reason: "rasterize" });
});
