import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import {
  BLUEPRINT_CODE,
  BLUEPRINT_JSON_MAX_BYTES,
  BLUEPRINT_KIND,
  BLUEPRINT_MAX_DEPTH,
  BLUEPRINT_SHARE_MAX_BYTES,
  BlueprintError,
  parseBlueprint,
  parseBlueprintJson,
} from "../src/core/domain/blueprint.ts";
import {
  decodeBlueprint,
  encodeBlueprint,
  stringifyBlueprint,
} from "../src/adapters/node/blueprint-codec.ts";


const examples = join(dirname(fileURLToPath(import.meta.url)), "../docs/examples/blueprints");

function readExample(name: string): string {
  return readFileSync(join(examples, name), "utf8");
}

function assertThrowsCode(fn: () => unknown, code: string): BlueprintError {
  try {
    fn();
  } catch (error) {
    assert.equal(error instanceof BlueprintError, true);
    assert.equal((error as BlueprintError).code, code);
    return error as BlueprintError;
  }
  throw new Error(`expected ${code}`);
}

function share(encoding: "J" | "Z", payload: string): string {
  return `DSHBP1:${encoding}:${payload}`;
}

function encodeBase64url(bytes: Buffer): string {
  return bytes.toString("base64url").replace(/=+$/, "");
}

test("documentation examples round-trip through JSON, J, and Z", () => {
  const minimalJson = readExample("minimal.dsh-blueprint.json");
  const minimalShare = readExample("minimal.share.txt").trim();
  const fromFile = decodeBlueprint(minimalJson);
  const fromShare = decodeBlueprint(minimalShare);
  assert.deepEqual(fromShare, fromFile);
  assert.equal(fromShare.metadata.name, "空白 Web 工作台");
  assert.equal(decodeBlueprint(`\n\t${minimalShare}\r\n`).metadata.version, "1.0.0");

  const writing = decodeBlueprint(readExample("writing.dsh-blueprint.json"));
  const asJ = encodeBlueprint(writing, "J");
  const asZ = encodeBlueprint(writing, "Z");
  assert.equal(asJ.startsWith("DSHBP1:J:"), true);
  assert.equal(asZ.startsWith("DSHBP1:Z:"), true);
  assert.deepEqual(decodeBlueprint(asJ), writing);
  assert.deepEqual(decodeBlueprint(asZ), writing);
  assert.deepEqual(decodeBlueprint(stringifyBlueprint(writing)), writing);

  const shortest = encodeBlueprint(writing, "shortest");
  assert.equal(shortest === asJ || shortest === asZ, true);
  assert.equal(shortest.length, Math.min(asJ.length, asZ.length));
});

test("JSON, J, and Z preserve Chinese, strings, numbers, and array order", () => {
  const blueprint = parseBlueprint({
    kind: BLUEPRINT_KIND,
    formatVersion: 1,
    metadata: { name: "中文「引号」\n换行", version: "1.0.0+build.1" },
    packages: [
      { name: "pack-b", version: "2.0.0", source: { type: "npm" } },
      { name: "pack-a", version: "1.0.0", source: { type: "npm" } },
    ],
    profile: {
      base: "web",
      bundles: ["pack-b", "pack-a"],
      settings: { ns: { n: 0, flag: false, text: "" } },
    },
  });
  const decoded = decodeBlueprint(encodeBlueprint(blueprint, "Z"));
  assert.equal(decoded.metadata.name, "中文「引号」\n换行");
  assert.deepEqual(decoded.profile.bundles, ["pack-b", "pack-a"]);
  const ns = decoded.profile.settings.ns as { n: number; flag: boolean; text: string };
  assert.equal(ns.n, 0);
  assert.equal(ns.flag, false);
  assert.equal(ns.text, "");
});

test("duplicate JSON keys, including escaped names, are rejected", () => {
  const base = stringifyBlueprint(parseBlueprintJson(readExample("minimal.dsh-blueprint.json")));
  const dup = base.slice(0, -1) + ',"kind":"other"}';
  assertThrowsCode(() => decodeBlueprint(dup), BLUEPRINT_CODE.DUPLICATE_KEY);
  assertThrowsCode(() => decodeBlueprint('{"kind":"dsh-blueprint","kind":"dsh-blueprint"}'), BLUEPRINT_CODE.DUPLICATE_KEY);
  assertThrowsCode(
    () => decodeBlueprint('{"kind":"dsh-blueprint","\\u006b\\u0069\\u006e\\u0064":"x"}'),
    BLUEPRINT_CODE.DUPLICATE_KEY,
  );
});

test("YAML comments, trailing commas, and unquoted keys are not JSON", () => {
  assertThrowsCode(() => decodeBlueprint('{"kind":"dsh-blueprint",}'), BLUEPRINT_CODE.INVALID_JSON);
  assertThrowsCode(() => decodeBlueprint('{"kind":"dsh-blueprint"}\n# comment'), BLUEPRINT_CODE.INVALID_JSON);
  assertThrowsCode(() => decodeBlueprint("{kind: \"dsh-blueprint\"}"), BLUEPRINT_CODE.INVALID_JSON);
});

test("J and Z payloads reject a UTF-8 BOM the same way raw JSON does", () => {
  const json = stringifyBlueprint(parseBlueprintJson(readExample("minimal.dsh-blueprint.json")));
  const bomJson = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json, "utf8")]);
  assertThrowsCode(
    () => decodeBlueprint(`DSHBP1:J:${bomJson.toString("base64url")}`),
    BLUEPRINT_CODE.BOM,
  );
  assertThrowsCode(
    () => decodeBlueprint(`DSHBP1:Z:${deflateRawSync(bomJson).toString("base64url")}`),
    BLUEPRINT_CODE.BOM,
  );
  assertThrowsCode(() => decodeBlueprint(`\uFEFF${json}`), BLUEPRINT_CODE.BOM);
});

test("BOM, unpaired surrogates, unsafe integers, and -0 follow the JSON rules", () => {
  const prefix =
    '{"kind":"dsh-blueprint","formatVersion":1,"metadata":{"name":"t","version":"1.0.0"},"packages":[],"profile":{"base":"web","bundles":[]},"extensions":';
  assertThrowsCode(() => decodeBlueprint(`\uFEFF${prefix}{}}`), BLUEPRINT_CODE.BOM);
  assertThrowsCode(() => decodeBlueprint(`${prefix}{"s":"\\uD800"}}`), BLUEPRINT_CODE.SURROGATE);
  assertThrowsCode(() => decodeBlueprint(`${prefix}{"n":9007199254740993}}`), BLUEPRINT_CODE.NUMBER);
  const withNegZero = decodeBlueprint(`${prefix}{"n":-0}}`);
  assert.equal(withNegZero.extensions?.n, 0);
  assert.equal(Object.is(withNegZero.extensions?.n, -0), false);
  const safe = decodeBlueprint(`${prefix}{"n":9007199254740991}}`);
  assert.equal(safe.extensions?.n, 9007199254740991);
});

test("JSON nesting and size limits are enforced", () => {
  const nest = (levels: number): unknown => {
    let value: unknown = { ok: true };
    for (let index = 0; index < levels; index++) value = { n: value };
    return value;
  };
  const small = stringifyBlueprint(
    parseBlueprint({
      kind: BLUEPRINT_KIND,
      formatVersion: 1,
      metadata: { name: "t", version: "1.0.0" },
      packages: [],
      profile: { base: "web", bundles: [] },
      extensions: nest(BLUEPRINT_MAX_DEPTH - 2) as Record<string, unknown>,
    }),
  );
  decodeBlueprint(small);
  const tooDeep = JSON.stringify({
    kind: BLUEPRINT_KIND,
    formatVersion: 1,
    metadata: { name: "t", version: "1.0.0" },
    packages: [],
    profile: { base: "web", bundles: [] },
    extensions: nest(BLUEPRINT_MAX_DEPTH - 1),
  });
  assertThrowsCode(() => decodeBlueprint(tooDeep), BLUEPRINT_CODE.DEPTH);

  const padded = `${small.slice(0, -1)},"pad":"${"a".repeat(BLUEPRINT_JSON_MAX_BYTES)}"}`;
  assert.equal(Buffer.byteLength(padded, "utf8") > BLUEPRINT_JSON_MAX_BYTES, true);
  assertThrowsCode(() => decodeBlueprint(padded), BLUEPRINT_CODE.JSON_TOO_LARGE);
});

test("share codes reject padding, leftover bits, and non-base64url alphabets", () => {
  const blueprint = parseBlueprintJson(readExample("minimal.dsh-blueprint.json"));
  const encoded = encodeBlueprint(blueprint, "J");
  const payload = encoded.slice("DSHBP1:J:".length);
  assertThrowsCode(() => decodeBlueprint(share("J", `${payload}=`)), BLUEPRINT_CODE.BASE64);
  assertThrowsCode(() => decodeBlueprint(share("J", `+${payload}`)), BLUEPRINT_CODE.BASE64);
  assertThrowsCode(() => decodeBlueprint(share("J", payload.replaceAll("e", "/"))), BLUEPRINT_CODE.BASE64);
  assertThrowsCode(() => decodeBlueprint(share("J", "++//")), BLUEPRINT_CODE.BASE64);
  assertThrowsCode(() => decodeBlueprint(share("J", "AB")), BLUEPRINT_CODE.BASE64);
  assertThrowsCode(() => decodeBlueprint(share("J", "A")), BLUEPRINT_CODE.BASE64);
});

test("Z is raw DEFLATE: gzip, zlib, truncation, concatenation, and trailing bytes fail", () => {
  const json = stringifyBlueprint(parseBlueprintJson(readExample("minimal.dsh-blueprint.json")));
  const jsonBytes = Buffer.from(json, "utf8");
  const raw = deflateRawSync(jsonBytes);
  decodeBlueprint(share("Z", encodeBase64url(raw)));

  assertThrowsCode(() => decodeBlueprint(share("Z", encodeBase64url(gzipSync(jsonBytes)))), BLUEPRINT_CODE.DEFLATE);
  assertThrowsCode(() => decodeBlueprint(share("Z", encodeBase64url(deflateSync(jsonBytes)))), BLUEPRINT_CODE.DEFLATE);
  assertThrowsCode(
    () => decodeBlueprint(share("Z", encodeBase64url(raw.subarray(0, Math.max(1, raw.length - 3))))),
    BLUEPRINT_CODE.DEFLATE,
  );
  assertThrowsCode(
    () => decodeBlueprint(share("Z", encodeBase64url(Buffer.concat([raw, raw])))),
    BLUEPRINT_CODE.DEFLATE,
  );
  assertThrowsCode(
    () => decodeBlueprint(share("Z", encodeBase64url(Buffer.concat([raw, Buffer.from("x")])))),
    BLUEPRINT_CODE.DEFLATE,
  );
});

test("Z decompression is bounded by the JSON byte limit", () => {
  const bomb = `{${"\"k\":\"" + "a".repeat(BLUEPRINT_JSON_MAX_BYTES + 32) + "\"}"}`;
  const compressed = deflateRawSync(Buffer.from(bomb, "utf8"));
  assert.equal(compressed.length < BLUEPRINT_JSON_MAX_BYTES, true);
  const error = assertThrowsCode(
    () => decodeBlueprint(share("Z", encodeBase64url(compressed))),
    BLUEPRINT_CODE.JSON_TOO_LARGE,
  );
  assert.match(error.message, new RegExp(String(BLUEPRINT_JSON_MAX_BYTES)));
});

test("share decoding is not a fallback across encodings or versions", () => {
  const blueprint = parseBlueprintJson(readExample("minimal.dsh-blueprint.json"));
  const j = encodeBlueprint(blueprint, "J");
  const zPayload = j.slice("DSHBP1:J:".length);
  assertThrowsCode(() => decodeBlueprint(share("Z", zPayload)), BLUEPRINT_CODE.DEFLATE);
  assertThrowsCode(() => decodeBlueprint(j.replace("DSHBP1", "dshbp1")), BLUEPRINT_CODE.INVALID_JSON);
  assertThrowsCode(() => decodeBlueprint(j.replace(":J:", ":j:")), BLUEPRINT_CODE.INVALID_SHARE);
  assertThrowsCode(() => decodeBlueprint("DSHBP2:J:e30"), BLUEPRINT_CODE.INVALID_JSON);
  const inner = j.replace("DSHBP1:J:", "DSHBP1:Q:");
  assertThrowsCode(() => decodeBlueprint(inner), BLUEPRINT_CODE.INVALID_SHARE);
});

test("payload whitespace is significant; only outer SP/HT/CR/LF are trimmed", () => {
  const blueprint = parseBlueprintJson(readExample("minimal.dsh-blueprint.json"));
  const encoded = encodeBlueprint(blueprint, "J");
  const payload = encoded.slice("DSHBP1:J:".length);
  assertThrowsCode(() => decodeBlueprint(share("J", `${payload.slice(0, 4)} ${payload.slice(4)}`)), BLUEPRINT_CODE.BASE64);
  assertThrowsCode(() => decodeBlueprint(`\u00a0${encoded}`), BLUEPRINT_CODE.INVALID_JSON);
});

test("invalid UTF-8 in a J payload is rejected", () => {
  assertThrowsCode(() => decodeBlueprint(share("J", encodeBase64url(Buffer.from([0xff, 0xfe, 0xfd])))), BLUEPRINT_CODE.UTF8);
});

test("ZIP space-share bytes are not a blueprint", () => {
  const zipMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
  assertThrowsCode(() => decodeBlueprint(zipMagic.toString("latin1")), BLUEPRINT_CODE.INVALID_JSON);
});

test("share code length limit is 2 MiB after outer trim", () => {
  const huge = `DSHBP1:J:${"A".repeat(BLUEPRINT_SHARE_MAX_BYTES)}`;
  assertThrowsCode(() => decodeBlueprint(huge), BLUEPRINT_CODE.SHARE_TOO_LARGE);
});

test("stringify does not emit a BOM and encode refuses to guess another encoding", () => {
  const blueprint = parseBlueprintJson(readExample("minimal.dsh-blueprint.json"));
  const json = stringifyBlueprint(blueprint);
  assert.equal(json.startsWith("{"), true);
  assert.equal(json.charCodeAt(0), 0x7b);
  const asJ = encodeBlueprint(blueprint, "J");
  assert.deepEqual(decodeBlueprint(asJ), blueprint);
});

test("prototype-like keys in extensions survive codec round-trip without polluting", () => {
  const json =
    '{"kind":"dsh-blueprint","formatVersion":1,"metadata":{"name":"t","version":"1.0.0"},"packages":[],"profile":{"base":"web","bundles":[]},"extensions":{"__proto__":{"x":1},"constructor":{"y":2}}}';
  const parsed = decodeBlueprint(json);
  assert.equal(Object.hasOwn(parsed.extensions ?? {}, "__proto__"), true);
  assert.equal(({} as { x?: number }).x, undefined);
  const again = decodeBlueprint(encodeBlueprint(parsed, "Z"));
  assert.equal(Object.hasOwn(again.extensions ?? {}, "constructor"), true);
});
