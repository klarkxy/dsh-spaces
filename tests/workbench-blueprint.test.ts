import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createHash } from "node:crypto";
import { HomeOperationLock } from "../src/adapters/node/home-operation-lock.ts";
import {
  BlueprintWorkbench,
  type BlueprintRuntimeCompose,
  type BlueprintRuntimeInspect,
  type BlueprintWorkbenchPorts,
} from "../src/adapters/node/blueprint-workbench.ts";
import {
  composeBlueprintRuntime,
  inspectBlueprintRuntime,
  resolveBlueprintModule,
} from "../src/adapters/node/blueprint-runtime.ts";
import { WorkbenchProductService, type WorkbenchProductPorts } from "../src/adapters/node/workbench-products.ts";
import type { WorkbenchJobContext } from "../src/adapters/node/workbench-jobs.ts";
import { stringifyBlueprint } from "../src/adapters/node/blueprint-codec.ts";
import { parseBlueprint } from "../src/core/domain/blueprint.ts";
import type { Blueprint } from "../src/shared/blueprint.ts";
import { GlobalLlmHost } from "../src/core/application/global-llm-host.ts";
import { GlobalLlmService } from "../src/core/application/global-llm-service.ts";
import {
  LLM_ERROR,
  LlmConfigError,
  compileManagedRouteId,
  parseCatalog,
  type GlobalLlmCatalog,
  type SpaceLlmPolicy,
} from "../src/core/domain/llm-connections.ts";
import type { LlmInstanceRecord, LlmOperationRecord, LlmOperationStore, LlmSpaceSettingsPort, SpaceDefaultModel } from "../src/core/ports/llm-runtime.ts";
import type { LlmCatalogStore, LlmCredentialStore, LlmPolicyStore } from "../src/core/ports/llm-store.ts";
import type { LlmApiRequest, LlmApiResult, LlmLocalCandidate } from "../src/shared/llm-api.ts";
import type { LlmShareManifest } from "../src/core/domain/llm-share.ts";
import { BLUEPRINT_ORIGIN_FILE, type WorkbenchBlueprintApplyOutcome } from "../src/shared/workbench-blueprint.ts";
import type { WorkbenchSpace } from "../src/shared/workbench.ts";
import {
  parseWorkbenchProductCommand,
  parseWorkbenchProductOutcome,
  parseWorkbenchProductRequest,
} from "../src/shared/workbench-product-schemas.ts";
import type { WorkbenchProductObservation } from "../src/shared/workbench-product.ts";

const temps: string[] = [];
const CONN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DIGEST = "ab".repeat(32);
const OTHER = "cd".repeat(32);

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-blueprint-"));
  temps.push(dir);
  mkdirSync(join(dir, "hub"), { recursive: true });
  mkdirSync(join(dir, "profiles"), { recursive: true });
  return dir;
}

function observation(): WorkbenchProductObservation {
  return { serviceEpoch: DIGEST, expectedRevision: OTHER };
}

function space(id: string): WorkbenchSpace {
  return {
    id,
    displayName: id,
    isHost: false,
    hasWebApp: true,
    isolation: "verified",
    icon: "box",
    status: "stopped",
    generation: 1,
    managed: true,
    needsIsolation: false,
  };
}

function jobCtx(): { ctx: WorkbenchJobContext; recorded: unknown[] } {
  const recorded: unknown[] = [];
  return {
    recorded,
    ctx: {
      signal: new AbortController().signal,
      phase() {},
      message() {},
      cancellable() {},
      result(value) {
        recorded.push(JSON.parse(JSON.stringify(value)));
      },
    },
  };
}

function baseBlueprint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "dsh-blueprint",
    formatVersion: 1,
    metadata: { name: "test", version: "1.0.0" },
    packages: [],
    profile: { base: "web", bundles: [], patch: [], settings: {} },
    ...overrides,
  };
}

function writeSpace(
  dshHome: string,
  name: string,
  extras: { deps?: Record<string, string>; bundles?: string[]; patch?: string; settings?: string; resolved?: Record<string, string> } = {},
): void {
  const dir = join(dshHome, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      dependencies: extras.deps ?? {},
      dsh: { profile: { bundles: extras.bundles ?? [] } },
    }),
  );
  if (extras.patch !== undefined) writeFileSync(join(dir, "cordis.patch.yml"), extras.patch);
  for (const [pkg, version] of Object.entries(extras.resolved ?? {})) {
    const pkgDir = join(dir, "node_modules", ...pkg.split("/"));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version }));
  }
  mkdirSync(join(dshHome, "hub", name), { recursive: true });
  if (extras.settings !== undefined) writeFileSync(join(dshHome, "hub", name, "settings.yaml"), extras.settings);
}

function inspectOf(dshHome: string): (options: { home: string; bin: string }) => Promise<BlueprintRuntimeInspect> {
  return async () => {
    const patch = join(dshHome, "cordis.patch.yml");
    const bytes = existsSync(patch) ? readFileSync(patch) : Buffer.from("");
    return {
      versions: { dsh: "0.1.5-rc.2", base: "0.1.5-rc.2", webApp: "0.1.5-rc.2" },
      baseLayers: [],
      baseEntries: [],
      homePatches: [],
      fingerprint: createHash("sha256").update(bytes).digest("hex"),
    };
  };
}

function composeOk(
  extra: {
    warnings?: string[];
    layers?: BlueprintRuntimeCompose["layers"];
    entries?: unknown[];
  } = {},
): (
  options: { home: string; bin: string },
  input: { spaceId: string; bundles: string[]; patch: unknown[] },
) => Promise<BlueprintRuntimeCompose> {
  return async (_options, input) => ({
    versions: { dsh: "0.1.5-rc.2", base: "0.1.5-rc.2", webApp: "0.1.5-rc.2" },
    layers:
      extra.layers ??
      input.bundles.map((name) => ({
        name,
        version: name === "@deepseek-ai/dsh-base" || name === "@deepseek-ai/dsh-web-app" ? "0.1.5-rc.2" : "1.0.0",
      })),
    entries: extra.entries ?? [],
    warnings: extra.warnings ?? [],
    fingerprint: "compose",
  });
}

function describePayload(enabled = true, modelId = "m1", revision = 1): LlmApiResult {
  return {
    revision,
    connections: [
      {
        id: CONN,
        revision: 1,
        displayName: "demo",
        enabled,
        backend: "llm-pi-ai",
        providerConfig: { models: [{ id: modelId }] },
        auth: { kind: "none" },
        createdAt: "2026-09-21T00:00:00.000Z",
        updatedAt: "2026-09-21T00:00:00.000Z",
        routeId: "spaces-llm-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        usedBySpaceIds: [],
      },
    ],
    defaultModel: null,
    capabilities: {
      adapter: "llm-pi-ai",
      adapterVersion: "0.1.5-rc.2",
      protocols: ["openai-completions", "openai-responses", "anthropic-messages"],
      keyless: false,
    },
    pendingRestartSpaceIds: [],
  };
}

function llmDescribe(enabled = true, modelId = "m1"): (request: LlmApiRequest) => Promise<LlmApiResult> {
  const catalogRevision = 1;
  let policyRevision = 0;
  let shared: SpaceLlmPolicy["shared"] = { mode: "none" };
  return async (request) => {
    if (!request || typeof request !== "object" || !("method" in request)) {
      throw new Error("llm fixture requires a method");
    }
    if (request.method === "describe") return describePayload(enabled, modelId, catalogRevision);
    if (request.method === "spacePolicy") {
      return {
        spaceId: request.spaceId,
        policy: { schemaVersion: 1, revision: policyRevision, shared },
        targetCatalogRevision: catalogRevision,
        runningCatalogRevision: null,
        pendingRestart: false,
      };
    }
    if (request.method === "updateSpacePolicy") {
      if (request.expectedRevision !== policyRevision) {
        throw new LlmConfigError(LLM_ERROR.REVISION_CONFLICT, "policy revision moved");
      }
      policyRevision += 1;
      shared = request.shared;
      return {
        spaceId: request.spaceId,
        policy: { schemaVersion: 1, revision: policyRevision, shared },
        targetCatalogRevision: catalogRevision,
        runningCatalogRevision: null,
        pendingRestart: false,
      };
    }
    if (request.method === "updateSpaceDefault") {
      return {
        spaceId: request.spaceId,
        source: request.model ? "local" : "none",
        inheritGlobal: !request.model,
        local: request.model ? { provider: compileManagedRouteId(request.model.connectionId), model: request.model.modelId } : null,
        global: null,
        effective: request.model
          ? { provider: compileManagedRouteId(request.model.connectionId), model: request.model.modelId, origin: "local" as const }
          : null,
      };
    }
    throw new Error(`llm fixture does not implement ${request.method}`);
  };
}

function portsOf(
  dshHome: string,
  spaces: WorkbenchSpace[],
  extra: Partial<BlueprintWorkbenchPorts> = {},
): BlueprintWorkbenchPorts {
  return {
    home: dshHome,
    observation,
    managerId: () => "manager",
    listSpaces: () => spaces,
    createSpace: async (input) => {
      writeSpace(dshHome, input.name);
      spaces.push(space(input.name));
    },
    installPlugin: async () => {},
    llm: extra.llm ?? llmDescribe(),
    llmAdmitted: extra.llmAdmitted ?? extra.llm ?? llmDescribe(),
    llmBridgeAvailable: extra.llmBridgeAvailable ?? (() => true),
    dshVersion: () => "0.1.5-rc.2",
    spacesVersion: () => "0.3.1",
    runtimeBin: () => join(dshHome, "bin.js"),
    inspectRuntime: extra.inspectRuntime ?? inspectOf(dshHome),
    composeRuntime: extra.composeRuntime ?? composeOk(),
    resolveModule:
      extra.resolveModule ??
      (async (_options, input) => ({
        packageName: input.specifier.startsWith("@")
          ? input.specifier.split("/").slice(0, 2).join("/")
          : input.specifier.split("/")[0] ?? input.specifier,
        packageVersion: null,
        resolvedPath:
          input.specifier.includes("no-such-export") || input.specifier.includes("not-exported")
            ? null
            : join(dshHome, "resolved.js"),
        builtin: input.specifier.startsWith("cordis:"),
      })),
    prepareBlueprintPackage: extra.prepareBlueprintPackage,
    ...extra,
  };
}

function packageInstall(dshHome: string): Pick<BlueprintWorkbenchPorts, "prepareBlueprintPackage" | "installPlugin"> {
  let current: { name: string; version: string } | undefined;
  return {
    prepareBlueprintPackage: async (_home, pkg) => {
      current = { name: pkg.name, version: pkg.version };
      return {
        archivePath: join(dshHome, `${pkg.name.replace(/\//g, "__")}.tgz`),
        name: pkg.name,
        version: pkg.version,
        integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
        hasBundle: true,
        lifecycleScripts: [],
      };
    },
    installPlugin: async (spaceId) => {
      if (!current) throw new Error("no prepared package");
      const dir = join(dshHome, "profiles", spaceId, "node_modules", ...current.name.split("/"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: current.name, version: current.version }));
    },
  };
}

test("product schemas accept blueprint apply detail and reject path-bearing durable fields", () => {
  parseWorkbenchProductRequest({ method: "blueprint.source", spaceId: "coding" });
  parseWorkbenchProductCommand({ kind: "blueprint.apply", planId: "plan-1" });
  parseWorkbenchProductOutcome({
    kind: "blueprint.apply",
    stages: {
      "space-create": { status: "succeeded" },
      packages: { status: "failed", error: "Package installation failed." },
      presets: { status: "not-run" },
      start: { status: "not-run" },
    },
    installed: [{ name: "alpha", version: "1.0.0" }],
    packageResults: [
      { name: "alpha", version: "1.0.0", status: "succeeded" },
      { name: "beta", version: "1.0.0", status: "failed", error: "Package installation failed." },
      { name: "gamma", version: "1.0.0", status: "not-run" },
    ],
    writes: [
      { kind: "patch", status: "not-run" },
      { kind: "settings", status: "not-run" },
      { kind: "model", status: "not-run" },
      { kind: "provenance", status: "not-run" },
    ],
    host: { dsh: null, spaces: null, base: null, webApp: null },
  });
  assert.throws(() =>
    parseWorkbenchProductOutcome({
      kind: "blueprint.apply",
      stages: {
        "space-create": { status: "failed", error: "installer failed output D:/private/local-output" },
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

test("wrong input types and unavailable models do not stage a plan", async () => {
  const dshHome = home();
  const spaces = [space("coding")];
  const wb = new BlueprintWorkbench(portsOf(dshHome, spaces));
  const typed = parseBlueprint(
    baseBlueprint({
      inputs: [{ id: "count", type: "number", label: "Count", required: true }],
      bindings: [{ input: "count", target: { kind: "value", pointer: "/profile/settings/demo/count" } }],
      profile: { base: "web", bundles: [], patch: [], settings: { demo: { count: null } } },
    }),
  );
  const wrong = await wb.preview({
    content: stringifyBlueprint(typed),
    name: "wrong-type",
    values: { count: "not-number" },
  });
  assert.equal(wrong.planId, undefined);
  assert.ok(wrong.diagnostics.some((row) => row.severity === "error"));

  const modelBp = parseBlueprint(
    baseBlueprint({
      inputs: [{ id: "model", type: "model", label: "Model", required: true }],
      bindings: [{ input: "model", target: { kind: "default-model" } }],
    }),
  );
  const missing = await wb.preview({
    content: stringifyBlueprint(modelBp),
    name: "bad-model",
    values: { model: { connectionId: CONN, modelId: "missing" } },
  });
  assert.equal(missing.planId, undefined);
  assert.ok(missing.diagnostics.some((row) => row.message.includes("model")));
});

test("password presets are rejected before staging, apply, and regeneration", async () => {
  const dshHome = home();
  const spaces = [space("coding")];
  const wb = new BlueprintWorkbench(portsOf(dshHome, spaces));
  const secret = parseBlueprint(
    baseBlueprint({
      profile: {
        base: "web",
        bundles: [],
        patch: [{ id: "custom", config: { password: "synthetic-canary-secret" } }],
        settings: { demo: { password: "synthetic-canary-secret" } },
      },
    }),
  );
  const preview = await wb.preview({ content: stringifyBlueprint(secret), name: "secret", values: {} });
  assert.equal(preview.planId, undefined);
  assert.equal(JSON.stringify(preview.diagnostics).includes("synthetic-canary-secret"), false);

  writeSpace(dshHome, "secret", {
    patch: "- id: custom\n  config:\n    password: synthetic-canary-secret\n",
    settings: "demo:\n  password: synthetic-canary-secret\n",
  });
  spaces.push(space("secret"));
  await assert.rejects(
    () =>
      wb.generate({
        spaceId: "secret",
        metadata: { name: "test", version: "1.0.0" },
        selection: { packages: [], includePatch: true, settingsNamespaces: ["demo"] },
      }),
    /secret/,
  );
});

test("optional missing model can stage; relative directory inputs cannot", async () => {
  const dshHome = home();
  const spaces = [space("coding")];
  const wb = new BlueprintWorkbench(portsOf(dshHome, spaces));
  const optional = parseBlueprint(
    baseBlueprint({
      inputs: [{ id: "model", type: "model", label: "Model", required: false }],
      bindings: [{ input: "model", target: { kind: "default-model" } }],
    }),
  );
  const preview = await wb.preview({ content: stringifyBlueprint(optional), name: "optional-model", values: {} });
  assert.ok(preview.planId);
  const relative = parseBlueprint(
    baseBlueprint({
      inputs: [{ id: "dir", type: "directory", label: "Dir", required: true }],
      bindings: [{ input: "dir", target: { kind: "value", pointer: "/profile/settings/demo/dir" } }],
      profile: { base: "web", bundles: [], patch: [], settings: { demo: { dir: null } } },
    }),
  );
  const blocked = await wb.preview({
    content: stringifyBlueprint(relative),
    name: "rel-dir",
    values: { dir: "notes-output" },
  });
  assert.equal(blocked.planId, undefined);
});

test("directory junction into Home with a missing child is rejected", async () => {
  const dshHome = home();
  const spaces = [space("coding")];
  const wb = new BlueprintWorkbench(portsOf(dshHome, spaces));
  const alias = join(tmpdir(), `dsh-bp-alias-${Date.now()}`);
  temps.push(alias);
  try {
    symlinkSync(dshHome, alias, "junction");
  } catch {
    symlinkSync(dshHome, alias, "dir");
  }
  const typed = parseBlueprint(
    baseBlueprint({
      inputs: [{ id: "dir", type: "directory", label: "Dir", required: true }],
      bindings: [{ input: "dir", target: { kind: "value", pointer: "/profile/settings/demo/dir" } }],
      profile: { base: "web", bundles: [], patch: [], settings: { demo: { dir: null } } },
    }),
  );
  const preview = await wb.preview({
    content: stringifyBlueprint(typed),
    name: "dir",
    values: { dir: join(alias, "hub", "secret", "new-output") },
  });
  assert.equal(preview.planId, undefined);
});

test("source treats exact version specs as npm and file archives as local without cache proof", async () => {
  const dshHome = home();
  writeSpace(dshHome, "edit", {
    deps: { "demo-package": "1.0.0" },
    resolved: { "demo-package": "1.0.0" },
  });
  const spaces = [space("edit")];
  const wb = new BlueprintWorkbench(portsOf(dshHome, spaces));
  const exact = await wb.source("edit");
  const demo = exact.packages.find((row) => row.name === "demo-package");
  assert.equal(demo?.source, "npm");
  assert.equal(demo?.eligibility.available, true);

  writeFileSync(
    join(dshHome, "profiles", "edit", "package.json"),
    JSON.stringify({ dependencies: { "demo-package": "file:../../archive.tgz" }, dsh: { profile: { bundles: [] } } }),
  );
  const fileSource = await wb.source("edit");
  const local = fileSource.packages.find((row) => row.name === "demo-package");
  assert.equal(local?.source, "local");
  assert.equal(local?.eligibility.available, false);
});

test("generation keeps current edits and restores provenance placeholders instead of stale origin content", async () => {
  const dshHome = home();
  writeSpace(dshHome, "edit", {
    deps: { "demo-package": "1.0.0", "new-package": "2.0.0" },
    bundles: ["demo-package"],
    resolved: { "demo-package": "1.0.0", "new-package": "2.0.0" },
    settings: "demo:\n  theme: new\n  output: D:\\\\docs\\\\out\n",
  });
  const origin: Blueprint = parseBlueprint(
    baseBlueprint({
      packages: [{ name: "demo-package", version: "0.9.0", source: { type: "npm" } }],
      profile: { base: "web", bundles: ["demo-package"], settings: { demo: { theme: "old", output: null } } },
      inputs: [{ id: "output", type: "directory", label: "out", required: false }],
      bindings: [{ input: "output", target: { kind: "value", pointer: "/profile/settings/demo/output" } }],
    }),
  );
  writeFileSync(
    join(dshHome, "hub", "edit", "blueprint-origin.json"),
    JSON.stringify({
      schemaVersion: 1,
      blueprint: origin,
      bindings: [{ input: "output", kind: "value", pointer: "/profile/settings/demo/output", namespace: "demo" }],
      appliedAt: new Date().toISOString(),
    }),
  );
  const spaces = [space("edit")];
  const wb = new BlueprintWorkbench(portsOf(dshHome, spaces));
  const generated = await wb.generate({
    spaceId: "edit",
    metadata: { name: "test", version: "1.0.0" },
    selection: { packages: ["demo-package", "new-package"], includePatch: false, settingsNamespaces: ["demo"] },
    bindingOverrides: [
      {
        pointer: "/profile/settings/demo/output",
        input: { id: "output", type: "directory", label: "out", required: false },
      },
    ],
  });
  assert.equal(generated.blueprint.profile.settings.demo && (generated.blueprint.profile.settings.demo as { theme?: string }).theme, "new");
  assert.equal((generated.blueprint.profile.settings.demo as { output?: unknown }).output, null);
  assert.equal(generated.blueprint.packages.find((pkg) => pkg.name === "demo-package")?.version, "1.0.0");
  assert.ok(generated.blueprint.packages.some((pkg) => pkg.name === "new-package"));
  assert.equal(JSON.stringify(generated.blueprint).includes("D:\\\\docs"), false);
});

test("unselected invalid patch does not block generating selected settings", async () => {
  const dshHome = home();
  writeSpace(dshHome, "edit", {
    patch: "- id: custom\n  config:\n    path: !!js dshHomePath('nope')\n",
    settings: "demo:\n  theme: live\n",
  });
  const spaces = [space("edit")];
  const wb = new BlueprintWorkbench(portsOf(dshHome, spaces));
  const generated = await wb.generate({
    spaceId: "edit",
    metadata: { name: "test", version: "1.0.0" },
    selection: { packages: [], includePatch: false, settingsNamespaces: ["demo"] },
  });
  assert.equal((generated.blueprint.profile.settings.demo as { theme?: string }).theme, "live");
});

test("YAML conversion keeps targeted insert ids and null group/disabled", async () => {
  const dshHome = home();
  writeSpace(dshHome, "source", {
    patch: "- id: existing-group\n  insert:\n    - id: added\n      name: demo-package\n- id: cleared\n  disabled: null\n  group: null\n",
  });
  const spaces = [space("source")];
  const wb = new BlueprintWorkbench(portsOf(dshHome, spaces));
  const generated = await wb.generate({
    spaceId: "source",
    metadata: { name: "test", version: "1.0.0" },
    selection: { packages: [], includePatch: true, settingsNamespaces: [] },
  });
  const first = generated.blueprint.profile.patch[0] as { id?: string; insert?: unknown[] };
  assert.equal(first.id, "existing-group");
  assert.ok(Array.isArray(first.insert));
  const cleared = generated.blueprint.profile.patch[1] as { id?: string; disabled?: unknown; group?: unknown };
  assert.equal(cleared.id, "cleared");
  assert.equal(cleared.disabled, null);
  assert.equal(cleared.group, null);
});

test("unresolved composition is failed and A/B/C package results are retained without raw paths", async () => {
  const dshHome = home();
  const spaces: WorkbenchSpace[] = [];
  let preparedName = "";
  const wb = new BlueprintWorkbench(
    portsOf(dshHome, spaces, {
      prepareBlueprintPackage: async (_home, pkg) => {
        preparedName = pkg.name;
        return {
          archivePath: join(dshHome, "archive.tgz"),
          name: pkg.name,
          version: pkg.version,
          integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
          hasBundle: false,
          lifecycleScripts: [],
        };
      },
      installPlugin: async (spaceId) => {
        if (preparedName === "beta") throw new Error("installer failed output D:/private/local-output");
        const dir = join(dshHome, "profiles", spaceId, "node_modules", preparedName);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: preparedName, version: "1.0.0" }));
      },
    }),
  );
  const packages = parseBlueprint(
    baseBlueprint({
      packages: ["alpha", "beta", "gamma"].map((name) => ({ name, version: "1.0.0", source: { type: "npm" } })),
    }),
  );
  const preview = await wb.preview({ content: stringifyBlueprint(packages), name: "partial", values: {} });
  assert.ok(preview.planId);
  const { ctx, recorded } = jobCtx();
  await assert.rejects(() => wb.apply(preview.planId!, ctx));
  const last = recorded.at(-1) as { product?: { packageResults?: Array<{ name: string; status: string; error?: string }>; stages?: { packages?: { error?: string } }; source?: { name?: string } } };
  const results = last.product?.packageResults ?? [];
  assert.equal(results.find((row) => row.name === "alpha")?.status, "succeeded");
  assert.equal(results.find((row) => row.name === "beta")?.status, "failed");
  assert.equal(results.find((row) => row.name === "gamma")?.status, "not-run");
  assert.equal(JSON.stringify(last).includes("D:/private"), false);
  assert.equal(last.product?.stages?.packages?.error, "Package installation failed.");
});

test("durable source names that look like paths are omitted", async () => {
  const dshHome = home();
  const spaces: WorkbenchSpace[] = [];
  const wb = new BlueprintWorkbench(portsOf(dshHome, spaces));
  const preview = await wb.preview({
    content: stringifyBlueprint(parseBlueprint(baseBlueprint({ metadata: { name: "C:\\\\private\\\\source-path", version: "1.0.0" } }))),
    name: "metadata",
    values: {},
  });
  assert.ok(preview.planId);
  const outcome = await wb.apply(preview.planId!, jobCtx().ctx);
  assert.equal(outcome.source, undefined);
  parseWorkbenchProductOutcome(outcome);
});

test("home patch edits invalidate a previously staged plan", async () => {
  const dshHome = home();
  const spaces: WorkbenchSpace[] = [];
  const wb = new BlueprintWorkbench(portsOf(dshHome, spaces));
  const preview = await wb.preview({
    content: stringifyBlueprint(parseBlueprint(baseBlueprint())),
    name: "home-moved",
    values: {},
  });
  assert.ok(preview.planId);
  writeFileSync(join(dshHome, "cordis.patch.yml"), "- id: changed-home-row\n  config: { changed: true }\n");
  await assert.rejects(() => wb.apply(preview.planId!, jobCtx().ctx), /changed|preview/i);
});

test("existing settings product still reads on a disposable Home", async () => {
  const dshHome = home();
  writeFileSync(
    join(dshHome, "hub", "settings.json"),
    JSON.stringify({ portStart: 3100, portEnd: 3199, packageSource: "official", catalogUrl: "" }),
  );
  const lock = new HomeOperationLock(dshHome);
  const service = new WorkbenchProductService({
    home: dshHome,
    observation,
    managerId: () => "manager",
    listSpaces: () => [space("coding")],
    createSpace: async () => {},
    installPlugin: async () => {},
    llm: async () => ({ revision: 0, connections: [], defaultModel: null }) as LlmApiResult,
    diagnostics: (spaceId) => ({ spaceId, status: "stopped", logs: [], backups: [] }),
    withWrite: (_label, action) => lock.run(_label, action),
  } satisfies WorkbenchProductPorts);
  const result = await service.read({ method: "settings" });
  assert.equal(result.method, "settings");
});

class MemoryCatalogStore implements LlmCatalogStore {
  constructor(private catalog: GlobalLlmCatalog) {}
  async read(): Promise<GlobalLlmCatalog> {
    return this.catalog;
  }
  async write(next: GlobalLlmCatalog, expectedRevision: number): Promise<GlobalLlmCatalog> {
    if (this.catalog.revision !== expectedRevision) {
      throw new LlmConfigError(LLM_ERROR.REVISION_CONFLICT, "catalog revision moved");
    }
    this.catalog = parseCatalog(next);
    return this.catalog;
  }
}

class MemoryPolicyStore implements LlmPolicyStore {
  private readonly files = new Map<string, SpaceLlmPolicy>();
  async read(spaceId: string): Promise<SpaceLlmPolicy> {
    return this.files.get(spaceId) ?? { schemaVersion: 1, revision: 0, shared: { mode: "none" } };
  }
  async write(spaceId: string, next: SpaceLlmPolicy, expectedRevision: number): Promise<SpaceLlmPolicy> {
    const current = await this.read(spaceId);
    if (current.revision !== expectedRevision) {
      throw new LlmConfigError(LLM_ERROR.REVISION_CONFLICT, "policy revision moved");
    }
    this.files.set(spaceId, next);
    return next;
  }
}

class MemoryCredentialStore implements LlmCredentialStore {
  async writeRecord() {
    return { recordId: "unused", configured: true, writable: false, source: "spaces-global" as const };
  }
  async readSecret() {
    return undefined;
  }
  async describe(recordId: string) {
    return { recordId, configured: false, writable: true, source: "spaces-global" as const };
  }
}

class MemoryOperationStore implements LlmOperationStore {
  async get() {
    return undefined;
  }
  async begin(operationId: string): Promise<LlmOperationRecord> {
    return { operationId, status: "unknown", createdAt: "2026-09-21T00:00:00.000Z" };
  }
  async commit(operationId: string, input: { catalogRevision: number; connectionId: string }): Promise<LlmOperationRecord> {
    return {
      operationId,
      status: "committed",
      catalogRevision: input.catalogRevision,
      connectionId: input.connectionId,
      createdAt: "2026-09-21T00:00:00.000Z",
    };
  }
  async markUnknown(operationId: string): Promise<LlmOperationRecord> {
    return { operationId, status: "unknown", createdAt: "2026-09-21T00:00:00.000Z" };
  }
}

class MemoryInstances {
  async list(): Promise<LlmInstanceRecord[]> {
    return [];
  }
  async get(): Promise<LlmInstanceRecord | undefined> {
    return undefined;
  }
  async markApplied() {}
}

class MemorySpaceSettings implements LlmSpaceSettingsPort {
  defaults = new Map<string, SpaceDefaultModel>();
  async readDefault(spaceId: string) {
    return this.defaults.get(spaceId) ?? null;
  }
  async writeDefault(spaceId: string, value: SpaceDefaultModel | null) {
    if (value === null) this.defaults.delete(spaceId);
    else this.defaults.set(spaceId, value);
  }
  async listLocal(): Promise<LlmLocalCandidate[]> {
    return [];
  }
  async readLocalProvider(): Promise<Record<string, unknown>> {
    throw new LlmConfigError(LLM_ERROR.MODEL_NOT_FOUND, "local connection was not found");
  }
  async readCopyableSecret() {
    return undefined;
  }
  async readImport(): Promise<LlmShareManifest | null> {
    return null;
  }
}

function seededCatalog(): GlobalLlmCatalog {
  return parseCatalog({
    schemaVersion: 1,
    revision: 1,
    connections: {
      [CONN]: {
        id: CONN,
        revision: 1,
        displayName: "demo",
        enabled: true,
        backend: "llm-pi-ai",
        providerConfig: {
          api: "openai-completions",
          baseURL: "http://127.0.0.1:9/v1",
          models: [{ id: "m1" }],
        },
        auth: { kind: "none" },
        createdAt: "2026-09-21T00:00:00.000Z",
        updatedAt: "2026-09-21T00:00:00.000Z",
      },
    },
    defaultModel: null,
    retiredConnectionIds: [],
  });
}

function modelBlueprint(): Blueprint {
  return parseBlueprint(
    baseBlueprint({
      inputs: [{ id: "model", type: "model", label: "Model", required: true }],
      bindings: [{ input: "model", target: { kind: "default-model" } }],
    }),
  );
}

test("bindModel uses space policy revision through admitted LLM and does not re-queue", async () => {
  const dshHome = home();
  const spaces: WorkbenchSpace[] = [];
  const catalog = new MemoryCatalogStore(seededCatalog());
  const policies = new MemoryPolicyStore();
  const settings = new MemorySpaceSettings();
  const service = new GlobalLlmService(catalog, policies, new MemoryCredentialStore(), async () => spaces.map((row) => row.id));
  const host = new GlobalLlmHost({
    service,
    operations: new MemoryOperationStore(),
    instances: new MemoryInstances(),
    probe: {
      discover: async () => ({ models: [{ id: "m1" }], truncated: false }),
      test: async ({ modelId }) => ({ ok: true as const, modelId }),
    },
    spaceSettings: settings,
    assertWritable: () => {},
    submitApply: async () => {
      throw new Error("applyPlan must not run during blueprint model bind");
    },
    readSecret: async () => undefined,
  });
  const methods: string[] = [];
  const wb = new BlueprintWorkbench(
    portsOf(dshHome, spaces, {
      createSpace: async (input) => {
        writeSpace(dshHome, input.name, {
          deps: {
            "@deepseek-ai/dsh-base": "0.1.5-rc.2",
            "@deepseek-ai/dsh-web-app": "0.1.5-rc.2",
            "@dsh-spaces/view-bridge": "0.3.1",
            "@dsh-spaces/llm-bridge": "0.3.1",
          },
          bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@dsh-spaces/view-bridge", "@dsh-spaces/llm-bridge"],
        });
        spaces.push(space(input.name));
      },
      llm: async () => {
        throw new Error("llm port re-queued the exclusive tail");
      },
      llmAdmitted: async (request) => {
        methods.push(request.method);
        return (await host.dispatch(request)) as LlmApiResult;
      },
    }),
  );
  const preview = await wb.preview({
    content: stringifyBlueprint(modelBlueprint()),
    name: "model-space",
    values: { model: { connectionId: CONN, modelId: "m1" } },
  });
  assert.ok(preview.planId);
  const outcome = await wb.apply(preview.planId!, jobCtx().ctx);
  assert.equal(outcome.stages.presets.status, "succeeded");
  assert.equal(outcome.writes.find((row) => row.kind === "model")?.status, "succeeded");
  assert.equal(methods.filter((method) => method === "updateSpacePolicy").length, 1);
  assert.equal(methods.filter((method) => method === "updateSpaceDefault").length, 1);
  assert.ok(methods.includes("spacePolicy"));
  assert.equal(methods.includes("describe"), true);
  const policy = await policies.read("model-space");
  assert.equal(policy.revision, 1);
  assert.equal(policy.shared.mode, "selected");
  if (policy.shared.mode === "selected") assert.deepEqual(policy.shared.connectionIds, [CONN]);
  assert.deepEqual(settings.defaults.get("model-space"), {
    provider: compileManagedRouteId(CONN),
    model: "m1",
  });
  const manifest = JSON.parse(readFileSync(join(dshHome, "profiles", "model-space", "package.json"), "utf8")) as {
    dsh?: { profile?: { bundles?: string[] } };
  };
  assert.equal(manifest.dsh?.profile?.bundles?.includes("@dsh-spaces/llm-bridge"), true);
  assert.equal((await catalog.read()).revision, 1);
});

test("late model llm-bridge composition is validated before provenance", async () => {
  const dshHome = home();
  const spaces: WorkbenchSpace[] = [];
  const composedBundles: string[][] = [];
  const wb = new BlueprintWorkbench(
    portsOf(dshHome, spaces, {
      createSpace: async (input) => {
        writeSpace(dshHome, input.name, {
          deps: {
            "@deepseek-ai/dsh-base": "0.1.5-rc.2",
            "@deepseek-ai/dsh-web-app": "0.1.5-rc.2",
            "@dsh-spaces/llm-bridge": "0.3.1",
          },
          bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
        });
        spaces.push(space(input.name));
      },
      composeRuntime: async (options, input) => {
        composedBundles.push([...input.bundles]);
        if (input.bundles.includes("@dsh-spaces/llm-bridge")) {
          throw new Error("The llm-bridge bundle could not be composed.");
        }
        return composeOk()(options, input);
      },
      llmAdmitted: llmDescribe(),
    }),
  );
  const preview = await wb.preview({
    content: stringifyBlueprint(modelBlueprint()),
    name: "late-bridge-invalid",
    values: { model: { connectionId: CONN, modelId: "m1" } },
  });
  assert.ok(preview.planId);
  const { ctx, recorded } = jobCtx();
  await assert.rejects(() => wb.apply(preview.planId!, ctx), /could not be composed|composition could not be verified/);
  assert.equal(composedBundles.length, 1);
  assert.equal(composedBundles[0]?.includes("@dsh-spaces/llm-bridge"), true);
  const last = recorded.at(-1) as {
    product?: {
      stages?: { packages?: { status?: string }; presets?: { status?: string } };
      writes?: Array<{ kind: string; status: string }>;
    };
  };
  assert.equal(last.product?.stages?.packages?.status, "succeeded");
  assert.equal(last.product?.stages?.presets?.status, "failed");
  assert.equal(last.product?.writes?.find((row) => row.kind === "patch")?.status, "succeeded");
  assert.equal(last.product?.writes?.find((row) => row.kind === "settings")?.status, "succeeded");
  assert.equal(last.product?.writes?.find((row) => row.kind === "model")?.status, "succeeded");
  assert.equal(last.product?.writes?.find((row) => row.kind === "provenance")?.status, "not-run");
  assert.equal(existsSync(join(dshHome, "profiles", "late-bridge-invalid")), true);

  const okHome = home();
  const okSpaces: WorkbenchSpace[] = [];
  const okBundles: string[][] = [];
  const ok = new BlueprintWorkbench(
    portsOf(okHome, okSpaces, {
      createSpace: async (input) => {
        writeSpace(okHome, input.name, {
          deps: {
            "@deepseek-ai/dsh-base": "0.1.5-rc.2",
            "@deepseek-ai/dsh-web-app": "0.1.5-rc.2",
            "@dsh-spaces/llm-bridge": "0.3.1",
          },
          bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
        });
        okSpaces.push(space(input.name));
      },
      composeRuntime: async (options, input) => {
        okBundles.push([...input.bundles]);
        return composeOk({
          layers: input.bundles.map((name) => ({
            name,
            version: name.startsWith("@deepseek-ai/") ? "0.1.5-rc.2" : "0.3.1",
          })),
        })(options, input);
      },
      llmAdmitted: llmDescribe(),
    }),
  );
  const okPreview = await ok.preview({
    content: stringifyBlueprint(modelBlueprint()),
    name: "late-bridge-ok",
    values: { model: { connectionId: CONN, modelId: "m1" } },
  });
  assert.ok(okPreview.planId);
  const okOutcome = await ok.apply(okPreview.planId!, jobCtx().ctx);
  assert.equal(okOutcome.stages.packages.status, "succeeded");
  assert.equal(okOutcome.stages.presets.status, "succeeded");
  assert.equal(okOutcome.writes.find((row) => row.kind === "model")?.status, "succeeded");
  assert.equal(okOutcome.writes.find((row) => row.kind === "provenance")?.status, "succeeded");
  assert.equal(okBundles.length, 1);
  assert.equal(okBundles[0]?.includes("@dsh-spaces/llm-bridge"), true);
  const okManifest = JSON.parse(readFileSync(join(okHome, "profiles", "late-bridge-ok", "package.json"), "utf8")) as {
    dsh?: { profile?: { bundles?: string[] } };
  };
  assert.equal(okManifest.dsh?.profile?.bundles?.includes("@dsh-spaces/llm-bridge"), true);
});

test("named insert of a selected package can preview on a home with no target profile", async () => {
  const dshHome = home();
  const spaces: WorkbenchSpace[] = [];
  const resolved: Array<{ spaceId: string; specifier: string }> = [];
  const wb = new BlueprintWorkbench(
    portsOf(dshHome, spaces, {
      resolveModule: async (_options, input) => {
        resolved.push(input);
        throw new Error("preflight must not resolve modules");
      },
      composeRuntime: async () => {
        throw new Error("preflight must not compose against a profile");
      },
    }),
  );
  const blueprint = parseBlueprint(
    baseBlueprint({
      packages: [{ name: "dsh-theme-plugin", version: "0.3.3", source: { type: "npm" } }],
      profile: {
        base: "web",
        bundles: ["dsh-theme-plugin"],
        patch: [{ insert: [{ id: "theme-row", name: "dsh-theme-plugin" }] }],
        settings: {},
      },
    }),
  );
  const preview = await wb.preview({ content: stringifyBlueprint(blueprint), name: "named-insert", values: {} });
  assert.ok(preview.planId);
  assert.equal(resolved.length, 0);
  assert.equal(existsSync(join(dshHome, "profiles", "named-insert")), false);
  assert.ok(preview.diagnostics.some((row) => row.code === "blueprint.compose.pending"));
  assert.equal(preview.diagnostics.some((row) => row.code === "blueprint.compose" && row.severity === "error"), false);
});

test("apply uses official skipped overlay warnings and actual resolved identities", async () => {
  const dshHome = home();
  const spaces: WorkbenchSpace[] = [];
  const official = composeOk({
    warnings: [
      'patch: entry "missing" not found',
      'patch: name mismatch for "shared" (expected "shared", got "wrong"), skipping',
      'patch insert: entry "base-row" is not a group',
    ],
  });
  const wb = new BlueprintWorkbench(portsOf(dshHome, spaces, { composeRuntime: official }));
  const skipped = parseBlueprint(
    baseBlueprint({
      profile: {
        base: "web",
        bundles: [],
        patch: [
          { id: "missing", config: { a: 1 } },
          { id: "shared", name: "wrong" },
          { id: "base-row", insert: [{ id: "child", name: "x" }] },
        ],
        settings: {},
      },
    }),
  );
  const preview = await wb.preview({ content: stringifyBlueprint(skipped), name: "skipped-overlay", values: {} });
  assert.ok(preview.planId);
  const { ctx, recorded } = jobCtx();
  await assert.rejects(() => wb.apply(preview.planId!, ctx));
  const last = recorded.at(-1) as { product?: { stages?: { packages?: { error?: string } } } };
  assert.match(String(last.product?.stages?.packages?.error), /overlay|name does not match|is not a group/);
  assert.equal(JSON.stringify(last).includes(dshHome), false);

  const unrelatedHome = home();
  const unrelated = new BlueprintWorkbench(
    portsOf(unrelatedHome, [], {
      ...packageInstall(unrelatedHome),
      composeRuntime: composeOk({ warnings: ['patch: entry "from-bundle" not found'] }),
      resolveModule: async () => ({
        packageName: "demo-package",
        packageVersion: "1.0.0",
        resolvedPath: join(unrelatedHome, "resolved.js"),
        builtin: false,
      }),
    }),
  );
  const allowed = parseBlueprint(
    baseBlueprint({
      packages: [{ name: "demo-package", version: "1.0.0", source: { type: "npm" } }],
      profile: {
        base: "web",
        bundles: [],
        patch: [{ insert: [{ id: "ok", name: "demo-package" }] }],
        settings: {},
      },
    }),
  );
  const okPreview = await unrelated.preview({ content: stringifyBlueprint(allowed), name: "bundle-noise", values: {} });
  assert.ok(okPreview.planId);
  const ok = await unrelated.apply(okPreview.planId!, jobCtx().ctx);
  assert.equal(ok.stages.packages.status, "succeeded");
});

test("exported subpath resolves; nonexported subpath and shadowed names fail after install", async () => {
  const dshHome = home();
  const resolve = async (
    _options: { home: string; bin: string },
    input: { spaceId: string; specifier: string },
  ) => {
    if (input.specifier.endsWith("/not-exported") || input.specifier.includes("no-such-export")) {
      return { packageName: "demo-package", packageVersion: "1.0.0", resolvedPath: null, builtin: false };
    }
    if (input.specifier === "looks-selected") {
      return { packageName: "other-pkg", packageVersion: "1.0.0", resolvedPath: join(dshHome, "other.js"), builtin: false };
    }
    const pkg = input.specifier.split("/")[0] ?? input.specifier;
    return { packageName: pkg, packageVersion: "1.0.0", resolvedPath: join(dshHome, "resolved.js"), builtin: false };
  };
  const exported = new BlueprintWorkbench(portsOf(dshHome, [], { ...packageInstall(dshHome), resolveModule: resolve }));
  const exportedBp = parseBlueprint(
    baseBlueprint({
      packages: [{ name: "demo-package", version: "1.0.0", source: { type: "npm" } }],
      profile: {
        base: "web",
        bundles: [],
        patch: [{ insert: [{ id: "main", name: "demo-package" }] }],
        settings: {},
      },
    }),
  );
  const exportedPreview = await exported.preview({ content: stringifyBlueprint(exportedBp), name: "exported", values: {} });
  assert.ok(exportedPreview.planId);
  const exportedOutcome = await exported.apply(exportedPreview.planId!, jobCtx().ctx);
  assert.equal(exportedOutcome.stages.packages.status, "succeeded");

  const missingExport = new BlueprintWorkbench(portsOf(dshHome, [], { ...packageInstall(dshHome), resolveModule: resolve }));
  const missingBp = parseBlueprint(
    baseBlueprint({
      packages: [{ name: "demo-package", version: "1.0.0", source: { type: "npm" } }],
      profile: {
        base: "web",
        bundles: [],
        patch: [{ insert: [{ id: "missing-export", name: "demo-package/not-exported" }] }],
        settings: {},
      },
    }),
  );
  const missingPreview = await missingExport.preview({ content: stringifyBlueprint(missingBp), name: "missing-export", values: {} });
  assert.ok(missingPreview.planId);
  await assert.rejects(() => missingExport.apply(missingPreview.planId!, jobCtx().ctx), /module could not be resolved/);

  const shadowed = new BlueprintWorkbench(
    portsOf(dshHome, [], {
      ...packageInstall(dshHome),
      resolveModule: async () => ({
        packageName: "other-pkg",
        packageVersion: "1.0.0",
        resolvedPath: join(dshHome, "other.js"),
        builtin: false,
      }),
    }),
  );
  const shadowedBp = parseBlueprint(
    baseBlueprint({
      packages: [{ name: "demo-package", version: "1.0.0", source: { type: "npm" } }],
      profile: {
        base: "web",
        bundles: [],
        patch: [{ insert: [{ id: "shadow", name: "demo-package" }] }],
        settings: {},
      },
    }),
  );
  const shadowedPreview = await shadowed.preview({ content: stringifyBlueprint(shadowedBp), name: "shadowed", values: {} });
  assert.ok(shadowedPreview.planId);
  await assert.rejects(() => shadowed.apply(shadowedPreview.planId!, jobCtx().ctx), /selected, transitive, or host/);
});

test("install-first composed layer version must match the selected pin", async () => {
  const dshHome = home();
  const wb = new BlueprintWorkbench(
    portsOf(dshHome, [], {
      ...packageInstall(dshHome),
      composeRuntime: composeOk({ layers: [{ name: "demo-package", version: "9.9.9" }] }),
    }),
  );
  const blueprint = parseBlueprint(
    baseBlueprint({
      packages: [{ name: "demo-package", version: "1.0.0", source: { type: "npm" } }],
      profile: { base: "web", bundles: ["demo-package"], patch: [], settings: {} },
    }),
  );
  const preview = await wb.preview({ content: stringifyBlueprint(blueprint), name: "shadow-layer", values: {} });
  assert.ok(preview.planId);
  await assert.rejects(() => wb.apply(preview.planId!, jobCtx().ctx), /different version than the selected pin/);
});

test("regeneration restores reordered patch bindings and nested optional leaves", async () => {
  const dshHome = home();
  writeSpace(dshHome, "edit", {
    patch: "- id: beta\n  name: demo-package\n  config:\n    path: keep-beta\n- id: alpha\n  name: demo-package\n  config:\n    path: \"C:\\\\recv\\\\alpha-out\"\n",
    settings: "demo:\n  nested:\n    keep: true\n  extra: 1\n",
  });
  const origin = parseBlueprint(
    baseBlueprint({
      profile: {
        base: "web",
        bundles: [],
        patch: [
          { id: "alpha", name: "demo-package", config: { path: null } },
          { id: "beta", name: "demo-package", config: { path: "keep-beta" } },
        ],
        settings: { demo: { nested: { keep: true, leaf: null }, extra: 1 } },
      },
      inputs: [
        { id: "output", type: "directory", label: "out", required: false },
        { id: "leaf", type: "string", label: "leaf", required: false },
      ],
      bindings: [
        { input: "output", target: { kind: "value", pointer: "/profile/patch/0/config/path" } },
        { input: "leaf", target: { kind: "value", pointer: "/profile/settings/demo/nested/leaf" } },
      ],
    }),
  );
  writeFileSync(
    join(dshHome, "hub", "edit", "blueprint-origin.json"),
    JSON.stringify({
      schemaVersion: 1,
      blueprint: origin,
      bindings: [
        { input: "output", kind: "value", pointer: "/profile/patch/0/config/path", entryId: "alpha", entryName: "demo-package" },
        { input: "leaf", kind: "value", pointer: "/profile/settings/demo/nested/leaf", namespace: "demo" },
      ],
      appliedAt: new Date().toISOString(),
    }),
  );
  const wb = new BlueprintWorkbench(portsOf(dshHome, [space("edit")]));
  const generated = await wb.generate({
    spaceId: "edit",
    metadata: { name: "test", version: "1.0.0" },
    selection: { packages: [], includePatch: true, settingsNamespaces: ["demo"] },
  });
  const alpha = generated.blueprint.profile.patch.find((row) => "id" in row && row.id === "alpha") as { config?: { path?: unknown } };
  const beta = generated.blueprint.profile.patch.find((row) => "id" in row && row.id === "beta") as { config?: { path?: unknown } };
  assert.equal(alpha?.config?.path, null);
  assert.equal(beta?.config?.path, "keep-beta");
  const demo = generated.blueprint.profile.settings.demo as { nested?: { keep?: unknown; leaf?: unknown }; extra?: unknown; leaf?: unknown };
  assert.equal(demo.nested?.leaf, null);
  assert.equal(demo.nested?.keep, true);
  assert.equal(demo.extra, 1);
  assert.equal(demo.leaf, undefined);
  assert.equal(JSON.stringify(generated.blueprint).includes("recv"), false);
});

test("entry-name change and equal-id ambiguity require an explicit override", async () => {
  const dshHome = home();
  writeSpace(dshHome, "renamed", {
    patch: "- id: alpha\n  name: other-package\n  config:\n    path: \"C:\\\\recv\\\\alpha-out\"\n",
  });
  const origin = parseBlueprint(
    baseBlueprint({
      profile: {
        base: "web",
        bundles: [],
        patch: [{ id: "alpha", name: "demo-package", config: { path: null } }],
        settings: {},
      },
      inputs: [{ id: "output", type: "directory", label: "out", required: false }],
      bindings: [{ input: "output", target: { kind: "value", pointer: "/profile/patch/0/config/path" } }],
    }),
  );
  writeFileSync(
    join(dshHome, "hub", "renamed", "blueprint-origin.json"),
    JSON.stringify({
      schemaVersion: 1,
      blueprint: origin,
      bindings: [{ input: "output", kind: "value", pointer: "/profile/patch/0/config/path", entryId: "alpha", entryName: "demo-package" }],
      appliedAt: new Date().toISOString(),
    }),
  );
  const wb = new BlueprintWorkbench(portsOf(dshHome, [space("renamed"), space("dup")]));
  await assert.rejects(
    () =>
      wb.generate({
        spaceId: "renamed",
        metadata: { name: "test", version: "1.0.0" },
        selection: { packages: [], includePatch: true, settingsNamespaces: [] },
      }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /explicit override/);
      assert.equal(message.includes("recv"), false);
      return true;
    },
  );

  writeSpace(dshHome, "dup", {
    patch: "- id: alpha\n  name: demo-package\n  config:\n    path: first\n- id: alpha\n  name: demo-package\n  config:\n    path: \"C:\\\\recv\\\\dup-out\"\n",
  });
  writeFileSync(
    join(dshHome, "hub", "dup", "blueprint-origin.json"),
    JSON.stringify({
      schemaVersion: 1,
      blueprint: origin,
      bindings: [{ input: "output", kind: "value", pointer: "/profile/patch/0/config/path", entryId: "alpha", entryName: "demo-package" }],
      appliedAt: new Date().toISOString(),
    }),
  );
  await assert.rejects(
    () =>
      wb.generate({
        spaceId: "dup",
        metadata: { name: "test", version: "1.0.0" },
        selection: { packages: [], includePatch: true, settingsNamespaces: [] },
      }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /explicit override/);
      assert.equal(message.includes("recv"), false);
      return true;
    },
  );
});

test("provenance failure keeps skipped model not-run and retains partial settings", async () => {
  const dshHome = home();
  const spaces: WorkbenchSpace[] = [];
  const wb = new BlueprintWorkbench(
    portsOf(dshHome, spaces, {
      createSpace: async (input) => {
        writeSpace(dshHome, input.name);
        mkdirSync(join(dshHome, "hub", input.name, BLUEPRINT_ORIGIN_FILE));
        spaces.push(space(input.name));
      },
    }),
  );
  const blueprint = parseBlueprint(
    baseBlueprint({
      profile: { base: "web", bundles: [], patch: [], settings: { demo: { title: "kept", canary: "safe-title" } } },
    }),
  );
  const preview = await wb.preview({ content: stringifyBlueprint(blueprint), name: "partial-writes", values: {} });
  assert.ok(preview.planId);
  const { ctx, recorded } = jobCtx();
  await assert.rejects(() => wb.apply(preview.planId!, ctx));
  const last = recorded.at(-1) as {
    product?: {
      stages?: { presets?: { status?: string; error?: string } };
      writes?: Array<{ kind: string; status: string; error?: string }>;
    };
  };
  const writes = last.product?.writes ?? [];
  assert.equal(writes.find((row) => row.kind === "patch")?.status, "succeeded");
  assert.equal(writes.find((row) => row.kind === "settings")?.status, "succeeded");
  assert.equal(writes.find((row) => row.kind === "model")?.status, "not-run");
  assert.equal(writes.find((row) => row.kind === "provenance")?.status, "failed");
  assert.equal(writes.find((row) => row.kind === "provenance")?.error, "Blueprint provenance could not be saved.");
  assert.equal(last.product?.stages?.presets?.status, "failed");
  assert.equal(last.product?.stages?.presets?.error, "Blueprint provenance could not be saved.");
  const dumped = JSON.stringify(last);
  assert.equal(dumped.includes(dshHome), false);
  assert.equal(dumped.includes("canary"), false);
  const settings = readFileSync(join(dshHome, "hub", "partial-writes", "settings.yaml"), "utf8");
  assert.match(settings, /title: kept/);
});

test("configured inspector failure blocks preview without writes, fetch, or leaked secrets", async () => {
  const dshHome = home();
  const spaces: WorkbenchSpace[] = [];
  let created = 0;
  let fetched = 0;
  const secret = "sk-live-canary-token";
  const wb = new BlueprintWorkbench(
    portsOf(dshHome, spaces, {
      inspectRuntime: async () => {
        throw new Error(`inspect failed token=${secret} path=${join(dshHome, ".credentials.yaml")}`);
      },
      createSpace: async () => {
        created += 1;
      },
      fetchImpl: async () => {
        fetched += 1;
        throw new Error("fetch must not run");
      },
      prepareBlueprintPackage: async () => {
        fetched += 1;
        throw new Error("prepare must not run");
      },
    }),
  );
  const preview = await wb.preview({
    content: stringifyBlueprint(parseBlueprint(baseBlueprint())),
    name: "inspect-fail",
    values: {},
  });
  assert.equal(preview.planId, undefined);
  assert.ok(preview.diagnostics.some((row) => row.code === "blueprint.runtime" && row.severity === "error"));
  assert.equal(created, 0);
  assert.equal(fetched, 0);
  assert.equal(spaces.length, 0);
  assert.equal(readdirSync(join(dshHome, "profiles")).length, 0);
  const dumped = JSON.stringify(preview);
  assert.equal(dumped.includes(secret), false);
  assert.equal(dumped.includes(dshHome), false);
  assert.equal(dumped.includes(".credentials.yaml"), false);
  assert.equal(dumped.includes("sk-"), false);
});

test("inspector failure during apply after a staged plan fails before creation with truthful stages", async () => {
  const dshHome = home();
  const spaces: WorkbenchSpace[] = [];
  let failInspect = false;
  let created = 0;
  const secret = "sk-apply-canary-token";
  const wb = new BlueprintWorkbench(
    portsOf(dshHome, spaces, {
      inspectRuntime: async (options) => {
        if (failInspect) throw new Error(`inspect failed token=${secret} path=${join(dshHome, ".credentials.yaml")}`);
        return inspectOf(dshHome)(options);
      },
      createSpace: async () => {
        created += 1;
      },
    }),
  );
  const preview = await wb.preview({
    content: stringifyBlueprint(parseBlueprint(baseBlueprint())),
    name: "apply-inspect-fail",
    values: {},
  });
  assert.ok(preview.planId);
  failInspect = true;
  const { ctx, recorded } = jobCtx();
  await assert.rejects(() => wb.apply(preview.planId!, ctx), /could not be inspected/);
  assert.equal(created, 0);
  assert.equal(spaces.length, 0);
  assert.equal(existsSync(join(dshHome, "profiles", "apply-inspect-fail")), false);
  const last = recorded.at(-1) as {
    product?: {
      spaceId?: string;
      stages?: {
        "space-create"?: { status?: string; error?: string };
        packages?: { status?: string };
        presets?: { status?: string };
        start?: { status?: string };
      };
      writes?: Array<{ status: string }>;
    };
  };
  assert.equal(last.product?.spaceId, undefined);
  assert.equal(last.product?.stages?.["space-create"]?.status, "failed");
  assert.equal(last.product?.stages?.["space-create"]?.error, "The bound runtime could not be inspected.");
  assert.equal(last.product?.stages?.packages?.status, "not-run");
  assert.equal(last.product?.stages?.presets?.status, "not-run");
  assert.equal(last.product?.stages?.start?.status, "not-run");
  assert.ok((last.product?.writes ?? []).every((row) => row.status === "not-run"));
  const dumped = JSON.stringify(last);
  assert.equal(dumped.includes(secret), false);
  assert.equal(dumped.includes(dshHome), false);
  assert.equal(dumped.includes(".credentials.yaml"), false);
});

test("preview still stages when runtime inspection is not configured", async () => {
  const dshHome = home();
  const wb = new BlueprintWorkbench(portsOf(dshHome, [], { inspectRuntime: undefined, runtimeBin: undefined }));
  const preview = await wb.preview({
    content: stringifyBlueprint(parseBlueprint(baseBlueprint())),
    name: "no-inspector",
    values: {},
  });
  assert.ok(preview.planId);
  assert.equal(existsSync(join(dshHome, "profiles", "no-inspector")), false);
});

function officialRc2Bin(): string | null {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  const bin = join(appData, "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  if (!existsSync(bin)) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(bin, "..", "..", "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (pkg.name === "@deepseek-ai/dsh" && pkg.version === "0.1.5-rc.2") return bin;
  } catch {
    return null;
  }
  return null;
}

test("home overlay of managed settings is rejected before writes; official base settings still preview", async () => {
  const blockedHome = home();
  const blockedSpaces: WorkbenchSpace[] = [];
  let created = 0;
  const blocked = new BlueprintWorkbench(
    portsOf(blockedHome, blockedSpaces, {
      inspectRuntime: async () => ({
        versions: { dsh: "0.1.5-rc.2", base: "0.1.5-rc.2", webApp: "0.1.5-rc.2" },
        baseLayers: [
          { name: "@deepseek-ai/dsh-base", version: "0.1.5-rc.2", packageDir: "base", patchPath: "base.yml", patches: [] },
          { name: "@deepseek-ai/dsh-web-app", version: "0.1.5-rc.2", packageDir: "web", patchPath: "web.yml", patches: [] },
        ],
        baseEntries: [
          { id: "settings", name: "@deepseek-ai/dsh-settings-file" },
          { id: "session-persistence-jsonl", name: "@deepseek-ai/dsh-session-persistence-jsonl", config: { root: { __jsExpr: "dshHomePath('sessions')" } } },
        ],
        homePatches: [{ id: "settings", config: { path: "hub/other/settings.yaml" } }],
        fingerprint: "home-settings-overlay",
      }),
      createSpace: async () => {
        created += 1;
      },
    }),
  );
  const blockedPreview = await blocked.preview({
    content: stringifyBlueprint(parseBlueprint(baseBlueprint())),
    name: "target",
    values: {},
  });
  assert.equal(blockedPreview.planId, undefined);
  assert.ok(
    blockedPreview.diagnostics.some(
      (row) => row.code === "blueprint.home-patch" && row.severity === "error" && /managed isolation or control/.test(row.message),
    ),
  );
  assert.equal(created, 0);
  assert.equal(existsSync(join(blockedHome, "profiles", "target")), false);

  const allowedHome = home();
  const allowed = new BlueprintWorkbench(
    portsOf(allowedHome, [], {
      inspectRuntime: async () => ({
        versions: { dsh: "0.1.5-rc.2", base: "0.1.5-rc.2", webApp: "0.1.5-rc.2" },
        baseLayers: [
          { name: "@deepseek-ai/dsh-base", version: "0.1.5-rc.2", packageDir: "base", patchPath: "base.yml", patches: [] },
        ],
        baseEntries: [
          { id: "settings", name: "@deepseek-ai/dsh-settings-file" },
          { id: "session-persistence-jsonl", name: "@deepseek-ai/dsh-session-persistence-jsonl", config: { root: { __jsExpr: "dshHomePath('sessions')" } } },
        ],
        homePatches: [],
        fingerprint: "official-base-settings",
      }),
    }),
  );
  const allowedPreview = await allowed.preview({
    content: stringifyBlueprint(parseBlueprint(baseBlueprint())),
    name: "target",
    values: {},
  });
  assert.ok(allowedPreview.planId);
  assert.equal(existsSync(join(allowedHome, "profiles", "target")), false);
});

test("config-only overlay is composed and official not-found warnings fail apply", async () => {
  const dshHome = home();
  const spaces: WorkbenchSpace[] = [];
  let composeCalls = 0;
  const wb = new BlueprintWorkbench(
    portsOf(dshHome, spaces, {
      composeRuntime: async (options, input) => {
        composeCalls += 1;
        return composeOk({ warnings: ['patch: entry "blueprint-review-no-such-entry" not found'] })(options, input);
      },
    }),
  );
  const overlay = parseBlueprint(
    baseBlueprint({
      profile: { base: "web", bundles: [], patch: [{ id: "blueprint-review-no-such-entry", config: { a: 1 } }], settings: {} },
    }),
  );
  const preview = await wb.preview({ content: stringifyBlueprint(overlay), name: "overlay-missing", values: {} });
  assert.ok(preview.planId);
  assert.equal(composeCalls, 0);
  const { ctx, recorded } = jobCtx();
  await assert.rejects(() => wb.apply(preview.planId!, ctx));
  assert.equal(composeCalls, 1);
  const last = recorded.at(-1) as { product?: { stages?: { packages?: { status?: string; error?: string }; presets?: { status?: string } } } };
  assert.match(String(last.product?.stages?.packages?.error), /overlay/);
  assert.equal(last.product?.stages?.packages?.status, "failed");
  assert.equal(last.product?.stages?.presets?.status, "not-run");

  composeCalls = 0;
  const empty = new BlueprintWorkbench(
    portsOf(home(), [], {
      composeRuntime: async (options, input) => {
        composeCalls += 1;
        return composeOk()(options, input);
      },
    }),
  );
  const emptyPreview = await empty.preview({
    content: stringifyBlueprint(parseBlueprint(baseBlueprint())),
    name: "empty-skip",
    values: {},
  });
  assert.ok(emptyPreview.planId);
  await empty.apply(emptyPreview.planId!, jobCtx().ctx);
  assert.equal(composeCalls, 0);
});

test("selected pin is not loosened by author compose entries or host name evidence", async () => {
  const dshHome = home();
  const packageName = "@deepseek-ai/dsh-agent";
  const selectedVersion = "0.1.5-rc.1";
  const resolvedVersion = "0.1.5-rc.2";
  const authorEntries = [
    { id: "agent", name: packageName },
    { id: "review-shadowed-agent", name: packageName },
  ];
  const wb = new BlueprintWorkbench(
    portsOf(dshHome, [], {
      ...packageInstall(dshHome),
      inspectRuntime: async () => ({
        versions: { dsh: "0.1.5-rc.2", base: "0.1.5-rc.2", webApp: "0.1.5-rc.2" },
        baseLayers: [{ name: "@deepseek-ai/dsh-base", version: "0.1.5-rc.2", packageDir: "base", patchPath: "base.yml", patches: [] }],
        baseEntries: [{ id: "agent", name: packageName }],
        homePatches: [],
        fingerprint: "selected-pin",
      }),
      composeRuntime: composeOk({
        layers: [{ name: "@deepseek-ai/dsh-base", version: "0.1.5-rc.2" }],
        entries: authorEntries,
      }),
      resolveModule: async () => ({
        packageName,
        packageVersion: resolvedVersion,
        resolvedPath: join(dshHome, "agent.js"),
        builtin: false,
      }),
    }),
  );
  const blueprint = parseBlueprint(
    baseBlueprint({
      packages: [{ name: packageName, version: selectedVersion, source: { type: "npm" } }],
      profile: {
        base: "web",
        bundles: [],
        patch: [{ insert: [{ id: "review-shadowed-agent", name: packageName }] }],
        settings: {},
      },
    }),
  );
  const preview = await wb.preview({ content: stringifyBlueprint(blueprint), name: "pin-shadow", values: {} });
  assert.ok(preview.planId);
  const { ctx, recorded } = jobCtx();
  await assert.rejects(() => wb.apply(preview.planId!, ctx), /selected pin/);
  const last = recorded.at(-1) as {
    product?: { stages?: { packages?: { status?: string; error?: string }; presets?: { status?: string } } };
  };
  assert.equal(last.product?.stages?.packages?.status, "failed");
  assert.match(String(last.product?.stages?.packages?.error), /selected pin/);
  assert.equal(last.product?.stages?.presets?.status, "not-run");
});

test("configured inspector failure after composition fails packages without leaking secrets", async () => {
  const dshHome = home();
  const spaces: WorkbenchSpace[] = [];
  const secret = "sk-compose-canary-token";
  let failNext = false;
  let failures = 0;
  const wb = new BlueprintWorkbench(
    portsOf(dshHome, spaces, {
      inspectRuntime: async (options) => {
        if (failNext) {
          failNext = false;
          failures += 1;
          throw new Error(`inspect failed token=${secret} path=${join(dshHome, ".credentials.yaml")}`);
        }
        return inspectOf(dshHome)(options);
      },
      composeRuntime: async (options, input) => {
        const composed = await composeOk({
          entries: [{ id: "agent", name: "@deepseek-ai/dsh-agent" }],
        })(options, input);
        failNext = true;
        return composed;
      },
      resolveModule: async () => ({
        packageName: "@deepseek-ai/dsh-agent",
        packageVersion: "0.1.5-rc.2",
        resolvedPath: join(dshHome, "agent.js"),
        builtin: false,
      }),
    }),
  );
  const blueprint = parseBlueprint(
    baseBlueprint({
      profile: { base: "web", bundles: [], patch: [{ id: "agent", name: "@deepseek-ai/dsh-agent", disabled: true }], settings: {} },
    }),
  );
  const preview = await wb.preview({ content: stringifyBlueprint(blueprint), name: "inspect-after-compose", values: {} });
  assert.ok(preview.planId);
  const { ctx, recorded } = jobCtx();
  await assert.rejects(() => wb.apply(preview.planId!, ctx), /could not be inspected/);
  assert.equal(failures, 1);
  const last = recorded.at(-1) as {
    product?: {
      spaceId?: string;
      stages?: {
        "space-create"?: { status?: string };
        packages?: { status?: string; error?: string };
        presets?: { status?: string };
        start?: { status?: string };
      };
      writes?: Array<{ status: string }>;
    };
  };
  assert.equal(last.product?.stages?.["space-create"]?.status, "succeeded");
  assert.equal(last.product?.stages?.packages?.status, "failed");
  assert.equal(last.product?.stages?.packages?.error, "The bound runtime could not be inspected.");
  assert.equal(last.product?.stages?.presets?.status, "not-run");
  assert.equal(last.product?.stages?.start?.status, "not-run");
  assert.ok((last.product?.writes ?? []).every((row) => row.status === "not-run"));
  const dumped = JSON.stringify(last);
  assert.equal(dumped.includes(secret), false);
  assert.equal(dumped.includes(dshHome), false);
  assert.equal(dumped.includes(".credentials.yaml"), false);
  assert.equal(dumped.includes("sk-"), false);
});

test("persistent inspector failure after compose publishes packages failed with retained create", async () => {
  const dshHome = home();
  const spaces: WorkbenchSpace[] = [];
  const secret = "sk-persistent-canary-token";
  let composed = false;
  const wb = new BlueprintWorkbench(
    portsOf(dshHome, spaces, {
      ...packageInstall(dshHome),
      inspectRuntime: async (options) => {
        if (composed) throw new Error(`persistent inspect token=${secret} path=${join(dshHome, ".credentials.yaml")}`);
        return inspectOf(dshHome)(options);
      },
      composeRuntime: async (options, input) => {
        const result = await composeOk()(options, input);
        composed = true;
        return result;
      },
      resolveModule: async () => ({
        packageName: "demo-package",
        packageVersion: "1.0.0",
        resolvedPath: join(dshHome, "resolved.js"),
        builtin: false,
      }),
    }),
  );
  const blueprint = parseBlueprint(
    baseBlueprint({
      packages: [{ name: "demo-package", version: "1.0.0", source: { type: "npm" } }],
      profile: {
        base: "web",
        bundles: [],
        patch: [{ insert: [{ id: "main", name: "demo-package" }] }],
        settings: {},
      },
    }),
  );
  const preview = await wb.preview({ content: stringifyBlueprint(blueprint), name: "persist-inspect", values: {} });
  assert.ok(preview.planId);
  const { ctx, recorded } = jobCtx();
  let thrown: { message?: string; outcome?: WorkbenchBlueprintApplyOutcome } | undefined;
  await assert.rejects(
    () => wb.apply(preview.planId!, ctx),
    (error: unknown) => {
      thrown = error as { message?: string; outcome?: WorkbenchBlueprintApplyOutcome };
      assert.equal(thrown.message, "The bound runtime could not be inspected.");
      return true;
    },
  );
  assert.ok(thrown?.outcome);
  assert.equal(thrown.outcome.stages["space-create"].status, "succeeded");
  assert.equal(thrown.outcome.stages.packages.status, "failed");
  assert.equal(thrown.outcome.stages.packages.error, "The bound runtime could not be inspected.");
  assert.equal(thrown.outcome.stages.presets.status, "not-run");
  assert.equal(thrown.outcome.stages.start.status, "not-run");
  assert.equal(thrown.outcome.spaceId, "persist-inspect");
  assert.equal(thrown.outcome.installed[0]?.name, "demo-package");
  assert.equal(thrown.outcome.installed[0]?.version, "1.0.0");
  assert.ok(thrown.outcome.writes.every((row) => row.status === "not-run"));
  const last = recorded.at(-1) as { product?: WorkbenchBlueprintApplyOutcome; spaceId?: string };
  assert.equal(last.product?.stages.packages.status, "failed");
  assert.equal(last.product?.stages.packages.error, "The bound runtime could not be inspected.");
  assert.equal(last.spaceId, "persist-inspect");
  assert.equal(existsSync(join(dshHome, "profiles", "persist-inspect")), true);
  const dumped = JSON.stringify({ last, thrown: thrown.outcome });
  assert.equal(dumped.includes(secret), false);
  assert.equal(dumped.includes(dshHome), false);
  assert.equal(dumped.includes(".credentials.yaml"), false);
  assert.equal(dumped.includes("sk-"), false);
});

test("host module identity comes from bound runtime entries", async () => {
  const dshHome = home();
  const agentEntry = { id: "agent", name: "@deepseek-ai/dsh-agent" };
  const wb = new BlueprintWorkbench(
    portsOf(dshHome, [], {
      inspectRuntime: async () => ({
        versions: { dsh: "0.1.5-rc.2", base: "0.1.5-rc.2", webApp: "0.1.5-rc.2" },
        baseLayers: [{ name: "@deepseek-ai/dsh-base", version: "0.1.5-rc.2", packageDir: "base", patchPath: "base.yml", patches: [] }],
        baseEntries: [agentEntry],
        homePatches: [],
        fingerprint: "host-agent",
      }),
      composeRuntime: composeOk({
        layers: [{ name: "@deepseek-ai/dsh-base", version: "0.1.5-rc.2" }],
        entries: [agentEntry],
      }),
      resolveModule: async () => ({
        packageName: "@deepseek-ai/dsh-agent",
        packageVersion: "0.1.5-rc.2",
        resolvedPath: join(dshHome, "agent.js"),
        builtin: false,
      }),
    }),
  );
  const blueprint = parseBlueprint(
    baseBlueprint({
      profile: { base: "web", bundles: [], patch: [{ id: "agent", name: "@deepseek-ai/dsh-agent", disabled: true }], settings: {} },
    }),
  );
  const preview = await wb.preview({ content: stringifyBlueprint(blueprint), name: "host-agent", values: {} });
  assert.ok(preview.planId);
  const outcome = await wb.apply(preview.planId!, jobCtx().ctx);
  assert.equal(outcome.stages.packages.status, "succeeded");
  assert.equal(outcome.stages.presets.status, "succeeded");
});

test("explicit override remaps a renamed binding and refuses ambiguous remap by stale index", async () => {
  const dshHome = home();
  writeSpace(dshHome, "renamed", {
    patch: "- id: beta\n  name: demo-package\n  config:\n    path: keep-beta\n- id: alpha\n  name: other-package\n  config:\n    path: my-local-output\n",
  });
  const origin = parseBlueprint(
    baseBlueprint({
      profile: {
        base: "web",
        bundles: [],
        patch: [{ id: "alpha", name: "demo-package", config: { path: null } }],
        settings: {},
      },
      inputs: [{ id: "output", type: "string", label: "Output", required: true }],
      bindings: [{ input: "output", target: { kind: "value", pointer: "/profile/patch/0/config/path" } }],
    }),
  );
  writeFileSync(
    join(dshHome, "hub", "renamed", "blueprint-origin.json"),
    JSON.stringify({
      schemaVersion: 1,
      blueprint: origin,
      bindings: [{ input: "output", kind: "value", pointer: "/profile/patch/0/config/path", entryId: "alpha", entryName: "demo-package" }],
      appliedAt: new Date().toISOString(),
    }),
  );
  const wb = new BlueprintWorkbench(portsOf(dshHome, [space("renamed"), space("sameidx"), space("dup")]));
  await assert.rejects(
    () =>
      wb.generate({
        spaceId: "renamed",
        metadata: { name: "test", version: "1.0.0" },
        selection: { packages: [], includePatch: true, settingsNamespaces: [] },
        bindingOverrides: [{ pointer: "/profile/patch/0/config/path", input: { id: "wrong", type: "string", label: "Wrong", required: true } }],
      }),
    /explicit override/,
  );
  const generated = await wb.generate({
    spaceId: "renamed",
    metadata: { name: "test", version: "1.0.0" },
    selection: { packages: [], includePatch: true, settingsNamespaces: [] },
    bindingOverrides: [
      { pointer: "/profile/patch/1/config/path", input: { id: "new-output", type: "string", label: "New output", required: true } },
    ],
  });
  const alpha = generated.blueprint.profile.patch.find((row) => "id" in row && row.id === "alpha") as { config?: { path?: unknown } };
  const beta = generated.blueprint.profile.patch.find((row) => "id" in row && row.id === "beta") as { config?: { path?: unknown } };
  assert.equal(alpha?.config?.path, null);
  assert.equal(beta?.config?.path, "keep-beta");
  assert.equal(generated.blueprint.inputs.some((item) => item.id === "new-output"), true);
  assert.equal(generated.blueprint.inputs.some((item) => item.id === "output"), false);
  assert.equal(JSON.stringify(generated.blueprint).includes("my-local-output"), false);
  assert.equal(JSON.stringify(generated.blueprint).includes("recv"), false);

  writeSpace(dshHome, "sameidx", {
    patch: "- id: alpha\n  name: other-package\n  config:\n    path: my-local-output\n",
  });
  writeFileSync(
    join(dshHome, "hub", "sameidx", "blueprint-origin.json"),
    JSON.stringify({
      schemaVersion: 1,
      blueprint: origin,
      bindings: [{ input: "output", kind: "value", pointer: "/profile/patch/0/config/path", entryId: "alpha", entryName: "demo-package" }],
      appliedAt: new Date().toISOString(),
    }),
  );
  const sameIndex = await wb.generate({
    spaceId: "sameidx",
    metadata: { name: "test", version: "1.0.0" },
    selection: { packages: [], includePatch: true, settingsNamespaces: [] },
    bindingOverrides: [
      { pointer: "/profile/patch/0/config/path", input: { id: "new-output", type: "string", label: "New output", required: true } },
    ],
  });
  const sameAlpha = sameIndex.blueprint.profile.patch.find((row) => "id" in row && row.id === "alpha") as { config?: { path?: unknown } };
  assert.equal(sameAlpha?.config?.path, null);
  assert.equal(sameIndex.blueprint.inputs.some((item) => item.id === "new-output"), true);
  assert.equal(JSON.stringify(sameIndex.blueprint).includes("my-local-output"), false);

  writeSpace(dshHome, "dup", {
    patch: "- id: alpha\n  name: demo-package\n  config:\n    path: first\n- id: alpha\n  name: demo-package\n  config:\n    path: \"C:\\\\recv\\\\dup-out\"\n",
  });
  writeFileSync(
    join(dshHome, "hub", "dup", "blueprint-origin.json"),
    JSON.stringify({
      schemaVersion: 1,
      blueprint: origin,
      bindings: [{ input: "output", kind: "value", pointer: "/profile/patch/0/config/path", entryId: "alpha", entryName: "demo-package" }],
      appliedAt: new Date().toISOString(),
    }),
  );
  await assert.rejects(
    () =>
      wb.generate({
        spaceId: "dup",
        metadata: { name: "test", version: "1.0.0" },
        selection: { packages: [], includePatch: true, settingsNamespaces: [] },
        bindingOverrides: [
          { pointer: "/profile/patch/0/config/path", input: { id: "new-output", type: "string", label: "New output", required: true } },
        ],
      }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /explicit override/);
      assert.equal(message.includes("recv"), false);
      return true;
    },
  );
});

test("profile-relative hub plugin file spec is npm when library and identity match", async () => {
  const dshHome = home();
  mkdirSync(join(dshHome, "hub", "plugins"), { recursive: true });
  writeFileSync(join(dshHome, "hub", "plugins", "is-number__7.0.0.tgz"), "fixture-cache-bytes");
  writeFileSync(join(dshHome, "hub", "plugins", "dsh-theme-plugin__0.3.3.tgz"), "theme-cache-bytes");
  writeFileSync(
    join(dshHome, "hub", "plugin-library.json"),
    JSON.stringify({
      plugins: [
        {
          id: "is-number@7.0.0",
          spec: "is-number@7.0.0",
          packageName: "is-number",
          title: "is-number",
          source: "manual",
          tarball: "hub/plugins/is-number__7.0.0.tgz",
          downloadedAt: new Date().toISOString(),
        },
        {
          id: "dsh-theme-plugin@0.3.3",
          spec: "dsh-theme-plugin@0.3.3",
          packageName: "dsh-theme-plugin",
          title: "dsh-theme-plugin",
          source: "manual",
          tarball: "hub/plugins/dsh-theme-plugin__0.3.3.tgz",
          downloadedAt: new Date().toISOString(),
        },
      ],
    }),
  );
  const numberSpec = process.platform === "win32" ? "file:..\\..\\hub\\plugins\\is-number__7.0.0.tgz" : "file:../../hub/plugins/is-number__7.0.0.tgz";
  writeSpace(dshHome, "source", {
    deps: {
      "is-number": numberSpec,
      "dsh-theme-plugin": "file:../../hub/plugins/dsh-theme-plugin__0.3.3.tgz",
    },
    resolved: { "is-number": "7.0.0", "dsh-theme-plugin": "0.3.3" },
  });
  const wb = new BlueprintWorkbench(portsOf(dshHome, [space("source")]));
  const source = await wb.source("source");
  const number = source.packages.find((row) => row.name === "is-number");
  const theme = source.packages.find((row) => row.name === "dsh-theme-plugin");
  assert.equal(number?.source, "npm");
  assert.equal(number?.eligibility.available, true);
  assert.equal(number?.requestedSpec, "is-number@7.0.0");
  assert.match(String(number?.integrity), /^sha512-/);
  assert.equal(theme?.source, "npm");
  assert.equal(theme?.eligibility.available, true);

  writeFileSync(
    join(dshHome, "profiles", "source", "package.json"),
    JSON.stringify({
      dependencies: { "demo-package": "file:../../archive.tgz" },
      dsh: { profile: { bundles: [] } },
    }),
  );
  const local = (await wb.source("source")).packages.find((row) => row.name === "demo-package");
  assert.equal(local?.source, "local");
  assert.equal(local?.eligibility.available, false);
});

test("official runtime rejects managed Home settings overlay, config-only not-found, and accepts host agent overlay", async (t) => {
  const bin = officialRc2Bin();
  if (!bin) {
    t.skip("official DSH 0.1.5-rc.2 bin is not installed");
    return;
  }
  const hostBundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
  const runtimePorts = (dshHome: string, spaces: WorkbenchSpace[], extra: Partial<BlueprintWorkbenchPorts> = {}) =>
    portsOf(dshHome, spaces, {
      runtimeBin: () => bin,
      inspectRuntime: inspectBlueprintRuntime,
      composeRuntime: extra.composeRuntime ?? composeBlueprintRuntime,
      resolveModule: resolveBlueprintModule,
      createSpace: async (input) => {
        writeSpace(dshHome, input.name, { bundles: hostBundles });
        spaces.push(space(input.name));
      },
      ...extra,
    });

  const overlayHome = home();
  writeFileSync(join(overlayHome, "cordis.patch.yml"), "- id: settings\n  config:\n    path: hub/other/settings.yaml\n");
  const overlayWb = new BlueprintWorkbench(runtimePorts(overlayHome, []));
  const overlayPreview = await overlayWb.preview({
    content: stringifyBlueprint(parseBlueprint(baseBlueprint())),
    name: "target",
    values: {},
  });
  assert.equal(overlayPreview.planId, undefined);
  assert.ok(overlayPreview.diagnostics.some((row) => row.code === "blueprint.home-patch" && row.severity === "error"));
  assert.equal(existsSync(join(overlayHome, "profiles", "target")), false);
  assert.equal(existsSync(join(overlayHome, "profiles", "web")), false);

  const missingHome = home();
  let composeCalls = 0;
  const missingWb = new BlueprintWorkbench(
    runtimePorts(missingHome, [], {
      composeRuntime: async (options, input) => {
        composeCalls += 1;
        return composeBlueprintRuntime(options, input);
      },
    }),
  );
  const missing = parseBlueprint(
    baseBlueprint({
      profile: { base: "web", bundles: [], patch: [{ id: "blueprint-review-no-such-entry", config: { a: 1 } }], settings: {} },
    }),
  );
  const missingPreview = await missingWb.preview({ content: stringifyBlueprint(missing), name: "target", values: {} });
  assert.ok(missingPreview.planId);
  assert.equal(composeCalls, 0);
  await assert.rejects(() => missingWb.apply(missingPreview.planId!, jobCtx().ctx), /overlay/);
  assert.equal(composeCalls, 1);

  const agentHome = home();
  const inspected = await inspectBlueprintRuntime({ home: agentHome, bin });
  const agent = inspected.baseEntries.find((row) => row && typeof row === "object" && (row as { name?: string }).name === "@deepseek-ai/dsh-agent") as
    | { id?: string; name?: string }
    | undefined;
  assert.ok(agent?.id && agent.name);
  const agentWb = new BlueprintWorkbench(runtimePorts(agentHome, []));
  const agentBp = parseBlueprint(
    baseBlueprint({
      profile: { base: "web", bundles: [], patch: [{ id: agent.id, name: agent.name, disabled: true }], settings: {} },
    }),
  );
  const agentPreview = await agentWb.preview({ content: stringifyBlueprint(agentBp), name: "target", values: {} });
  assert.ok(agentPreview.planId);
  const agentOutcome = await agentWb.apply(agentPreview.planId!, jobCtx().ctx);
  assert.equal(agentOutcome.stages["space-create"].status, "succeeded");
  assert.equal(agentOutcome.stages.packages.status, "succeeded");
  assert.equal(agentOutcome.stages.presets.status, "succeeded");
  assert.equal(agentOutcome.stages.start.status, "not-run");

  const pinHome = home();
  const pinSpaces: WorkbenchSpace[] = [];
  const packageName = "@deepseek-ai/dsh-agent";
  const selectedVersion = "0.1.5-rc.1";
  const pinWb = new BlueprintWorkbench(
    runtimePorts(pinHome, pinSpaces, {
      prepareBlueprintPackage: async () => ({
        archivePath: join(pinHome, "fixture.tgz"),
        name: packageName,
        version: selectedVersion,
        integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
        hasBundle: false,
        lifecycleScripts: [],
      }),
      installPlugin: async (spaceId) => {
        const dir = join(pinHome, "profiles", spaceId, "node_modules", ...packageName.split("/"));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: packageName, version: selectedVersion }));
      },
    }),
  );
  const pinBp = parseBlueprint(
    baseBlueprint({
      packages: [{ name: packageName, version: selectedVersion, source: { type: "npm" } }],
      profile: {
        base: "web",
        bundles: [],
        patch: [{ insert: [{ id: "review-shadowed-agent", name: packageName }] }],
        settings: {},
      },
    }),
  );
  const pinPreview = await pinWb.preview({ content: stringifyBlueprint(pinBp), name: "target", values: {} });
  assert.ok(pinPreview.planId);
  const { ctx: pinCtx, recorded: pinRecorded } = jobCtx();
  await assert.rejects(() => pinWb.apply(pinPreview.planId!, pinCtx), /selected pin/);
  const pinLast = pinRecorded.at(-1) as {
    product?: { stages?: { packages?: { status?: string; error?: string }; presets?: { status?: string } }; installed?: Array<{ version?: string }> };
  };
  assert.equal(pinLast.product?.stages?.packages?.status, "failed");
  assert.match(String(pinLast.product?.stages?.packages?.error), /selected pin/);
  assert.equal(pinLast.product?.stages?.presets?.status, "not-run");
  assert.equal(pinLast.product?.installed?.[0]?.version, selectedVersion);
  const resolved = await resolveBlueprintModule({ home: pinHome, bin }, { spaceId: "target", specifier: packageName });
  assert.equal(resolved.packageVersion, "0.1.5-rc.2");
  assert.notEqual(resolved.packageVersion, selectedVersion);
});
