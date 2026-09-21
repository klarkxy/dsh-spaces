import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  BLUEPRINT_CODE,
  BLUEPRINT_HOST_PACKAGES,
  BLUEPRINT_KIND,
  BLUEPRINT_MAX_DEPTH,
  BlueprintError,
  bindBlueprintInputs,
  diagnoseBlueprint,
  parseBlueprint,
  parseBlueprintJson,
} from "../src/core/domain/blueprint.ts";
import type { Blueprint, BlueprintInputValues } from "../src/shared/blueprint.ts";

const examples = join(dirname(fileURLToPath(import.meta.url)), "../docs/examples/blueprints");
const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "../schemas/blueprint-v1.schema.json");

function readExample(name: string): string {
  return readFileSync(join(examples, name), "utf8");
}

function minimalObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: BLUEPRINT_KIND,
    formatVersion: 1,
    metadata: { name: "t", version: "1.0.0" },
    packages: [],
    profile: { base: "web", bundles: [] },
    ...overrides,
  };
}

function writingToolsBlueprint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: BLUEPRINT_KIND,
    formatVersion: 1,
    metadata: { name: "w", version: "1.0.0" },
    packages: [
      { name: "@example/theme-paper", version: "1.2.0", source: { type: "npm" } },
      { name: "@example/theme-night", version: "1.0.0", source: { type: "npm" } },
      { name: "@example/writing-tools", version: "2.1.0", source: { type: "npm" } },
    ],
    profile: {
      base: "web",
      bundles: ["@example/theme-paper", "@example/writing-tools"],
      patch: [{ id: "example-writing-tools", config: { outputDirectory: null, outlineMode: "chapter" } }],
      settings: { prefs: { fontSize: 18, title: null } },
    },
    inputs: [
      { id: "output-directory", type: "directory", label: "out", required: true },
      { id: "writing-model", type: "model", label: "model", required: true },
    ],
    bindings: [
      {
        input: "output-directory",
        target: { kind: "value", pointer: "/profile/patch/0/config/outputDirectory" },
      },
      { input: "writing-model", target: { kind: "default-model" } },
    ],
    ...overrides,
  };
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

test("schema lists root fields and does not claim execution safety", () => {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
    $id: string;
    required: string[];
    $comment: string;
    properties: Record<string, unknown>;
  };
  assert.equal(schema.$id, "dsh-blueprint-v1");
  assert.deepEqual(schema.required, ["kind", "formatVersion", "metadata", "packages", "profile"]);
  for (const key of [
    "kind",
    "formatVersion",
    "metadata",
    "requirements",
    "packages",
    "profile",
    "inputs",
    "bindings",
    "relations",
    "testedWith",
    "extensions",
  ]) {
    assert.equal(key in schema.properties, true, key);
  }
  assert.match(schema.$comment, /runtime parser/i);
  assert.match(schema.$comment, /not execution-safe/i);
});

test("parses both documentation examples", () => {
  const minimal = parseBlueprintJson(readExample("minimal.dsh-blueprint.json"));
  assert.equal(minimal.metadata.name, "空白 Web 工作台");
  assert.deepEqual(minimal.packages, []);
  assert.deepEqual(minimal.profile.bundles, []);
  assert.deepEqual(minimal.inputs, []);

  const writing = parseBlueprintJson(readExample("writing.dsh-blueprint.json"));
  assert.equal(writing.packages.length, 3);
  assert.deepEqual(writing.profile.bundles, ["@example/theme-paper", "@example/writing-tools"]);
  assert.equal(writing.profile.patch[0] && "config" in writing.profile.patch[0], true);
});

test("closed fields reject unknowns; plugin config and extensions stay open", () => {
  assertThrowsCode(() => parseBlueprint(minimalObject({ extra: true })), BLUEPRINT_CODE.UNKNOWN_FIELD);
  const parsed = parseBlueprint(
    minimalObject({
      extensions: { "example.note": { ok: true } },
      profile: { base: "web", bundles: [], patch: [{ id: "row", config: { custom: { nested: 1 } } }] },
    }),
  );
  assert.equal((parsed.extensions?.["example.note"] as { ok: boolean }).ok, true);
  const row = parsed.profile.patch[0];
  assert.equal(row && "config" in row && (row.config as { custom: { nested: number } }).custom.nested, 1);
});

test("omitted fields are not null, and null is rejected outside placeholders", () => {
  assertThrowsCode(() => parseBlueprint(minimalObject({ metadata: null })), BLUEPRINT_CODE.INVALID_TYPE);
  assertThrowsCode(
    () => parseBlueprint(minimalObject({ profile: { base: "web", bundles: [], patch: null } })),
    BLUEPRINT_CODE.INVALID_TYPE,
  );
});

test("host and Spaces control packages cannot be selected or bundled", () => {
  for (const name of [...BLUEPRINT_HOST_PACKAGES, "@dsh-spaces/plugin"]) {
    assertThrowsCode(
      () =>
        parseBlueprint(
          minimalObject({
            packages: [{ name, version: "1.0.0", source: { type: "npm" } }],
            profile: { base: "web", bundles: [] },
          }),
        ),
      BLUEPRINT_CODE.INVALID_FIELD,
    );
  }
});

test("package versions must be exact npm SemVer; ranges stay on requirements", () => {
  assertThrowsCode(
    () =>
      parseBlueprint(
        minimalObject({
          packages: [{ name: "demo-plugin", version: "^1.0.0", source: { type: "npm" } }],
        }),
      ),
    BLUEPRINT_CODE.INVALID_FIELD,
  );
  assertThrowsCode(
    () =>
      parseBlueprint(
        minimalObject({
          packages: [{ name: "demo-plugin", version: "latest", source: { type: "npm" } }],
        }),
      ),
    BLUEPRINT_CODE.INVALID_FIELD,
  );
  const parsed = parseBlueprint(minimalObject({ requirements: { dsh: "^0.1.5-rc.2" } }));
  assert.equal(parsed.requirements?.dsh, "^0.1.5-rc.2");
});

test("GitHub sources reject integrity; npm integrity must be sha512 64 bytes", () => {
  assertThrowsCode(
    () =>
      parseBlueprint(
        minimalObject({
          packages: [
            {
              name: "demo-plugin",
              version: "1.0.0",
              source: { type: "github", repository: "acme/demo", commit: "a".repeat(40) },
              integrity: "sha512-" + "A".repeat(88),
            },
          ],
        }),
      ),
    BLUEPRINT_CODE.INVALID_FIELD,
  );
  const digest = Buffer.alloc(64, 7).toString("base64");
  const parsed = parseBlueprint(
    minimalObject({
      packages: [
        {
          name: "demo-plugin",
          version: "1.0.0",
          source: { type: "npm" },
          integrity: `sha512-${digest}`,
        },
      ],
    }),
  );
  assert.equal(parsed.packages[0]?.integrity?.startsWith("sha512-"), true);
});

test("directory and model cannot declare default; input ids are unique and shaped", () => {
  assertThrowsCode(
    () =>
      parseBlueprint(
        writingToolsBlueprint({
          inputs: [{ id: "output-directory", type: "directory", label: "out", required: true, default: "/tmp" }],
        }),
      ),
    BLUEPRINT_CODE.INVALID_FIELD,
  );
  assertThrowsCode(
    () =>
      parseBlueprint(
        writingToolsBlueprint({
          inputs: [{ id: "Bad_Id", type: "directory", label: "out", required: true }],
        }),
      ),
    BLUEPRINT_CODE.INVALID_FIELD,
  );
});

test("bindings reject missing inputs, unused inputs, overlap, and identity targets", () => {
  assertThrowsCode(
    () =>
      parseBlueprint(
        writingToolsBlueprint({
          bindings: [
            {
              input: "missing",
              target: { kind: "value", pointer: "/profile/patch/0/config/outputDirectory" },
            },
          ],
        }),
      ),
    BLUEPRINT_CODE.BINDING,
  );
  assertThrowsCode(
    () =>
      parseBlueprint(
        writingToolsBlueprint({
          inputs: [
            { id: "output-directory", type: "directory", label: "out", required: true },
            { id: "writing-model", type: "model", label: "model", required: true },
            { id: "unused", type: "string", label: "u", required: false },
          ],
        }),
      ),
    BLUEPRINT_CODE.BINDING,
  );
  assertThrowsCode(
    () =>
      parseBlueprint(
        writingToolsBlueprint({
          inputs: [
            { id: "output-directory", type: "directory", label: "out", required: true },
            { id: "writing-model", type: "model", label: "model", required: true },
            { id: "alias", type: "directory", label: "also", required: true },
          ],
          bindings: [
            {
              input: "output-directory",
              target: { kind: "value", pointer: "/profile/patch/0/config/outputDirectory" },
            },
            {
              input: "alias",
              target: { kind: "value", pointer: "/profile/patch/0/config/outputDirectory" },
            },
            { input: "writing-model", target: { kind: "default-model" } },
          ],
        }),
      ),
    BLUEPRINT_CODE.BINDING,
  );
  assertThrowsCode(
    () =>
      parseBlueprint(
        writingToolsBlueprint({
          profile: {
            base: "web",
            bundles: ["@example/theme-paper", "@example/writing-tools"],
            patch: [{ id: "example-writing-tools", config: { nested: { a: null } } }],
          },
          inputs: [
            { id: "outer", type: "string", label: "outer", required: true },
            { id: "inner", type: "string", label: "inner", required: true },
            { id: "writing-model", type: "model", label: "model", required: true },
          ],
          bindings: [
            { input: "outer", target: { kind: "value", pointer: "/profile/patch/0/config/nested" } },
            { input: "inner", target: { kind: "value", pointer: "/profile/patch/0/config/nested/a" } },
            { input: "writing-model", target: { kind: "default-model" } },
          ],
        }),
      ),
    BLUEPRINT_CODE.BINDING,
  );
  assertThrowsCode(
    () =>
      parseBlueprint(
        writingToolsBlueprint({
          bindings: [
            { input: "output-directory", target: { kind: "value", pointer: "/profile/patch/0/id" } },
            { input: "writing-model", target: { kind: "default-model" } },
          ],
        }),
      ),
    BLUEPRINT_CODE.POINTER,
  );
});

test("RFC 6901 is strict: no append, no create, no non-canonical indexes", () => {
  assertThrowsCode(
    () =>
      parseBlueprint(
        writingToolsBlueprint({
          bindings: [
            { input: "output-directory", target: { kind: "value", pointer: "/profile/patch/-/config/outputDirectory" } },
            { input: "writing-model", target: { kind: "default-model" } },
          ],
        }),
      ),
    BLUEPRINT_CODE.POINTER,
  );
  assertThrowsCode(
    () =>
      parseBlueprint(
        writingToolsBlueprint({
          bindings: [
            { input: "output-directory", target: { kind: "value", pointer: "/profile/patch/01/config/outputDirectory" } },
            { input: "writing-model", target: { kind: "default-model" } },
          ],
        }),
      ),
    BLUEPRINT_CODE.POINTER,
  );
  assertThrowsCode(
    () =>
      parseBlueprint(
        writingToolsBlueprint({
          bindings: [
            { input: "output-directory", target: { kind: "value", pointer: "/profile/settings" } },
            { input: "writing-model", target: { kind: "default-model" } },
          ],
        }),
      ),
    BLUEPRINT_CODE.POINTER,
  );
});

test("optional inputs cannot bind array elements; placeholders must already be null", () => {
  assertThrowsCode(
    () =>
      parseBlueprint(
        writingToolsBlueprint({
          profile: {
            base: "web",
            bundles: ["@example/theme-paper", "@example/writing-tools"],
            patch: [{ id: "example-writing-tools", config: { items: [null] } }],
          },
          inputs: [
            { id: "item", type: "string", label: "item", required: false },
            { id: "writing-model", type: "model", label: "model", required: true },
          ],
          bindings: [
            { input: "item", target: { kind: "value", pointer: "/profile/patch/0/config/items/0" } },
            { input: "writing-model", target: { kind: "default-model" } },
          ],
        }),
      ),
    BLUEPRINT_CODE.BINDING,
  );
  assertThrowsCode(
    () =>
      parseBlueprint(
        writingToolsBlueprint({
          profile: {
            base: "web",
            bundles: ["@example/theme-paper", "@example/writing-tools"],
            patch: [{ id: "example-writing-tools", config: { outputDirectory: "/tmp" } }],
          },
        }),
      ),
    BLUEPRINT_CODE.POINTER,
  );
});

test("at most one default-model; models cannot bind values", () => {
  assertThrowsCode(
    () =>
      parseBlueprint(
        writingToolsBlueprint({
          inputs: [
            { id: "output-directory", type: "directory", label: "out", required: true },
            { id: "writing-model", type: "model", label: "model", required: true },
            { id: "other-model", type: "model", label: "other", required: false },
          ],
          bindings: [
            {
              input: "output-directory",
              target: { kind: "value", pointer: "/profile/patch/0/config/outputDirectory" },
            },
            { input: "writing-model", target: { kind: "default-model" } },
            { input: "other-model", target: { kind: "default-model" } },
          ],
        }),
      ),
    BLUEPRINT_CODE.BINDING,
  );
  assertThrowsCode(
    () =>
      parseBlueprint(
        writingToolsBlueprint({
          bindings: [
            {
              input: "writing-model",
              target: { kind: "value", pointer: "/profile/patch/0/config/outputDirectory" },
            },
            { input: "output-directory", target: { kind: "default-model" } },
          ],
        }),
      ),
    BLUEPRINT_CODE.BINDING,
  );
});

test("root insert then same-id overlay then later override stays ordered and unmerged", () => {
  const blueprint = parseBlueprint(
    minimalObject({
      packages: [{ name: "demo-plugin", version: "1.0.0", source: { type: "npm" } }],
      profile: {
        base: "web",
        bundles: ["demo-plugin"],
        patch: [
          { insert: [{ id: "row", name: "demo-plugin", config: { a: 1 }, disabled: false }] },
          { id: "row", config: { a: 2 } },
          { id: "row", disabled: true },
        ],
      },
    }),
  );
  assert.equal(blueprint.profile.patch.length, 3);
  assert.equal("insert" in blueprint.profile.patch[0]!, true);
  assert.equal((blueprint.profile.patch[1] as { id: string; config: { a: number } }).config.a, 2);
  assert.equal((blueprint.profile.patch[2] as { id: string; disabled: boolean }).disabled, true);
  assert.equal((blueprint.profile.patch[1] as { name?: string }).name, undefined);
});

test("targeted group insert {id,insert} is official and binds inserted config", () => {
  const blueprint = parseBlueprint(
    minimalObject({
      packages: [{ name: "demo-plugin", version: "1.0.0", source: { type: "npm" } }],
      profile: {
        base: "web",
        bundles: ["demo-plugin"],
        patch: [
          { insert: [{ id: "g", name: "cordis:group", group: true, config: [] }] },
          { id: "g", insert: [{ id: "child", name: "demo-plugin", config: { output: null } }] },
        ],
      },
      inputs: [{ id: "output", type: "string", label: "out", required: true }],
      bindings: [
        { input: "output", target: { kind: "value", pointer: "/profile/patch/1/insert/0/config/output" } },
      ],
    }),
  );
  const bound = bindBlueprintInputs(blueprint, { output: "notes" });
  const op = bound.patch[1] as { id: string; insert: Array<{ config: { output: string } }> };
  assert.equal(op.id, "g");
  assert.equal(op.insert[0]?.config.output, "notes");
  const diagnostics = diagnoseBlueprint(blueprint);
  assert.equal(diagnostics.some((item) => item.code === "blueprint.patch.insert-target.not-group"), false);
});

test("duplicate inserted ids in one scope are diagnosed, not a format error", () => {
  const blueprint = parseBlueprint(
    minimalObject({
      packages: [{ name: "demo-plugin", version: "1.0.0", source: { type: "npm" } }],
      profile: {
        base: "web",
        bundles: ["demo-plugin"],
        patch: [
          {
            insert: [
              { id: "row", name: "demo-plugin", config: { a: 1 } },
              { id: "row", name: "demo-plugin", config: { a: 2 } },
            ],
          },
        ],
      },
    }),
  );
  assert.equal((blueprint.profile.patch[0] as { insert: unknown[] }).insert.length, 2);
  assert.equal(
    diagnoseBlueprint(blueprint).some((item) => item.code === "blueprint.patch.entry.duplicate"),
    true,
  );
});

test("inherited group insert is structurally valid and unresolved for backend composition", () => {
  const blueprint = parseBlueprint(
    minimalObject({
      packages: [{ name: "demo-plugin", version: "1.0.0", source: { type: "npm" } }],
      profile: {
        base: "web",
        bundles: ["demo-plugin"],
        patch: [{ id: "host-group", insert: [{ id: "child", name: "demo-plugin", config: { x: 1 } }] }],
      },
    }),
  );
  assert.equal((blueprint.profile.patch[0] as { id?: string }).id, "host-group");
  assert.equal(
    diagnoseBlueprint(blueprint).some((item) => item.code === "blueprint.patch.target.unresolved"),
    true,
  );
});

test("plugin config may be null, scalar, or JSON array; whole config is not a bind target", () => {
  const parsed = parseBlueprint(
    minimalObject({
      packages: [{ name: "demo-plugin", version: "1.0.0", source: { type: "npm" } }],
      profile: {
        base: "web",
        bundles: ["demo-plugin"],
        patch: [
          { id: "cleared", config: null, disabled: null, group: null, inject: null, intercept: null, isolate: null },
          { id: "scalar", config: 3 },
          { id: "list", config: [null, { a: null }] },
        ],
      },
      inputs: [
        { id: "item", type: "string", label: "item", required: true },
        { id: "field", type: "string", label: "field", required: true },
      ],
      bindings: [
        { input: "item", target: { kind: "value", pointer: "/profile/patch/2/config/0" } },
        { input: "field", target: { kind: "value", pointer: "/profile/patch/2/config/1/a" } },
      ],
    }),
  );
  assert.equal((parsed.profile.patch[0] as { config: null }).config, null);
  assert.equal(Object.hasOwn(parsed.profile.patch[0] as object, "config"), true);
  assert.equal((parsed.profile.patch[0] as { disabled: null }).disabled, null);
  assert.equal((parsed.profile.patch[1] as { config: number }).config, 3);
  const bound = bindBlueprintInputs(parsed, { item: "one", field: "two" });
  const list = (bound.patch[2] as { config: unknown[] }).config;
  assert.equal(list[0], "one");
  assert.equal((list[1] as { a: string }).a, "two");
  assertThrowsCode(
    () =>
      parseBlueprint(
        minimalObject({
          packages: [{ name: "demo-plugin", version: "1.0.0", source: { type: "npm" } }],
          profile: {
            base: "web",
            bundles: ["demo-plugin"],
            patch: [{ id: "cleared", config: null }],
          },
          inputs: [{ id: "all", type: "string", label: "all", required: true }],
          bindings: [{ input: "all", target: { kind: "value", pointer: "/profile/patch/0/config" } }],
        }),
      ),
    BLUEPRINT_CODE.POINTER,
  );
});

test("group children only bind config values, never identity or disabled", () => {
  const groupPatch = {
    id: "g",
    group: true,
    config: [{ id: "child", name: "demo-plugin", config: { x: null }, disabled: false }],
  };
  const parsed = parseBlueprint(
    minimalObject({
      packages: [{ name: "demo-plugin", version: "1.0.0", source: { type: "npm" } }],
      profile: { base: "web", bundles: ["demo-plugin"], patch: [groupPatch] },
      inputs: [{ id: "x", type: "string", label: "x", required: true }],
      bindings: [{ input: "x", target: { kind: "value", pointer: "/profile/patch/0/config/0/config/x" } }],
    }),
  );
  const bound = bindBlueprintInputs(parsed, { x: "ok" });
  const child = (bound.patch[0] as { config: Array<{ config: { x: string }; id: string; disabled: boolean }> }).config[0];
  assert.equal(child?.config.x, "ok");
  assert.equal(child?.id, "child");
  assert.equal(child?.disabled, false);
  for (const pointer of [
    "/profile/patch/0/config/0/id",
    "/profile/patch/0/config/0/name",
    "/profile/patch/0/config/0/disabled",
    "/profile/patch/0/config/0",
  ]) {
    assertThrowsCode(
      () =>
        parseBlueprint(
          minimalObject({
            packages: [{ name: "demo-plugin", version: "1.0.0", source: { type: "npm" } }],
            profile: { base: "web", bundles: ["demo-plugin"], patch: [groupPatch] },
            inputs: [{ id: "x", type: "string", label: "x", required: true }],
            bindings: [{ input: "x", target: { kind: "value", pointer } }],
          }),
        ),
      BLUEPRINT_CODE.POINTER,
    );
  }
});

test("module subpaths reject traversal segments and unsupported schemes", () => {
  const badNames = ["demo-plugin/../../escape", "demo-plugin/./x", "demo-plugin//x", "link:demo-plugin", "cordis:../group"];
  for (const name of badNames) {
    assertThrowsCode(
      () =>
        parseBlueprint(
          minimalObject({
            packages: [{ name: "demo-plugin", version: "1.0.0", source: { type: "npm" } }],
            profile: {
              base: "web",
              bundles: ["demo-plugin"],
              patch: [{ insert: [{ id: "row", name, config: {} }] }],
            },
          }),
        ),
      BLUEPRINT_CODE.DYNAMIC,
    );
  }
  const ok = parseBlueprint(
    minimalObject({
      packages: [{ name: "demo-plugin", version: "1.0.0", source: { type: "npm" } }],
      profile: {
        base: "web",
        bundles: ["demo-plugin"],
        patch: [{ insert: [{ id: "row", name: "demo-plugin/export/sub", config: {} }] }],
      },
    }),
  );
  assert.equal((ok.profile.patch[0] as { insert: Array<{ name: string }> }).insert[0]?.name, "demo-plugin/export/sub");
});

test("bound string and directory values reject unpaired surrogates; !!js strings stay data", () => {
  const blueprint = parseBlueprint(
    writingToolsBlueprint({
      inputs: [
        { id: "output-directory", type: "directory", label: "out", required: true },
        { id: "note", type: "string", label: "note", required: true },
        { id: "writing-model", type: "model", label: "model", required: true },
      ],
      bindings: [
        {
          input: "output-directory",
          target: { kind: "value", pointer: "/profile/patch/0/config/outputDirectory" },
        },
        { input: "note", target: { kind: "value", pointer: "/profile/patch/0/config/outlineMode" } },
        { input: "writing-model", target: { kind: "default-model" } },
      ],
      profile: {
        base: "web",
        bundles: ["@example/theme-paper", "@example/writing-tools"],
        patch: [{ id: "example-writing-tools", config: { outputDirectory: null, outlineMode: null } }],
      },
    }),
  );
  assertThrowsCode(
    () =>
      bindBlueprintInputs(blueprint, {
        "output-directory": "\uD800",
        note: "ok",
        "writing-model": { connectionId: "c", modelId: "m" },
      }),
    BLUEPRINT_CODE.SURROGATE,
  );
  const bound = bindBlueprintInputs(blueprint, {
    "output-directory": "/tmp/out",
    note: "!!js dshHomePath('hub/x')",
    "writing-model": { connectionId: "c", modelId: "m" },
  });
  assert.equal(
    (bound.patch[0] as { config: { outlineMode: string } }).config.outlineMode,
    "!!js dshHomePath('hub/x')",
  );
});

test("official insert entries bind inside config and keep module names as data", () => {
  const blueprint = parseBlueprint(
    minimalObject({
      packages: [{ name: "demo-plugin", version: "1.0.0", source: { type: "npm" } }],
      profile: {
        base: "web",
        bundles: ["demo-plugin"],
        patch: [
          {
            insert: [{ id: "demo", name: "demo-plugin", config: { output: null }, disabled: false }],
          },
        ],
      },
      inputs: [{ id: "output", type: "string", label: "out", required: true, default: "notes" }],
      bindings: [{ input: "output", target: { kind: "value", pointer: "/profile/patch/0/insert/0/config/output" } }],
    }),
  );
  const bound = bindBlueprintInputs(blueprint, {});
  const inserted = bound.patch[0] as { insert: Array<{ name: string; config: { output: string }; disabled: boolean }> };
  assert.equal(inserted.insert[0]?.name, "demo-plugin");
  assert.equal(inserted.insert[0]?.config.output, "notes");
  assert.equal(inserted.insert[0]?.disabled, false);
});

test("managed isolation entries cannot be binding targets", () => {
  assertThrowsCode(
    () =>
      parseBlueprint(
        writingToolsBlueprint({
          profile: {
            base: "web",
            bundles: ["@example/theme-paper", "@example/writing-tools"],
            patch: [{ id: "session-persistence-jsonl", config: { root: null } }],
          },
          bindings: [
            { input: "output-directory", target: { kind: "value", pointer: "/profile/patch/0/config/root" } },
            { input: "writing-model", target: { kind: "default-model" } },
          ],
        }),
      ),
    BLUEPRINT_CODE.POINTER,
  );
});

test("forbidden settings namespaces and dynamic loader objects are rejected", () => {
  assertThrowsCode(
    () =>
      parseBlueprint(
        minimalObject({
          profile: { base: "web", bundles: [], settings: { "llm-pi-ai": { model: "x" } } },
        }),
      ),
    BLUEPRINT_CODE.INVALID_FIELD,
  );
  assertThrowsCode(
    () =>
      parseBlueprint(
        minimalObject({
          profile: {
            base: "web",
            bundles: [],
            patch: [{ id: "row", config: { expr: { __jsExpr: "dshHomePath('hub/x')" } } }],
          },
        }),
      ),
    BLUEPRINT_CODE.DYNAMIC,
  );
  assertThrowsCode(
    () =>
      parseBlueprint(
        minimalObject({
          profile: {
            base: "web",
            bundles: [],
            patch: [{ insert: [{ id: "row", name: "file:./plugin.js", config: {} }] }],
          },
        }),
      ),
    BLUEPRINT_CODE.DYNAMIC,
  );
  assertThrowsCode(
    () =>
      parseBlueprint(
        minimalObject({
          profile: {
            base: "web",
            bundles: [],
            patch: [{ insert: [{ id: "row", name: "demo; rm -rf /", config: {} }] }],
          },
        }),
      ),
    BLUEPRINT_CODE.DYNAMIC,
  );
});

test("bind uses explicit values over defaults; false, 0, and empty string stay filled", () => {
  const blueprint = parseBlueprint(
    writingToolsBlueprint({
      inputs: [
        { id: "output-directory", type: "directory", label: "out", required: true },
        { id: "writing-model", type: "model", label: "model", required: true },
        { id: "flag", type: "boolean", label: "flag", required: false, default: true },
        { id: "count", type: "number", label: "count", required: false, default: 4 },
        { id: "title", type: "string", label: "title", required: false, default: "Chapter" },
      ],
      bindings: [
        {
          input: "output-directory",
          target: { kind: "value", pointer: "/profile/patch/0/config/outputDirectory" },
        },
        { input: "writing-model", target: { kind: "default-model" } },
        { input: "flag", target: { kind: "value", pointer: "/profile/settings/prefs/showWordCount" } },
        { input: "count", target: { kind: "value", pointer: "/profile/settings/prefs/fontSize" } },
        { input: "title", target: { kind: "value", pointer: "/profile/settings/prefs/title" } },
      ],
      profile: {
        base: "web",
        bundles: ["@example/theme-paper", "@example/writing-tools"],
        patch: [{ id: "example-writing-tools", config: { outputDirectory: null } }],
        settings: { prefs: { fontSize: null, showWordCount: null, title: null } },
      },
    }),
  );
  const bound = bindBlueprintInputs(blueprint, {
    "output-directory": "D:\\notes",
    "writing-model": { connectionId: "conn-local", modelId: "demo" },
    flag: false,
    count: 0,
    title: "",
  });
  const config = (bound.patch[0] as { config: Record<string, unknown> }).config;
  const prefs = bound.settings.prefs as Record<string, unknown>;
  assert.equal(config.outputDirectory, "D:\\notes");
  assert.equal(prefs.showWordCount, false);
  assert.equal(prefs.fontSize, 0);
  assert.equal(prefs.title, "");
  assert.deepEqual(bound.model, { connectionId: "conn-local", modelId: "demo" });
});

test("missing optional value deletes the placeholder; missing optional model does not bind", () => {
  const blueprint = parseBlueprint(
    writingToolsBlueprint({
      inputs: [
        { id: "output-directory", type: "directory", label: "out", required: true },
        { id: "writing-model", type: "model", label: "model", required: false },
        { id: "title", type: "string", label: "title", required: false },
      ],
      bindings: [
        {
          input: "output-directory",
          target: { kind: "value", pointer: "/profile/patch/0/config/outputDirectory" },
        },
        { input: "writing-model", target: { kind: "default-model" } },
        { input: "title", target: { kind: "value", pointer: "/profile/settings/prefs/title" } },
      ],
    }),
  );
  const bound = bindBlueprintInputs(blueprint, { "output-directory": "/tmp/out" });
  const prefs = bound.settings.prefs as Record<string, unknown>;
  assert.equal(Object.hasOwn(prefs, "title"), false);
  assert.equal(bound.model, undefined);
  const config = (bound.patch[0] as { config: Record<string, unknown> }).config;
  assert.equal(config.outputDirectory, "/tmp/out");
});

test("required input missing is an identifiable bind error", () => {
  const blueprint = parseBlueprintJson(readExample("writing.dsh-blueprint.json"));
  const error = assertThrowsCode(() => bindBlueprintInputs(blueprint, {}), BLUEPRINT_CODE.INPUT_REQUIRED);
  assert.match(error.message, /output-directory/);
});

test("defaults apply only when the input is omitted, not when an explicit value is provided", () => {
  const blueprint = parseBlueprint(
    writingToolsBlueprint({
      inputs: [
        { id: "output-directory", type: "directory", label: "out", required: true },
        { id: "writing-model", type: "model", label: "model", required: true },
        { id: "flag", type: "boolean", label: "flag", required: true, default: true },
      ],
      bindings: [
        {
          input: "output-directory",
          target: { kind: "value", pointer: "/profile/patch/0/config/outputDirectory" },
        },
        { input: "writing-model", target: { kind: "default-model" } },
        { input: "flag", target: { kind: "value", pointer: "/profile/settings/prefs/showWordCount" } },
      ],
      profile: {
        base: "web",
        bundles: ["@example/theme-paper", "@example/writing-tools"],
        patch: [{ id: "example-writing-tools", config: { outputDirectory: null } }],
        settings: { prefs: { showWordCount: null } },
      },
    }),
  );
  const withDefault = bindBlueprintInputs(blueprint, {
    "output-directory": "/tmp",
    "writing-model": { connectionId: "c", modelId: "m" },
  });
  assert.equal((withDefault.settings.prefs as { showWordCount: boolean }).showWordCount, true);
  const explicit = bindBlueprintInputs(blueprint, {
    "output-directory": "/tmp",
    "writing-model": { connectionId: "c", modelId: "m" },
    flag: false,
  });
  assert.equal((explicit.settings.prefs as { showWordCount: boolean }).showWordCount, false);
});

test("writing example relations diagnose composition without rewriting the blueprint", () => {
  const blueprint = parseBlueprintJson(readExample("writing.dsh-blueprint.json"));
  const diagnostics = diagnoseBlueprint(blueprint);
  assert.equal(
    diagnostics.some((item) => item.code === "blueprint.relation.conflicts.not-current"),
    true,
  );
  assert.equal(
    diagnostics.some((item) => item.code === "blueprint.relation.requires.unselected"),
    false,
  );
  assert.equal(
    diagnostics.some((item) => item.code === "blueprint.relation.after"),
    false,
  );
  assert.deepEqual(blueprint.profile.bundles, ["@example/theme-paper", "@example/writing-tools"]);
});

test("requires reports unselected targets and does not treat unknown versions as compatible", () => {
  const blueprint = parseBlueprint(
    writingToolsBlueprint({
      relations: [
        {
          type: "requires",
          from: "@example/writing-tools",
          to: "@example/missing-lib",
          toVersion: "^2.0.0",
          reason: "needs a library this blueprint does not select",
        },
      ],
    }),
  );
  const diagnostics = diagnoseBlueprint(blueprint);
  assert.equal(
    diagnostics.some((item) => item.code === "blueprint.relation.requires.unselected"),
    true,
  );
  const withUnknown = diagnoseBlueprint(blueprint, {
    packages: [{ name: "@example/missing-lib", installed: true }],
  });
  assert.equal(
    withUnknown.some((item) => item.code === "blueprint.package.version-unknown"),
    true,
  );
  assert.equal(
    withUnknown.some((item) => item.message.includes("same-named install")),
    true,
  );
});

test("after reports order without sorting; prerelease ranges follow npm rules", () => {
  const blueprint = parseBlueprint(
    writingToolsBlueprint({
      profile: {
        base: "web",
        bundles: ["@example/writing-tools", "@example/theme-paper"],
        patch: [{ id: "example-writing-tools", config: { outputDirectory: null } }],
      },
      relations: [
        {
          type: "after",
          from: "@example/writing-tools",
          to: "@example/theme-paper",
          reason: "theme first",
        },
      ],
    }),
  );
  const diagnostics = diagnoseBlueprint(blueprint);
  assert.equal(diagnostics.some((item) => item.code === "blueprint.relation.after"), true);
  assert.deepEqual(blueprint.profile.bundles, ["@example/writing-tools", "@example/theme-paper"]);

  const pre = parseBlueprint(
    writingToolsBlueprint({
      packages: [
        { name: "@example/theme-paper", version: "1.2.0-beta.1", source: { type: "npm" } },
        { name: "@example/theme-night", version: "1.0.0", source: { type: "npm" } },
        { name: "@example/writing-tools", version: "2.1.0", source: { type: "npm" } },
      ],
      relations: [
        {
          type: "requires",
          from: "@example/writing-tools",
          to: "@example/theme-paper",
          toVersion: "^1.2.0",
          reason: "stable theme range does not include prereleases",
        },
      ],
    }),
  );
  const preDiag = diagnoseBlueprint(pre);
  assert.equal(
    preDiag.some((item) => item.code === "blueprint.relation.requires.version"),
    true,
  );
});

test("host targets are only the two official packages; other names stay unselected", () => {
  const blueprint = parseBlueprint(
    writingToolsBlueprint({
      relations: [
        {
          type: "requires",
          from: "@example/writing-tools",
          to: "@deepseek-ai/dsh-base",
          toVersion: "0.1.5-rc.2",
          reason: "needs host",
        },
        {
          type: "requires",
          from: "@example/writing-tools",
          to: "@deepseek-ai/dsh-web-app",
          toVersion: "0.1.5-rc.2",
          reason: "needs web app",
        },
      ],
    }),
  );
  const unknown = diagnoseBlueprint(blueprint);
  assert.equal(unknown.some((item) => item.code === "blueprint.relation.requires.unselected"), false);
  assert.equal(unknown.some((item) => item.code === "blueprint.package.version-unknown"), true);

  const known = diagnoseBlueprint(blueprint, {
    dsh: "0.1.5-rc.2",
    packages: [
      { name: "@deepseek-ai/dsh-base", version: "0.1.5-rc.2", installed: true },
      { name: "@deepseek-ai/dsh-web-app", version: "0.1.5-rc.2", installed: true },
    ],
  });
  assert.equal(known.some((item) => item.code === "blueprint.relation.requires.unselected"), false);
  assert.equal(
    known.some((item) => item.message.includes("dsh-cli") || item.message.includes("supervisor")),
    false,
  );
});

test("selected, installed, bundled, and active stay distinct", () => {
  const blueprint = parseBlueprintJson(readExample("writing.dsh-blueprint.json"));
  const diagnostics = diagnoseBlueprint(blueprint, {
    packages: [{ name: "@example/theme-night", version: "1.0.0", installed: true, selected: true, active: true }],
  });
  assert.equal(
    diagnostics.some((item) => item.code === "blueprint.relation.conflicts.not-current"),
    true,
  );
  assert.equal(
    diagnostics.some((item) => item.code === "blueprint.relation.conflicts" && item.severity === "error"),
    false,
  );
});

test("requirement mismatches are diagnostics; structurally valid blueprints still parse", () => {
  const blueprint = parseBlueprint(minimalObject({ requirements: { os: ["linux"], dsh: "^2.0.0" } }));
  const diagnostics = diagnoseBlueprint(blueprint, { os: "win32", dsh: "0.1.5-rc.2" });
  assert.equal(diagnostics.some((item) => item.code === "blueprint.requirement.os"), true);
  assert.equal(diagnostics.some((item) => item.code === "blueprint.requirement.dsh"), true);
  assert.equal(blueprint.kind, BLUEPRINT_KIND);
});

test("settings keys named __proto__ do not pollute Object.prototype", () => {
  const settings = JSON.parse('{"__proto__":{"polluted":true},"ordinary":{"a":1}}') as Record<string, unknown>;
  const blueprint = parseBlueprint(
    minimalObject({
      profile: {
        base: "web",
        bundles: [],
        settings,
      },
    }),
  );
  assert.equal(Object.hasOwn(blueprint.profile.settings, "__proto__"), true);
  assert.equal((Object.prototype as { polluted?: boolean }).polluted, undefined);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("from must be selected; to may be unselected in a structurally valid blueprint", () => {
  assertThrowsCode(
    () =>
      parseBlueprint(
        writingToolsBlueprint({
          relations: [
            {
              type: "requires",
              from: "@example/not-here",
              to: "@example/theme-paper",
              reason: "from missing",
            },
          ],
        }),
      ),
    BLUEPRINT_CODE.INVALID_FIELD,
  );
  const parsed = parseBlueprint(
    writingToolsBlueprint({
      relations: [
        {
          type: "integrates",
          from: "@example/writing-tools",
          to: "someone-else-plugin",
          reason: "optional extra",
        },
      ],
    }),
  );
  assert.equal(parsed.relations[0]?.to, "someone-else-plugin");
});

test("unsupported formatVersion is rejected", () => {
  assertThrowsCode(() => parseBlueprint(minimalObject({ formatVersion: 2 })), BLUEPRINT_CODE.UNSUPPORTED_VERSION);
});

test("relation diagnostics never include receiver connection ids or directory paths", () => {
  const blueprint = parseBlueprintJson(readExample("writing.dsh-blueprint.json"));
  const boundValues: BlueprintInputValues = {
    "output-directory": "C:\\Users\\secret\\docs",
    "writing-model": { connectionId: "conn-secret", modelId: "private-model" },
  };
  bindBlueprintInputs(blueprint, boundValues);
  const text = diagnoseBlueprint(blueprint)
    .map((item) => `${item.code}:${item.message}`)
    .join("\n");
  assert.equal(text.includes("conn-secret"), false);
  assert.equal(text.includes("C:\\Users\\secret"), false);
});

test("JSON nesting limit counts the root object as depth 1", () => {
  const nest = (levels: number): unknown => {
    let value: unknown = { ok: true };
    for (let index = 0; index < levels; index++) value = { n: value };
    return value;
  };
  parseBlueprint(minimalObject({ extensions: nest(BLUEPRINT_MAX_DEPTH - 2) as Record<string, unknown> }));
  assertThrowsCode(
    () => parseBlueprint(minimalObject({ extensions: nest(BLUEPRINT_MAX_DEPTH - 1) as Record<string, unknown> })),
    BLUEPRINT_CODE.DEPTH,
  );
});

test("domain module does not import Node fs or zlib", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/core/domain/blueprint.ts"), "utf8");
  assert.equal(/from ["']node:(fs|zlib)["']/.test(source), false);
  assert.equal(/from ["']node:fs\/promises["']/.test(source), false);
});
