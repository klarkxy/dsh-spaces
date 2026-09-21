import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BLUEPRINT_JSON_MAX_BYTES,
  BLUEPRINT_SHARE_MAX_BYTES,
  type Blueprint,
} from "../src/shared/blueprint.ts";
import {
  bytesToBase64,
  collectBlueprintValues,
  decodeBlueprintFileBytes,
  limitDecodedText,
  listedProviderModels,
  parseFiniteNumber,
  utf8ToBase64,
  type BlueprintInputDraft,
} from "../packages/plugin/src/workbench/blueprint-session.ts";
import type { LlmDescribeResult } from "../src/shared/llm-api.ts";

function blueprintWithInputs(): Blueprint {
  return {
    kind: "dsh-blueprint",
    formatVersion: 1,
    metadata: { name: "Demo", version: "1.0.0" },
    packages: [],
    profile: { base: "web", bundles: [], patch: [], settings: {} },
    inputs: [
      { id: "title", type: "string", label: "Title", required: false },
      { id: "count", type: "number", label: "Count", required: false },
      { id: "flag", type: "boolean", label: "Flag", required: false },
      { id: "notes", type: "directory", label: "Notes", required: false },
    ],
    bindings: [],
    relations: [],
  };
}

test("JSON file with UTF-8 BOM is rejected and original data is retained", () => {
  const payload = new TextEncoder().encode('{"kind":"dsh-blueprint"}');
  const bytes = new Uint8Array(3 + payload.length);
  bytes.set([0xef, 0xbb, 0xbf], 0);
  bytes.set(payload, 3);
  const decoded = decodeBlueprintFileBytes(bytes);
  assert.equal(decoded.ok, false);
  if (decoded.ok) return;
  assert.equal(decoded.code, "bom");
  assert.equal(decoded.text, "\uFEFF{\"kind\":\"dsh-blueprint\"}");
});

test("invalid UTF-8 is rejected without fallback decoding", () => {
  const decoded = decodeBlueprintFileBytes(new Uint8Array([0xff, 0xfe, 0x00, 0x80]));
  assert.equal(decoded.ok, false);
  if (decoded.ok) return;
  assert.equal(decoded.code, "utf8");
  assert.equal(decoded.text, undefined);
});

test("JSON over 1MiB is rejected; share over 2MiB is rejected", () => {
  const json = new Uint8Array(BLUEPRINT_JSON_MAX_BYTES + 1);
  json[0] = 0x7b;
  json.fill(0x20, 1);
  json[json.length - 1] = 0x7d;
  const jsonDecoded = decodeBlueprintFileBytes(json);
  assert.equal(jsonDecoded.ok, false);
  if (!jsonDecoded.ok) assert.equal(jsonDecoded.code, "too-large-json");

  const share = new Uint8Array(BLUEPRINT_SHARE_MAX_BYTES + 1);
  const prefix = new TextEncoder().encode("DSHBP1:J:");
  share.set(prefix, 0);
  share.fill(0x41, prefix.length);
  const shareDecoded = decodeBlueprintFileBytes(share);
  assert.equal(shareDecoded.ok, false);
  if (!shareDecoded.ok) assert.equal(shareDecoded.code, "too-large-share");
});

test("pasted BOM character is rejected and original text kept", () => {
  const text = "\uFEFF{\"a\":1}";
  const limited = limitDecodedText(text);
  assert.equal(limited.ok, false);
  if (limited.ok) return;
  assert.equal(limited.code, "bom");
  assert.equal(limited.text, text);
});

test("collectBlueprintValues keeps 0, false and empty string, and omits missing", () => {
  const drafts: { [id: string]: BlueprintInputDraft } = {
    title: { present: true, text: "", booleanValue: false, model: null },
    count: { present: true, text: "0", booleanValue: false, model: null },
    flag: { present: true, text: "", booleanValue: false, model: null },
    notes: { present: false, text: "", booleanValue: false, model: null },
  };
  const { values, invalidNumber } = collectBlueprintValues(blueprintWithInputs(), drafts);
  assert.equal(invalidNumber, null);
  assert.equal(values.title, "");
  assert.equal(values.count, 0);
  assert.equal(values.flag, false);
  assert.equal("notes" in values, false);
});

test("empty number text is missing, not zero; NaN is invalid", () => {
  assert.equal(parseFiniteNumber(""), null);
  assert.equal(parseFiniteNumber("  "), null);
  assert.equal(parseFiniteNumber("0"), 0);
  assert.equal(parseFiniteNumber("abc"), null);
  const { values, invalidNumber } = collectBlueprintValues(blueprintWithInputs(), {
    count: { present: true, text: "abc", booleanValue: false, model: null },
  });
  assert.equal(invalidNumber, "count");
  assert.deepEqual(values, {});
  const empty = collectBlueprintValues(blueprintWithInputs(), {
    count: { present: true, text: "", booleanValue: false, model: null },
  });
  assert.equal(empty.invalidNumber, null);
  assert.equal("count" in empty.values, false);
});

test("utf8ToBase64 encodes non-ASCII without dropping characters", () => {
  const json = '{"name":"写作工作台"}';
  const encoded = utf8ToBase64(json);
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  assert.equal(decoded, json);
  const roundTrip = bytesToBase64(new TextEncoder().encode(json));
  assert.equal(roundTrip, encoded);
});

test("listedProviderModels keeps enabled configured connections and listed models only", () => {
  const describe: LlmDescribeResult = {
    revision: 1,
    defaultModel: null,
    pendingRestartSpaceIds: [],
    capabilities: {
      adapter: "llm-pi-ai",
      adapterVersion: "0.1.5-rc.2",
      protocols: ["openai-completions", "openai-responses", "anthropic-messages"],
      keyless: false,
    },
    connections: [
      {
        id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        revision: 1,
        displayName: "On",
        enabled: true,
        backend: "llm-pi-ai",
        providerConfig: { models: [{ id: "m1" }, { id: "m2" }] },
        auth: { kind: "api-key", configured: true },
        createdAt: "2026-09-21T00:00:00.000Z",
        updatedAt: "2026-09-21T00:00:00.000Z",
        usedBySpaceIds: [],
        routeId: "r1",
      },
      {
        id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        revision: 1,
        displayName: "Off",
        enabled: false,
        backend: "llm-pi-ai",
        providerConfig: { models: [{ id: "hidden" }] },
        auth: { kind: "api-key", configured: true },
        createdAt: "2026-09-21T00:00:00.000Z",
        updatedAt: "2026-09-21T00:00:00.000Z",
        usedBySpaceIds: [],
        routeId: "r2",
      },
    ],
  };
  const listed = listedProviderModels(describe);
  assert.deepEqual(
    listed.map((row) => `${row.connectionId}:${row.modelId}`),
    ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:m1", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:m2"],
  );
});
