import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SPACE_AVATARS, DESKTOP_AVATAR_IMAGE, defaultSpaceAvatar } from "../../src/shared/space-avatars.ts";
import { sanitizeSpaceIcon } from "../../src/shared/space-icon.ts";
import { parsePortalSnapshot } from "../../src/shared/space-host.ts";
import { validateWorkbenchIcon } from "../../packages/plugin/src/workbench/icons.ts";
import { SpaceGlyph } from "../../packages/plugin/src/workbench/space-glyph.tsx";
import { IconPicker } from "../../packages/plugin/src/workbench/components.tsx";
import { NativeHostController, NativeHostShell } from "../../packages/plugin/src/client/native-host.tsx";

test("20 unique bundled avatars round-trip through client, stored icon and host presentation", () => {
  assert.equal(SPACE_AVATARS.length, 20);
  assert.equal(new Set(SPACE_AVATARS.map(a => a.image)).size, 20);
  assert.equal(new Set(SPACE_AVATARS.map(a => a.id)).size, 20);
  for (const avatar of SPACE_AVATARS) {
    assert.deepEqual(validateWorkbenchIcon(avatar.image), { ok: true, icon: avatar.image });
    const icon = sanitizeSpaceIcon(avatar.image);
    const snapshot = { serviceEpoch: "a".repeat(64), managerId: "hub", spaces: [{ id: "alpha", displayName: "Alpha", status: "running", generation: 1, icon }] };
    assert.deepEqual(parsePortalSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
    const bytes = Buffer.from(icon.split(",")[1], "base64");
    assert.equal(bytes.readUInt32BE(16), 128);
    assert.equal(bytes.readUInt32BE(20), 128);
  }
});

test("desktop avatar is exclusive and ordinary defaults stay stable across ordering", () => {
  assert.ok(!SPACE_AVATARS.some(a => a.image === DESKTOP_AVATAR_IMAGE));
  assert.equal(sanitizeSpaceIcon(DESKTOP_AVATAR_IMAGE), DESKTOP_AVATAR_IMAGE);
  assert.equal(defaultSpaceAvatar("alpha"), defaultSpaceAvatar("alpha"));
  assert.notEqual(defaultSpaceAvatar("alpha"), defaultSpaceAvatar("beta"));
  assert.ok(renderToStaticMarkup(<SpaceGlyph spaceId="desktop" icon={SPACE_AVATARS[0].image} />).includes(DESKTOP_AVATAR_IMAGE));
  assert.ok(renderToStaticMarkup(<SpaceGlyph spaceId="alpha" />).includes(defaultSpaceAvatar("alpha").image));
  assert.ok(renderToStaticMarkup(<SpaceGlyph spaceId="alpha" icon={SPACE_AVATARS[3].image} />).includes(SPACE_AVATARS[3].image));
});

test("picker exposes twenty named avatars with exactly one selected option", () => {
  const html = renderToStaticMarkup(<IconPicker locale="zh" value={SPACE_AVATARS[7].image} onChange={() => {}} />);
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
  for (const avatar of SPACE_AVATARS) assert.ok(html.includes('aria-label="' + avatar.zh + '"'));
  assert.ok(!html.includes(DESKTOP_AVATAR_IMAGE));
});

test("desktop stays first and outside the scrollable native space list", () => {
  const controller = new NativeHostController({} as never, {} as never);
  Object.assign(controller, { state: { phase: "ready", selected: "current", pending: null, error: null, guide: false,
    inventory: { serviceEpoch: "a".repeat(64), managerId: "hub", spaces: [
      { id: "alpha", displayName: "Alpha", status: "running", generation: 1, icon: SPACE_AVATARS[2].image },
      { id: "desktop", displayName: "Desktop duplicate", status: "running", generation: 1 },
    ] } } });
  const html = renderToStaticMarkup(<NativeHostShell controller={controller} />);
  assert.ok(html.indexOf('data-pinned="true"') < html.indexOf('class="dsh-host-rail-list"'));
  assert.equal((html.match(/data-space-id="desktop"/g) ?? []).length, 1);
  assert.ok(!html.includes("Desktop duplicate"));
  assert.ok(html.includes(SPACE_AVATARS[2].image));
});

test("presentation icon extension still rejects URLs and oversized payloads", () => {
  for (const icon of ["https://example.org/avatar.png", "file:///secret", "data:image/png;base64," + "A".repeat(240000), 42, null]) {
    assert.equal(parsePortalSnapshot({ serviceEpoch: "a".repeat(64), managerId: "hub",
      spaces: [{ id: "alpha", displayName: "Alpha", status: "running", generation: 1, icon }] }), null);
  }
});
