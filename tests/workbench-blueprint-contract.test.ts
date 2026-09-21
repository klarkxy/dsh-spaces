import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BLUEPRINT_CODE,
  BLUEPRINT_KIND,
  BLUEPRINT_MAX_DEPTH,
  BlueprintError,
  bindBlueprintInputs,
  diagnoseBlueprint,
  parseBlueprint,
  parseBlueprintJson,
} from "../src/core/domain/blueprint.ts";
import {
  BLUEPRINT_JSON_MAX_BYTES,
  BLUEPRINT_SHARE_MAX_BYTES,
  type Blueprint,
  type BlueprintDiagnostic,
} from "../src/shared/blueprint.ts";
import {
  parseWorkbenchProductCommand,
  parseWorkbenchProductOutcome,
  parseWorkbenchProductRequest,
  parseWorkbenchProductResult,
} from "../src/shared/workbench-product-schemas.ts";

const observation = {
  serviceEpoch: "a".repeat(64),
  expectedRevision: "b".repeat(64),
};

const host = {
  dsh: "1.0.0",
  spaces: "1.0.0",
  node: "22.0.0",
  os: "win32",
  arch: "x64",
  base: "1.0.0",
  webApp: "1.0.0",
};

function packageDocument(count: number) {
  return {
    kind: BLUEPRINT_KIND,
    formatVersion: 1,
    metadata: { name: "n", version: "1.0.0" },
    packages: Array.from({ length: count }, (_, index) => ({
      name: `p-${index}`,
      version: "1.0.0",
      source: { type: "npm" as const },
    })),
    profile: { base: "web" as const, bundles: [] as string[] },
  };
}

function settingsDocument(count: number, firstNamespace: string) {
  const settings: { [namespace: string]: { v: null } } = {};
  const inputs: Array<{ id: string; type: "string"; label: string; required: true }> = [];
  const bindings: Array<{ input: string; target: { kind: "value"; pointer: string } }> = [];
  for (let index = 0; index < count; index++) {
    const namespace = index === 0 ? firstNamespace : `s${index}`;
    const id = `i${index}`;
    settings[namespace] = { v: null };
    inputs.push({ id, type: "string", label: `L${index}`, required: true });
    bindings.push({
      input: id,
      target: { kind: "value", pointer: `/profile/settings/${namespace}/v` },
    });
  }
  return {
    kind: BLUEPRINT_KIND,
    formatVersion: 1,
    metadata: { name: "n", version: "1.0.0" },
    packages: [] as Array<{ name: string; version: string; source: { type: "npm" } }>,
    profile: { base: "web" as const, bundles: [] as string[], settings },
    inputs,
    bindings,
  };
}

function nest(levels: number): unknown {
  let value: unknown = { ok: true };
  for (let index = 0; index < levels; index++) value = { n: value };
  return value;
}

function sourcePackages(blueprint: Blueprint) {
  return blueprint.packages.map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    source: "npm" as const,
    inBundles: false,
    hasBundlePatch: false,
    eligibility: { available: true as const },
    lifecycleScripts: [] as string[],
  }));
}

test("257 selected npm packages parse, diagnose, and pass inspect through generate and apply", () => {
  const raw = packageDocument(257);
  const json = JSON.stringify(raw);
  const bytes = Buffer.byteLength(json, "utf8");
  assert.equal(raw.packages.length, 257);
  assert.equal(bytes < BLUEPRINT_JSON_MAX_BYTES, true);
  assert.equal(bytes > 15_000, true);

  const fromJson = parseBlueprintJson(json);
  const blueprint = parseBlueprint(raw);
  assert.equal(fromJson.packages.length, 257);
  assert.equal(blueprint.packages.length, 257);
  assert.equal(blueprint.packages[0]?.name, "p-0");
  assert.equal(blueprint.packages[256]?.name, "p-256");

  const diagnostics = diagnoseBlueprint(blueprint);
  assert.equal(diagnostics.length > 256, true);
  assert.equal(diagnostics.length, 258);
  assert.equal(
    diagnostics.filter((item) => item.code === "blueprint.integrity.unlocked").length,
    257,
  );

  const inspect = parseWorkbenchProductResult({
    method: "blueprint.inspect",
    blueprint,
    diagnostics,
    observation,
  });
  assert.equal(inspect.method, "blueprint.inspect");
  if (inspect.method !== "blueprint.inspect") throw new Error("expected inspect");
  assert.equal(inspect.blueprint.packages.length, 257);
  assert.equal(inspect.diagnostics.length, 258);

  parseWorkbenchProductRequest({ method: "blueprint.inspect", content: json });
  parseWorkbenchProductRequest({
    method: "blueprint.generate",
    spaceId: "coding",
    selection: {
      packages: blueprint.packages.map((pkg) => pkg.name),
      includePatch: false,
      settingsNamespaces: [],
    },
    metadata: { name: "n", version: "1.0.0" },
  });
  parseWorkbenchProductRequest({
    method: "blueprint.preview",
    content: json,
    name: "coding",
    values: {},
  });

  const preview = parseWorkbenchProductResult({
    method: "blueprint.preview",
    blueprint,
    packages: blueprint.packages.map((pkg, index) => ({
      name: pkg.name,
      version: pkg.version,
      source: "npm" as const,
      bundled: false,
      order: index === 256 ? 1025 : index,
    })),
    inputs: [],
    host,
    diagnostics,
    missingInputs: [],
    observation,
  });
  assert.equal(preview.method, "blueprint.preview");
  if (preview.method !== "blueprint.preview") throw new Error("expected preview");
  assert.equal(preview.packages.length, 257);
  assert.equal(preview.packages[256]?.order, 1025);
  assert.equal(preview.diagnostics.length, 258);

  const generated = parseWorkbenchProductResult({
    method: "blueprint.generate",
    fileName: "n-1.0.0.dsh-blueprint.json",
    json,
    shareCode: "DSHBP1:J:e30",
    blueprint,
    diagnostics,
    observation,
  });
  assert.equal(generated.method, "blueprint.generate");
  if (generated.method !== "blueprint.generate") throw new Error("expected generate");
  assert.equal(generated.blueprint.packages.length, 257);
  assert.equal(generated.diagnostics.length, 258);

  const sourced = parseWorkbenchProductResult({
    method: "blueprint.source",
    spaceId: "coding",
    packages: sourcePackages(blueprint),
    bundles: [{ name: "p-0", order: 1025, eligible: true }],
    patch: { exists: false, shareable: true },
    settingsNamespaces: [],
    localObservations: [],
    host,
    observation,
  });
  assert.equal(sourced.method, "blueprint.source");
  if (sourced.method !== "blueprint.source") throw new Error("expected source");
  assert.equal(sourced.packages.length, 257);
  assert.equal(sourced.bundles[0]?.order, 1025);

  const outcome = parseWorkbenchProductOutcome({
    kind: "blueprint.apply",
    stages: {
      "space-create": { status: "succeeded" },
      packages: { status: "not-run" },
      presets: { status: "not-run" },
      start: { status: "not-run" },
    },
    installed: blueprint.packages.map((pkg) => ({ name: pkg.name, version: pkg.version })),
    packageResults: blueprint.packages.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      status: "not-run",
    })),
    writes: [
      { kind: "patch", status: "not-run" },
      { kind: "settings", status: "not-run" },
      { kind: "model", status: "not-run" },
      { kind: "provenance", status: "not-run" },
    ],
    host: { dsh: "1.0.0", spaces: "1.0.0", base: "1.0.0", webApp: "1.0.0" },
    source: { name: "n", version: "1.0.0" },
  });
  assert.equal(outcome.kind, "blueprint.apply");
  if (outcome.kind !== "blueprint.apply") throw new Error("expected apply");
  assert.equal(outcome.installed.length, 257);
  assert.equal(outcome.packageResults.length, 257);

  parseWorkbenchProductCommand({ kind: "blueprint.apply", planId: "plan-1" });
});

test("65 settings namespaces, inputs, and bindings round-trip preview, generate, and apply writes", () => {
  const longNamespace = "n".repeat(400);
  const raw = settingsDocument(65, longNamespace);
  const pointer = `/profile/settings/${longNamespace}/v`;
  assert.equal(pointer.length > 400, true);
  assert.equal(raw.inputs.length, 65);
  assert.equal(raw.bindings.length, 65);
  assert.equal(Object.keys(raw.profile.settings).length, 65);

  const blueprint = parseBlueprint(raw);
  const diagnostics: BlueprintDiagnostic[] = diagnoseBlueprint(blueprint);
  assert.equal(blueprint.inputs.length, 65);
  assert.equal(blueprint.bindings.length, 65);
  assert.equal(blueprint.bindings[0]?.target.kind === "value" && blueprint.bindings[0].target.pointer, pointer);

  const values = Object.fromEntries(blueprint.inputs.map((input) => [input.id, "x"]));
  assert.equal(Object.keys(values).length, 65);
  parseWorkbenchProductRequest({
    method: "blueprint.preview",
    content: JSON.stringify(raw),
    name: "coding",
    values,
  });
  parseWorkbenchProductRequest({
    method: "blueprint.generate",
    spaceId: "coding",
    selection: {
      packages: [],
      includePatch: false,
      settingsNamespaces: Object.keys(raw.profile.settings),
    },
    metadata: { name: "n", version: "1.0.0" },
    bindingOverrides: blueprint.bindings.map((binding, index) => ({
      pointer: binding.target.kind === "value" ? binding.target.pointer : "/profile/settings/x",
      input: blueprint.inputs[index]!,
    })),
  });

  const preview = parseWorkbenchProductResult({
    method: "blueprint.preview",
    blueprint,
    packages: [],
    inputs: blueprint.inputs.map((input) => ({
      id: input.id,
      type: input.type,
      origin: "explicit" as const,
      value: "x",
    })),
    host,
    diagnostics,
    missingInputs: blueprint.inputs.map((input) => input.id),
    observation,
  });
  assert.equal(preview.method, "blueprint.preview");
  if (preview.method !== "blueprint.preview") throw new Error("expected preview");
  assert.equal(preview.inputs.length, 65);
  assert.equal(preview.missingInputs.length, 65);

  const sourced = parseWorkbenchProductResult({
    method: "blueprint.source",
    spaceId: "coding",
    packages: [],
    bundles: [],
    patch: { exists: false, shareable: true },
    settingsNamespaces: Object.keys(raw.profile.settings).map((namespace) => ({
      namespace,
      eligible: true,
      shareable: true,
      convertible: true,
    })),
    localObservations: [{ pointer, kind: "unknown", reason: "receiver-local value" }],
    host,
    observation,
  });
  assert.equal(sourced.method, "blueprint.source");
  if (sourced.method !== "blueprint.source") throw new Error("expected source");
  assert.equal(sourced.settingsNamespaces.length, 65);
  assert.equal(sourced.settingsNamespaces[0]?.namespace.length, 400);

  const inspect = parseWorkbenchProductResult({
    method: "blueprint.inspect",
    blueprint,
    diagnostics: [
      ...diagnostics,
      {
        code: "blueprint.pointer",
        message: "settings namespace pointer",
        severity: "info",
        path: pointer,
      },
    ],
    observation,
  });
  assert.equal(inspect.method, "blueprint.inspect");
  if (inspect.method !== "blueprint.inspect") throw new Error("expected inspect");
  assert.equal(inspect.diagnostics.at(-1)?.path, pointer);

  const outcome = parseWorkbenchProductOutcome({
    kind: "blueprint.apply",
    stages: {
      "space-create": { status: "succeeded" },
      packages: { status: "succeeded" },
      presets: { status: "succeeded" },
      start: { status: "not-run" },
    },
    installed: [],
    packageResults: [],
    writes: [
      { kind: "patch", status: "succeeded" },
      { kind: "model", status: "not-run" },
      { kind: "provenance", status: "succeeded" },
      ...Object.keys(raw.profile.settings).map((namespace) => ({
        kind: "settings" as const,
        status: "succeeded" as const,
        namespace,
      })),
    ],
    host: { dsh: "1.0.0", spaces: "1.0.0", base: "1.0.0", webApp: "1.0.0" },
  });
  assert.equal(outcome.kind, "blueprint.apply");
  if (outcome.kind !== "blueprint.apply") throw new Error("expected apply");
  assert.equal(outcome.writes.length, 68);
});

test("legal 4097-character string default binds and round-trips preview value and generate overrides", () => {
  const defaultText = "x".repeat(4097);
  const label = "L".repeat(90);
  const description = "D".repeat(520);
  const raw = {
    kind: BLUEPRINT_KIND,
    formatVersion: 1,
    metadata: { name: "n", version: "1.0.0" },
    packages: [],
    profile: { base: "web", bundles: [], settings: { ns: { v: null } } },
    inputs: [
      {
        id: "note",
        type: "string",
        label,
        required: true,
        description,
        default: defaultText,
      },
    ],
    bindings: [{ input: "note", target: { kind: "value", pointer: "/profile/settings/ns/v" } }],
  };
  const json = JSON.stringify(raw);
  assert.equal(Buffer.byteLength(json, "utf8") < BLUEPRINT_JSON_MAX_BYTES, true);

  const blueprint = parseBlueprint(raw);
  const input = blueprint.inputs[0];
  assert.equal(input?.default, defaultText);
  assert.equal(typeof input?.default, "string");
  assert.equal((input?.default as string).length, 4097);
  assert.equal(input?.label.length, 90);
  assert.equal(input?.description?.length, 520);

  const bound = bindBlueprintInputs(blueprint, {});
  assert.equal((bound.settings.ns as { v: string }).v, defaultText);

  parseWorkbenchProductRequest({
    method: "blueprint.preview",
    content: json,
    name: "coding",
    values: {},
  });
  parseWorkbenchProductRequest({
    method: "blueprint.preview",
    content: json,
    name: "coding",
    values: { note: defaultText },
  });
  parseWorkbenchProductRequest({
    method: "blueprint.generate",
    spaceId: "coding",
    selection: { packages: [], includePatch: false, settingsNamespaces: ["ns"] },
    metadata: { name: "n", version: "1.0.0" },
    bindingOverrides: [
      {
        pointer: "/profile/settings/ns/v",
        input: input!,
      },
    ],
  });

  const preview = parseWorkbenchProductResult({
    method: "blueprint.preview",
    blueprint,
    packages: [],
    inputs: [
      {
        id: input!.id,
        type: input!.type,
        origin: "default",
        value: input!.default,
      },
    ],
    host,
    diagnostics: diagnoseBlueprint(blueprint),
    missingInputs: [],
    observation,
  });
  assert.equal(preview.method, "blueprint.preview");
  if (preview.method !== "blueprint.preview") throw new Error("expected preview");
  assert.equal(preview.inputs[0]?.origin, "default");
  assert.equal(preview.inputs[0]?.value, defaultText);
});

test("diagnose messages that interpolate long requirement and relation strings round-trip inspect", () => {
  const range = Array.from({ length: 90 }, (_, index) => `2.${index}.0`).join(" || ");
  const reason = "r".repeat(600);
  assert.equal(range.length > 500, true);
  const raw = {
    kind: BLUEPRINT_KIND,
    formatVersion: 1,
    metadata: { name: "n", version: "1.0.0" },
    requirements: { dsh: range },
    packages: [
      { name: "p-0", version: "1.0.0", source: { type: "npm" as const } },
      { name: "p-1", version: "1.0.0", source: { type: "npm" as const } },
    ],
    profile: { base: "web" as const, bundles: ["p-0", "p-1"] },
    relations: [
      {
        type: "conflicts" as const,
        from: "p-0",
        to: "p-1",
        reason,
      },
    ],
  };
  const json = JSON.stringify(raw);
  assert.equal(Buffer.byteLength(json, "utf8") < BLUEPRINT_JSON_MAX_BYTES, true);

  const blueprint = parseBlueprint(raw);
  const diagnostics = diagnoseBlueprint(blueprint, { dsh: "1.0.0" });
  const requirement = diagnostics.find((item) => item.code === "blueprint.requirement.dsh");
  const conflict = diagnostics.find((item) => item.code === "blueprint.relation.conflicts");
  assert.ok(requirement);
  assert.ok(conflict);
  assert.equal(requirement!.message.includes(range), true);
  assert.equal(requirement!.message.length > 500, true);
  assert.equal(conflict!.message.includes(reason), true);
  assert.equal(conflict!.message.length > 500, true);

  const inspect = parseWorkbenchProductResult({
    method: "blueprint.inspect",
    blueprint,
    diagnostics,
    observation,
  });
  assert.equal(inspect.method, "blueprint.inspect");
  if (inspect.method !== "blueprint.inspect") throw new Error("expected inspect");
  assert.equal(inspect.diagnostics.some((item) => item.code === "blueprint.requirement.dsh" && item.message === requirement!.message), true);
  assert.equal(inspect.diagnostics.some((item) => item.code === "blueprint.relation.conflicts" && item.message === conflict!.message), true);
});

test("non-blueprint product results stay closed and keep historical collection caps", () => {
  parseWorkbenchProductResult({ method: "library", items: [], observation });
  assert.throws(() => parseWorkbenchProductResult({ method: "library", items: [] }));
  assert.throws(() =>
    parseWorkbenchProductResult({
      method: "library",
      items: [],
      observation,
      leakedPath: "/home/user/.dsh",
    }),
  );
  const item = {
    id: "example-plugin",
    packageName: "example-plugin",
    title: "Example",
    version: "1.0.0",
    source: "catalog" as const,
    downloadedAt: "2026-09-21T00:00:00Z",
    installedIn: [] as string[],
  };
  parseWorkbenchProductResult({ method: "library", items: [item], observation });
  assert.throws(() =>
    parseWorkbenchProductResult({
      method: "library",
      items: Array.from({ length: 257 }, () => item),
      observation,
    }),
  );
  assert.throws(() =>
    parseWorkbenchProductRequest({
      method: "blueprint.generate",
      spaceId: "coding",
      selection: { packages: [], includePatch: false, settingsNamespaces: [] },
      metadata: { name: "n", version: "1.0.0" },
      bindingOverrides: [{ pointer: "/packages/0", input: { id: "i0", type: "string", label: "L", required: true } }],
    }),
  );
  assert.throws(() =>
    parseWorkbenchProductRequest({
      method: "blueprint.generate",
      spaceId: "coding",
      selection: { packages: [], includePatch: false, settingsNamespaces: [] },
      metadata: { name: "n".repeat(81), version: "1.0.0" },
    }),
  );
  assert.throws(() =>
    parseWorkbenchProductOutcome({
      kind: "blueprint.apply",
      stages: {
        "space-create": { status: "failed", error: "C:\\Users\\secret" },
        packages: { status: "not-run" },
        presets: { status: "not-run" },
        start: { status: "not-run" },
      },
      installed: [],
      packageResults: [],
      writes: [],
      host: { dsh: null, spaces: null, base: null, webApp: null },
    }),
  );
});

test("oversize JSON, depth, and unknown fields are refused at the parser that owns them", () => {
  const oversizeJson = " ".repeat(BLUEPRINT_JSON_MAX_BYTES + 1);
  assert.throws(
    () => parseBlueprintJson(oversizeJson),
    (error: unknown) => error instanceof BlueprintError && error.code === BLUEPRINT_CODE.JSON_TOO_LARGE,
  );
  parseWorkbenchProductRequest({
    method: "blueprint.inspect",
    content: "x".repeat(BLUEPRINT_JSON_MAX_BYTES + 1),
  });
  assert.throws(() =>
    parseWorkbenchProductRequest({
      method: "blueprint.inspect",
      content: "x".repeat(BLUEPRINT_SHARE_MAX_BYTES + 1),
    }),
  );

  const minimal = parseBlueprint(packageDocument(0));
  parseBlueprint({
    kind: BLUEPRINT_KIND,
    formatVersion: 1,
    metadata: { name: "n", version: "1.0.0" },
    packages: [],
    profile: { base: "web", bundles: [] },
    extensions: nest(BLUEPRINT_MAX_DEPTH - 2),
  });
  assert.throws(
    () =>
      parseBlueprint({
        kind: BLUEPRINT_KIND,
        formatVersion: 1,
        metadata: { name: "n", version: "1.0.0" },
        packages: [],
        profile: { base: "web", bundles: [] },
        extensions: nest(BLUEPRINT_MAX_DEPTH - 1),
      }),
    (error: unknown) => error instanceof BlueprintError && error.code === BLUEPRINT_CODE.DEPTH,
  );
  assert.throws(() =>
    parseWorkbenchProductResult({
      method: "blueprint.inspect",
      blueprint: {
        kind: BLUEPRINT_KIND,
        formatVersion: 1,
        metadata: { name: "n", version: "1.0.0" },
        packages: [],
        profile: { base: "web", bundles: [] },
        extensions: nest(BLUEPRINT_MAX_DEPTH - 1),
      },
      diagnostics: [],
      observation,
    }),
  );
  assert.throws(
    () =>
      parseBlueprint({
        kind: BLUEPRINT_KIND,
        formatVersion: 1,
        metadata: { name: "n", version: "1.0.0" },
        packages: [],
        profile: { base: "web", bundles: [] },
        extra: true,
      }),
    (error: unknown) => error instanceof BlueprintError && error.code === BLUEPRINT_CODE.UNKNOWN_FIELD,
  );
  assert.throws(() =>
    parseWorkbenchProductResult({
      method: "blueprint.inspect",
      blueprint: {
        kind: BLUEPRINT_KIND,
        formatVersion: 1,
        metadata: { name: "n", version: "1.0.0" },
        packages: [],
        profile: { base: "web", bundles: [] },
        extra: true,
      },
      diagnostics: [],
      observation,
    }),
  );
  assert.throws(() =>
    parseWorkbenchProductResult({
      method: "blueprint.inspect",
      blueprint: minimal,
      diagnostics: [],
      observation,
      leaked: true,
    }),
  );
  assert.throws(() =>
    parseWorkbenchProductResult({
      method: "blueprint.inspect",
      blueprint: minimal,
      diagnostics: [{ code: "x", message: "y", severity: "info", extra: true }],
      observation,
    }),
  );
  assert.throws(() =>
    parseWorkbenchProductResult({
      method: "blueprint.generate",
      fileName: "n-1.0.0.dsh-blueprint.json",
      json: "n".repeat(BLUEPRINT_JSON_MAX_BYTES + 1),
      shareCode: "DSHBP1:J:e30",
      blueprint: minimal,
      diagnostics: [],
      observation,
    }),
  );
});
