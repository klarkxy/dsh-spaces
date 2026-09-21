import { parseDocument, visit, isScalar } from "yaml";
import { parse as parseSemVer, satisfies as semverSatisfies, validRange as semverValidRange } from "semver";
import {
  BLUEPRINT_ARCH,
  BLUEPRINT_CODE,
  BLUEPRINT_FORBIDDEN_SETTINGS,
  BLUEPRINT_FORMAT_VERSION,
  BLUEPRINT_GITHUB_REPO_RE,
  BLUEPRINT_GIT_COMMIT_RE,
  BLUEPRINT_HOST_PACKAGES,
  BLUEPRINT_INPUT_ID_RE,
  BLUEPRINT_INPUT_TYPES,
  BLUEPRINT_JSON_MAX_BYTES,
  BLUEPRINT_KIND,
  BLUEPRINT_MANAGED_ENTRY_IDS,
  BLUEPRINT_MAX_DEPTH,
  BLUEPRINT_OS,
  BLUEPRINT_RELATION_TYPES,
  BLUEPRINT_SPACES_CONTROL_PACKAGES,
  BLUEPRINT_TEST_CHECKS,
  BlueprintError,
  type Blueprint,
  type BlueprintArch,
  type BlueprintBindResult,
  type BlueprintBinding,
  type BlueprintBindingTarget,
  type BlueprintDiagnostic,
  type BlueprintEnvironment,
  type BlueprintInput,
  type BlueprintInputType,
  type BlueprintInputValue,
  type BlueprintInputValues,
  type BlueprintJson,
  type BlueprintJsonObject,
  type BlueprintMetadata,
  type BlueprintModelRef,
  type BlueprintOs,
  type BlueprintPackage,
  type BlueprintPackageEvidence,
  type BlueprintPackageSource,
  type BlueprintPatch,
  type BlueprintPatchEntry,
  type BlueprintPatchInsert,
  type BlueprintPatchItem,
  type BlueprintProfile,
  type BlueprintRelation,
  type BlueprintRelationType,
  type BlueprintRequirements,
  type BlueprintSettings,
  type BlueprintTestCheck,
  type BlueprintTestedWith,
} from "../../shared/blueprint";

export {
  BLUEPRINT_ARCH,
  BLUEPRINT_CODE,
  BLUEPRINT_FORBIDDEN_SETTINGS,
  BLUEPRINT_FORMAT_VERSION,
  BLUEPRINT_HOST_PACKAGES,
  BLUEPRINT_INPUT_ID_RE,
  BLUEPRINT_JSON_MAX_BYTES,
  BLUEPRINT_KIND,
  BLUEPRINT_MAX_DEPTH,
  BLUEPRINT_OS,
  BLUEPRINT_SCHEMA_ID,
  BLUEPRINT_SCHEMA_RELATIVE_PATH,
  BLUEPRINT_SHARE_MAX_BYTES,
  BLUEPRINT_SHARE_PREFIX,
  BLUEPRINT_SPACES_CONTROL_PACKAGES,
  BlueprintError,
  isBlueprintError,
} from "../../shared/blueprint";
export type {
  Blueprint,
  BlueprintArch,
  BlueprintBindResult,
  BlueprintBinding,
  BlueprintDiagnostic,
  BlueprintEncodeMode,
  BlueprintEnvironment,
  BlueprintInput,
  BlueprintInputType,
  BlueprintInputValue,
  BlueprintInputValues,
  BlueprintJson,
  BlueprintMetadata,
  BlueprintModelRef,
  BlueprintOs,
  BlueprintPackage,
  BlueprintPackageEvidence,
  BlueprintPatch,
  BlueprintPatchInsert,
  BlueprintProfile,
  BlueprintRelation,
  BlueprintRequirements,
  BlueprintSettings,
  BlueprintShareEncoding,
  BlueprintTestedWith,
} from "../../shared/blueprint";

const ROOT_FIELDS = new Set([
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
]);
const METADATA_FIELDS = new Set(["name", "version", "id", "description", "author", "homepage", "license"]);
const REQUIREMENT_FIELDS = new Set(["dsh", "spaces", "node", "os", "arch"]);
const PACKAGE_FIELDS = new Set(["name", "version", "source", "integrity"]);
const NPM_SOURCE_FIELDS = new Set(["type"]);
const GITHUB_SOURCE_FIELDS = new Set(["type", "repository", "commit"]);
const PROFILE_FIELDS = new Set(["base", "bundles", "patch", "settings"]);
const ENTRY_FIELDS = new Set(["id", "name", "config", "group", "disabled", "inject", "intercept", "isolate"]);
const INSERT_OP_FIELDS = new Set(["id", "insert"]);
const INPUT_FIELDS = new Set(["id", "type", "label", "required", "description", "default"]);
const BINDING_FIELDS = new Set(["input", "target"]);
const VALUE_TARGET_FIELDS = new Set(["kind", "pointer"]);
const MODEL_TARGET_FIELDS = new Set(["kind"]);
const RELATION_FIELDS = new Set(["type", "from", "to", "reason", "fromVersion", "toVersion"]);
const TESTED_FIELDS = new Set(["dsh", "spaces", "node", "os", "arch", "checkedAt", "checks", "evidence"]);
const HOST_PACKAGE_SET = new Set<string>(BLUEPRINT_HOST_PACKAGES);
const CONTROL_PACKAGE_SET = new Set<string>(BLUEPRINT_SPACES_CONTROL_PACKAGES);
const MANAGED_ENTRY_SET = new Set<string>(BLUEPRINT_MANAGED_ENTRY_IDS);
const FORBIDDEN_SETTINGS = new Set<string>(BLUEPRINT_FORBIDDEN_SETTINGS);
const OS_SET = new Set<string>(BLUEPRINT_OS);
const ARCH_SET = new Set<string>(BLUEPRINT_ARCH);
const INPUT_TYPE_SET = new Set<string>(BLUEPRINT_INPUT_TYPES);
const RELATION_TYPE_SET = new Set<string>(BLUEPRINT_RELATION_TYPES);
const CHECK_SET = new Set<string>(BLUEPRINT_TEST_CHECKS);

const INTEGER_TOKEN = /^-?(?:0|[1-9]\d+)$/;
const RFC3339 =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;

type UnknownRecord = { [key: string]: unknown };

export function parseBlueprintJson(text: string): Blueprint {
  return parseBlueprint(parseBlueprintJsonValue(text));
}

export function parseBlueprint(value: unknown): Blueprint {
  const root = expectObject(reviveJson(value, 1, ""), "");
  assertClosed(root, ROOT_FIELDS, "");
  if (root.kind !== BLUEPRINT_KIND) {
    throw fail(BLUEPRINT_CODE.INVALID_FIELD, `kind must be ${BLUEPRINT_KIND}`, "/kind");
  }
  if (root.formatVersion !== BLUEPRINT_FORMAT_VERSION) {
    throw fail(
      BLUEPRINT_CODE.UNSUPPORTED_VERSION,
      `unsupported formatVersion ${stringifyUnknown(root.formatVersion)}`,
      "/formatVersion",
    );
  }
  if (!Number.isInteger(root.formatVersion)) {
    throw fail(BLUEPRINT_CODE.INVALID_FIELD, "formatVersion must be the integer 1", "/formatVersion");
  }

  const blueprint: Blueprint = {
    kind: BLUEPRINT_KIND,
    formatVersion: BLUEPRINT_FORMAT_VERSION,
    metadata: parseMetadata(root.metadata),
    packages: parsePackages(root.packages),
    profile: parseProfile(root.profile),
    inputs: root.inputs === undefined ? [] : parseInputs(root.inputs),
    bindings: root.bindings === undefined ? [] : parseBindings(root.bindings),
    relations: root.relations === undefined ? [] : parseRelations(root.relations),
  };
  if (root.requirements !== undefined) blueprint.requirements = parseRequirements(root.requirements);
  if (root.testedWith !== undefined) blueprint.testedWith = parseTestedWith(root.testedWith);
  if (root.extensions !== undefined) blueprint.extensions = parseExtensions(root.extensions);

  const selected = new Map<string, BlueprintPackage>();
  for (const pkg of blueprint.packages) {
    if (selected.has(pkg.name)) {
      throw fail(BLUEPRINT_CODE.INVALID_FIELD, `duplicate package ${pkg.name}`, "/packages");
    }
    selected.set(pkg.name, pkg);
  }
  const bundleSeen = new Set<string>();
  for (const [index, name] of blueprint.profile.bundles.entries()) {
    if (bundleSeen.has(name)) {
      throw fail(BLUEPRINT_CODE.INVALID_FIELD, `duplicate bundle ${name}`, `/profile/bundles/${index}`);
    }
    bundleSeen.add(name);
    if (!selected.has(name)) {
      throw fail(
        BLUEPRINT_CODE.INVALID_FIELD,
        `bundle ${name} is not a selected package`,
        `/profile/bundles/${index}`,
      );
    }
  }
  assertInputsAndBindings(blueprint);
  assertRelations(blueprint.relations, selected);
  return blueprint;
}

export function bindBlueprintInputs(blueprint: Blueprint, values: BlueprintInputValues): BlueprintBindResult {
  if (!isPlainObject(values)) {
    throw fail(BLUEPRINT_CODE.INPUT_TYPE, "input values must be an object");
  }
  const patch = cloneJson(blueprint.profile.patch);
  const settings = cloneJson(blueprint.profile.settings);
  const root = { profile: { patch, settings } } as unknown as BlueprintJsonObject;
  let model: BlueprintModelRef | undefined;
  const known = new Set(blueprint.inputs.map((input) => input.id));
  for (const key of ownStringKeys(values)) {
    if (!known.has(key)) {
      throw fail(BLUEPRINT_CODE.INPUT_TYPE, `unknown input ${key}`);
    }
  }

  const byId = new Map(blueprint.inputs.map((input) => [input.id, input]));
  for (const binding of blueprint.bindings) {
    const input = byId.get(binding.input);
    if (!input) {
      throw fail(BLUEPRINT_CODE.BINDING, `binding references missing input ${binding.input}`);
    }
    const resolved = resolveInputValue(input, values);
    if (binding.target.kind === "default-model") {
      if (resolved.status === "missing") {
        if (input.required) throw missingInput(input.id);
        continue;
      }
      if (resolved.status !== "model") {
        throw fail(BLUEPRINT_CODE.INPUT_TYPE, `input ${input.id} must be a model`, inputPath(input.id));
      }
      model = { connectionId: resolved.value.connectionId, modelId: resolved.value.modelId };
      continue;
    }
    if (resolved.status === "missing") {
      if (input.required) throw missingInput(input.id);
      deletePointer(root, binding.target.pointer);
      continue;
    }
    if (resolved.status === "model") {
      throw fail(BLUEPRINT_CODE.INPUT_TYPE, `input ${input.id} cannot bind a model to a value pointer`, inputPath(input.id));
    }
    setPointer(root, binding.target.pointer, resolved.value);
  }
  return model ? { patch, settings, model } : { patch, settings };
}

export function diagnoseBlueprint(
  blueprint: Blueprint,
  environment?: BlueprintEnvironment,
): BlueprintDiagnostic[] {
  const diagnostics: BlueprintDiagnostic[] = [];
  diagnoseRequirements(blueprint, environment, diagnostics);
  diagnoseTestedWith(blueprint, diagnostics);
  diagnosePackages(blueprint, diagnostics);
  diagnosePatchNames(blueprint, diagnostics);
  diagnosePatchApply(blueprint, diagnostics);
  diagnoseRelations(blueprint, environment, diagnostics);
  return diagnostics;
}

export function parseBlueprintJsonValue(text: string): unknown {
  if (typeof text !== "string") {
    throw fail(BLUEPRINT_CODE.INVALID_JSON, "JSON text must be a string");
  }
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
    throw fail(BLUEPRINT_CODE.BOM, "JSON must be UTF-8 without a BOM");
  }
  if (utf8ByteLength(text) > BLUEPRINT_JSON_MAX_BYTES) {
    throw fail(
      BLUEPRINT_CODE.JSON_TOO_LARGE,
      `JSON exceeds ${BLUEPRINT_JSON_MAX_BYTES} bytes`,
    );
  }
  if (hasUnpairedSurrogate(text)) {
    throw fail(BLUEPRINT_CODE.SURROGATE, "JSON contains an unpaired Unicode surrogate");
  }

  let doc: ReturnType<typeof parseDocument> | undefined;
  try {
    doc = parseDocument(text, {
      prettyErrors: true,
      schema: "json",
      uniqueKeys: true,
      strict: true,
    });
  } catch {
    doc = undefined;
  }
  if (doc?.errors.some((error) => error.code === "DUPLICATE_KEY")) {
    throw fail(BLUEPRINT_CODE.DUPLICATE_KEY, "duplicate JSON keys are not allowed");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw fail(
      BLUEPRINT_CODE.INVALID_JSON,
      error instanceof Error ? error.message : "JSON is invalid",
    );
  }
  if (doc && doc.errors.length === 0) assertYamlJsonNumbers(doc);
  return reviveJson(parsed, 1, "");
}

function parseMetadata(value: unknown): BlueprintMetadata {
  const row = expectObject(value, "/metadata");
  assertClosed(row, METADATA_FIELDS, "/metadata");
  const metadata: BlueprintMetadata = {
    name: expectNonEmptyString(row.name, "/metadata/name"),
    version: expectExactSemver(row.version, "/metadata/version"),
  };
  if (row.id !== undefined) metadata.id = expectNonEmptyString(row.id, "/metadata/id");
  if (row.description !== undefined) {
    metadata.description = expectNonEmptyString(row.description, "/metadata/description");
  }
  if (row.author !== undefined) metadata.author = expectNonEmptyString(row.author, "/metadata/author");
  if (row.homepage !== undefined) metadata.homepage = expectHttpsUrl(row.homepage, "/metadata/homepage");
  if (row.license !== undefined) metadata.license = expectNonEmptyString(row.license, "/metadata/license");
  return metadata;
}

function parseRequirements(value: unknown): BlueprintRequirements {
  const row = expectObject(value, "/requirements");
  assertClosed(row, REQUIREMENT_FIELDS, "/requirements");
  const requirements: BlueprintRequirements = {};
  if (row.dsh !== undefined) requirements.dsh = expectSemverRange(row.dsh, "/requirements/dsh");
  if (row.spaces !== undefined) requirements.spaces = expectSemverRange(row.spaces, "/requirements/spaces");
  if (row.node !== undefined) requirements.node = expectSemverRange(row.node, "/requirements/node");
  if (row.os !== undefined) {
    requirements.os = uniqueEnumArray(row.os, OS_SET, "/requirements/os") as BlueprintOs[];
  }
  if (row.arch !== undefined) {
    requirements.arch = uniqueEnumArray(row.arch, ARCH_SET, "/requirements/arch") as BlueprintArch[];
  }
  return requirements;
}

function parsePackages(value: unknown): BlueprintPackage[] {
  const rows = expectArray(value, "/packages");
  return rows.map((row, index) => parsePackage(row, `/packages/${index}`));
}

function parsePackage(value: unknown, path: string): BlueprintPackage {
  const row = expectObject(value, path);
  assertClosed(row, PACKAGE_FIELDS, path);
  const name = expectNpmPackageName(row.name, `${path}/name`);
  assertUserPackage(name, `${path}/name`);
  const pkg: BlueprintPackage = {
    name,
    version: expectExactSemver(row.version, `${path}/version`),
    source: parsePackageSource(row.source, `${path}/source`, name),
  };
  if (row.integrity !== undefined) {
    if (pkg.source.type !== "npm") {
      throw fail(
        BLUEPRINT_CODE.INVALID_FIELD,
        "integrity is only allowed on npm tarball sources",
        `${path}/integrity`,
      );
    }
    pkg.integrity = expectSha512Integrity(row.integrity, `${path}/integrity`);
  }
  return pkg;
}

function parsePackageSource(value: unknown, path: string, _packageName: string): BlueprintPackageSource {
  const row = expectObject(value, path);
  if (row.type === "npm") {
    assertClosed(row, NPM_SOURCE_FIELDS, path);
    return { type: "npm" };
  }
  if (row.type === "github") {
    assertClosed(row, GITHUB_SOURCE_FIELDS, path);
    const repository = expectNonEmptyString(row.repository, `${path}/repository`);
    if (!BLUEPRINT_GITHUB_REPO_RE.test(repository) || repository.split("/").length !== 2) {
      throw fail(BLUEPRINT_CODE.INVALID_FIELD, "GitHub repository must be owner/repo", `${path}/repository`);
    }
    const commit = expectNonEmptyString(row.commit, `${path}/commit`);
    if (!BLUEPRINT_GIT_COMMIT_RE.test(commit)) {
      throw fail(BLUEPRINT_CODE.INVALID_FIELD, "GitHub commit must be a 40-character lowercase SHA", `${path}/commit`);
    }
    return { type: "github", repository, commit };
  }
  throw fail(BLUEPRINT_CODE.INVALID_FIELD, "package source type must be npm or github", `${path}/type`);
}

function parseProfile(value: unknown): BlueprintProfile {
  const row = expectObject(value, "/profile");
  assertClosed(row, PROFILE_FIELDS, "/profile");
  if (row.base !== "web") {
    throw fail(BLUEPRINT_CODE.INVALID_FIELD, "profile.base must be web", "/profile/base");
  }
  const bundles = expectArray(row.bundles, "/profile/bundles").map((item, index) =>
    expectNpmPackageName(item, `/profile/bundles/${index}`),
  );
  for (const [index, name] of bundles.entries()) {
    assertUserPackage(name, `/profile/bundles/${index}`);
  }
  const patch = row.patch === undefined ? [] : parsePatch(row.patch, "/profile/patch");
  const settings = row.settings === undefined ? emptyObject<BlueprintSettings>() : parseSettings(row.settings);
  return { base: "web", bundles, patch, settings };
}

function parsePatch(value: unknown, path: string): BlueprintPatch {
  return expectArray(value, path).map((item, index) => parsePatchItem(item, `${path}/${index}`));
}

function parsePatchItem(value: unknown, path: string): BlueprintPatchItem {
  const row = expectObject(value, path);
  if (Object.hasOwn(row, "insert")) {
    assertClosed(row, INSERT_OP_FIELDS, path);
    const insert = expectArray(row.insert, `${path}/insert`).map((item, index) =>
      parsePatchEntry(item, `${path}/insert/${index}`, true),
    );
    if (row.id === undefined) return { insert };
    return { id: expectNonEmptyString(row.id, `${path}/id`), insert };
  }
  return parsePatchEntry(row, path, false);
}

function parsePatchEntry(value: unknown, path: string, inserted: boolean): BlueprintPatchEntry {
  const row = expectObject(value, path);
  assertClosed(row, ENTRY_FIELDS, path);
  const entry: BlueprintPatchEntry = { id: expectNonEmptyString(row.id, `${path}/id`) };
  if (row.name !== undefined) {
    entry.name = expectModuleName(row.name, `${path}/name`);
  } else if (inserted) {
    throw fail(BLUEPRINT_CODE.INVALID_FIELD, "inserted patch entries require name", `${path}/name`);
  }
  if (row.group !== undefined) entry.group = expectBooleanOrNull(row.group, `${path}/group`);
  if (row.disabled !== undefined) entry.disabled = expectBooleanOrNull(row.disabled, `${path}/disabled`);
  if (row.inject !== undefined) {
    entry.inject = row.inject === null ? null : parseInject(row.inject, `${path}/inject`);
  }
  if (row.intercept !== undefined) {
    entry.intercept = row.intercept === null ? null : expectJsonObject(row.intercept, `${path}/intercept`);
  }
  if (row.isolate !== undefined) {
    entry.isolate = row.isolate === null ? null : parseIsolate(row.isolate, `${path}/isolate`);
  }
  if (row.config !== undefined) {
    if (entry.group === true) {
      if (row.config === null) {
        entry.config = null;
      } else {
        const children = expectArray(row.config, `${path}/config`).map((child, index) =>
          parsePatchEntry(child, `${path}/config/${index}`, true),
        );
        entry.config = children as unknown as BlueprintJson;
      }
    } else {
      entry.config = expectJson(row.config, `${path}/config`);
    }
  }
  assertNoJsExpr(entry as unknown as BlueprintJson, path);
  return entry;
}

function parseInject(value: unknown, path: string): string[] | BlueprintJsonObject {
  if (Array.isArray(value)) {
    return value.map((item, index) => expectNonEmptyString(item, `${path}/${index}`));
  }
  return expectJsonObject(value, path);
}

function parseIsolate(value: unknown, path: string): { [service: string]: true | string } {
  const row = expectObject(value, path);
  const isolate: { [service: string]: true | string } = emptyObject();
  for (const key of ownStringKeys(row)) {
    const item = row[key];
    if (item !== true && typeof item !== "string") {
      throw fail(BLUEPRINT_CODE.INVALID_FIELD, "isolate values must be true or a string label", `${path}/${jsonPointerToken(key)}`);
    }
    if (typeof item === "string" && item.length === 0) {
      throw fail(BLUEPRINT_CODE.INVALID_FIELD, "isolate label must be non-empty", `${path}/${jsonPointerToken(key)}`);
    }
    defineOwn(isolate, key, item);
  }
  return isolate;
}

function expectBooleanOrNull(value: unknown, path: string): boolean | null {
  if (value === null) return null;
  if (typeof value !== "boolean") {
    throw fail(BLUEPRINT_CODE.INVALID_FIELD, "expected a boolean or null", path);
  }
  return value;
}

function isInsertOp(item: BlueprintPatchItem): item is BlueprintPatchInsert {
  return Object.hasOwn(item, "insert");
}

function groupChildEntries(config: BlueprintJson | undefined): BlueprintPatchEntry[] | undefined {
  if (!Array.isArray(config)) return undefined;
  return config as unknown as BlueprintPatchEntry[];
}

function parseSettings(value: unknown): BlueprintSettings {
  const row = expectObject(value, "/profile/settings");
  const settings: BlueprintSettings = emptyObject();
  for (const key of ownStringKeys(row)) {
    if (FORBIDDEN_SETTINGS.has(key)) {
      throw fail(
        BLUEPRINT_CODE.INVALID_FIELD,
        `settings namespace ${key} cannot be shared; bind a model input instead`,
        `/profile/settings/${jsonPointerToken(key)}`,
      );
    }
    defineOwn(settings, key, expectJson(row[key], `/profile/settings/${jsonPointerToken(key)}`));
  }
  return settings;
}

function parseInputs(value: unknown): BlueprintInput[] {
  const rows = expectArray(value, "/inputs");
  const seen = new Set<string>();
  return rows.map((item, index) => {
    const path = `/inputs/${index}`;
    const row = expectObject(item, path);
    assertClosed(row, INPUT_FIELDS, path);
    const id = expectNonEmptyString(row.id, `${path}/id`);
    if (!BLUEPRINT_INPUT_ID_RE.test(id)) {
      throw fail(BLUEPRINT_CODE.INVALID_FIELD, "input id must match [a-z][a-z0-9-]{0,63}", `${path}/id`);
    }
    if (seen.has(id)) throw fail(BLUEPRINT_CODE.INVALID_FIELD, `duplicate input id ${id}`, `${path}/id`);
    seen.add(id);
    const type = expectEnum(row.type, INPUT_TYPE_SET, `${path}/type`) as BlueprintInputType;
    if (typeof row.required !== "boolean") {
      throw fail(BLUEPRINT_CODE.INVALID_FIELD, "required must be a boolean", `${path}/required`);
    }
    const input: BlueprintInput = {
      id,
      type,
      label: expectNonEmptyString(row.label, `${path}/label`),
      required: row.required,
    };
    if (row.description !== undefined) {
      input.description = expectNonEmptyString(row.description, `${path}/description`);
    }
    if (row.default !== undefined) {
      if (type === "directory" || type === "model") {
        throw fail(BLUEPRINT_CODE.INVALID_FIELD, `${type} inputs cannot declare default`, `${path}/default`);
      }
      input.default = expectDefault(row.default, type, `${path}/default`);
    }
    return input;
  });
}

function parseBindings(value: unknown): BlueprintBinding[] {
  return expectArray(value, "/bindings").map((item, index) => {
    const path = `/bindings/${index}`;
    const row = expectObject(item, path);
    assertClosed(row, BINDING_FIELDS, path);
    return {
      input: expectNonEmptyString(row.input, `${path}/input`),
      target: parseBindingTarget(row.target, `${path}/target`),
    };
  });
}

function parseBindingTarget(value: unknown, path: string): BlueprintBindingTarget {
  const row = expectObject(value, path);
  if (row.kind === "default-model") {
    assertClosed(row, MODEL_TARGET_FIELDS, path);
    return { kind: "default-model" };
  }
  if (row.kind === "value") {
    assertClosed(row, VALUE_TARGET_FIELDS, path);
    return { kind: "value", pointer: expectNonEmptyString(row.pointer, `${path}/pointer`) };
  }
  throw fail(BLUEPRINT_CODE.INVALID_FIELD, "binding target kind must be value or default-model", `${path}/kind`);
}

function parseRelations(value: unknown): BlueprintRelation[] {
  return expectArray(value, "/relations").map((item, index) => {
    const path = `/relations/${index}`;
    const row = expectObject(item, path);
    assertClosed(row, RELATION_FIELDS, path);
    const from = expectNpmPackageName(row.from, `${path}/from`);
    const to = expectNpmPackageName(row.to, `${path}/to`);
    if (from === to) {
      throw fail(BLUEPRINT_CODE.INVALID_FIELD, "relation from and to must be different packages", path);
    }
    const relation: BlueprintRelation = {
      type: expectEnum(row.type, RELATION_TYPE_SET, `${path}/type`) as BlueprintRelationType,
      from,
      to,
      reason: expectNonEmptyString(row.reason, `${path}/reason`),
    };
    if (row.fromVersion !== undefined) {
      relation.fromVersion = expectSemverRange(row.fromVersion, `${path}/fromVersion`);
    }
    if (row.toVersion !== undefined) {
      relation.toVersion = expectSemverRange(row.toVersion, `${path}/toVersion`);
    }
    return relation;
  });
}

function parseTestedWith(value: unknown): BlueprintTestedWith[] {
  return expectArray(value, "/testedWith").map((item, index) => {
    const path = `/testedWith/${index}`;
    const row = expectObject(item, path);
    assertClosed(row, TESTED_FIELDS, path);
    const checks = uniqueEnumArray(row.checks, CHECK_SET, `${path}/checks`) as BlueprintTestCheck[];
    if (checks.length === 0) {
      throw fail(BLUEPRINT_CODE.INVALID_FIELD, "testedWith.checks must not be empty", `${path}/checks`);
    }
    const record: BlueprintTestedWith = {
      dsh: expectExactSemver(row.dsh, `${path}/dsh`),
      spaces: expectExactSemver(row.spaces, `${path}/spaces`),
      node: expectExactSemver(row.node, `${path}/node`),
      os: expectEnum(row.os, OS_SET, `${path}/os`) as BlueprintOs,
      arch: expectEnum(row.arch, ARCH_SET, `${path}/arch`) as BlueprintArch,
      checkedAt: expectRfc3339(row.checkedAt, `${path}/checkedAt`),
      checks,
    };
    if (row.evidence !== undefined) record.evidence = expectHttpsUrl(row.evidence, `${path}/evidence`);
    return record;
  });
}

function parseExtensions(value: unknown): BlueprintJsonObject {
  return expectJsonObject(value, "/extensions");
}

function assertInputsAndBindings(blueprint: Blueprint): void {
  const inputs = new Map(blueprint.inputs.map((input) => [input.id, input]));
  const used = new Set<string>();
  let defaultModel: string | undefined;
  const valuePointers: string[][] = [];
  const configZones = collectConfigZones(blueprint.profile.patch);
  const settingsRoot = "/profile/settings";

  for (const [index, binding] of blueprint.bindings.entries()) {
    const path = `/bindings/${index}`;
    const input = inputs.get(binding.input);
    if (!input) {
      throw fail(BLUEPRINT_CODE.BINDING, `binding references missing input ${binding.input}`, `${path}/input`);
    }
    used.add(input.id);
    if (binding.target.kind === "default-model") {
      if (input.type !== "model") {
        throw fail(BLUEPRINT_CODE.BINDING, "only model inputs can use default-model", path);
      }
      if (defaultModel) {
        throw fail(BLUEPRINT_CODE.BINDING, "at most one default-model binding is allowed", path);
      }
      defaultModel = input.id;
      continue;
    }
    if (input.type === "model") {
      throw fail(BLUEPRINT_CODE.BINDING, "model inputs can only bind to default-model", path);
    }
    const tokens = parseJsonPointer(binding.target.pointer, `${path}/target/pointer`);
    const pointer = formatJsonPointer(tokens);
    assertValuePointerAllowed(pointer, configZones, settingsRoot, `${path}/target/pointer`);
    getPointer(blueprint as unknown as BlueprintJson, tokens, `${path}/target/pointer`);
    valuePointers.push(tokens);
  }
  assertNoPointerOverlap(valuePointers);
  for (const [index, binding] of blueprint.bindings.entries()) {
    if (binding.target.kind !== "value") continue;
    const path = `/bindings/${index}`;
    const input = inputs.get(binding.input)!;
    const tokens = parseJsonPointer(binding.target.pointer, `${path}/target/pointer`);
    const resolved = getPointer(blueprint as unknown as BlueprintJson, tokens, `${path}/target/pointer`);
    if (resolved.value !== null) {
      throw fail(BLUEPRINT_CODE.POINTER, "value binding targets must be a null placeholder", `${path}/target/pointer`);
    }
    if (Array.isArray(resolved.parent) && !input.required) {
      throw fail(
        BLUEPRINT_CODE.BINDING,
        "optional inputs cannot bind array elements",
        `${path}/target/pointer`,
      );
    }
  }

  for (const input of blueprint.inputs) {
    if (!used.has(input.id)) {
      throw fail(BLUEPRINT_CODE.BINDING, `input ${input.id} is not used by any binding`, inputPath(input.id));
    }
  }
}

function assertValuePointerAllowed(
  pointer: string,
  configZones: ConfigZone[],
  settingsRoot: string,
  path: string,
): void {
  if (pointer === settingsRoot) {
    throw fail(BLUEPRINT_CODE.POINTER, "cannot bind the entire settings object", path);
  }
  if (pointer.startsWith(`${settingsRoot}/`)) return;
  const zone = configZones.find((item) => pointer === item.pointer || pointer.startsWith(`${item.pointer}/`));
  if (!zone) {
    throw fail(
      BLUEPRINT_CODE.POINTER,
      "value pointers must target /profile/settings or an official patch config value",
      path,
    );
  }
  if (pointer === zone.pointer) {
    throw fail(BLUEPRINT_CODE.POINTER, "cannot bind an entire config object", path);
  }
  if (zone.managed) {
    throw fail(BLUEPRINT_CODE.POINTER, "cannot bind managed isolation or control fields", path);
  }
}

function assertNoPointerOverlap(pointers: string[][]): void {
  const formatted = pointers.map((tokens) => formatJsonPointer(tokens));
  const seen = new Set<string>();
  for (const pointer of formatted) {
    if (seen.has(pointer)) {
      throw fail(BLUEPRINT_CODE.BINDING, `duplicate binding target ${pointer}`);
    }
    seen.add(pointer);
  }
  for (let i = 0; i < formatted.length; i++) {
    for (let j = i + 1; j < formatted.length; j++) {
      const a = formatted[i]!;
      const b = formatted[j]!;
      if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        throw fail(BLUEPRINT_CODE.BINDING, `overlapping binding targets ${a} and ${b}`);
      }
    }
  }
}

function assertRelations(relations: BlueprintRelation[], selected: Map<string, BlueprintPackage>): void {
  for (const [index, relation] of relations.entries()) {
    if (!selected.has(relation.from)) {
      throw fail(
        BLUEPRINT_CODE.INVALID_FIELD,
        `relation.from ${relation.from} must be a selected package`,
        `/relations/${index}/from`,
      );
    }
  }
}

interface ConfigZone {
  pointer: string;
  managed: boolean;
}

function collectConfigZones(patch: BlueprintPatch): ConfigZone[] {
  const zones: ConfigZone[] = [];
  const walkEntry = (entry: BlueprintPatchEntry, pointer: string): void => {
    const managed = MANAGED_ENTRY_SET.has(entry.id);
    if (entry.group === true) {
      const children = groupChildEntries(entry.config);
      if (children) {
        for (const [index, child] of children.entries()) {
          walkEntry(child, `${pointer}/config/${index}`);
        }
      }
      return;
    }
    if (entry.config === undefined || entry.config === null || typeof entry.config !== "object") {
      return;
    }
    zones.push({ pointer: `${pointer}/config`, managed });
  };
  for (const [index, item] of patch.entries()) {
    const pointer = `/profile/patch/${index}`;
    if (isInsertOp(item)) {
      for (const [insertIndex, entry] of item.insert.entries()) {
        walkEntry(entry, `${pointer}/insert/${insertIndex}`);
      }
    } else {
      walkEntry(item, pointer);
    }
  }
  return zones;
}

function resolveInputValue(
  input: BlueprintInput,
  values: BlueprintInputValues,
):
  | { status: "missing" }
  | { status: "value"; value: string | number | boolean }
  | { status: "model"; value: BlueprintModelRef } {
  if (Object.hasOwn(values, input.id)) {
    return interpretProvided(input, values[input.id]);
  }
  if (input.default !== undefined) {
    return { status: "value", value: input.default };
  }
  return { status: "missing" };
}

function interpretProvided(
  input: BlueprintInput,
  value: BlueprintInputValue,
):
  | { status: "value"; value: string | number | boolean }
  | { status: "model"; value: BlueprintModelRef } {
  const path = inputPath(input.id);
  if (input.type === "model") {
    if (!isModelRef(value)) {
      throw fail(BLUEPRINT_CODE.INPUT_TYPE, `input ${input.id} requires a model {connectionId, modelId}`, path);
    }
    if (hasUnpairedSurrogate(value.connectionId) || hasUnpairedSurrogate(value.modelId)) {
      throw fail(BLUEPRINT_CODE.SURROGATE, `input ${input.id} contains an unpaired Unicode surrogate`, path);
    }
    return { status: "model", value: { connectionId: value.connectionId, modelId: value.modelId } };
  }
  if (isModelRef(value)) {
    throw fail(BLUEPRINT_CODE.INPUT_TYPE, `input ${input.id} does not take a model value`, path);
  }
  if (input.type === "string" || input.type === "directory") {
    if (typeof value !== "string") {
      throw fail(BLUEPRINT_CODE.INPUT_TYPE, `input ${input.id} requires a string`, path);
    }
    if (hasUnpairedSurrogate(value)) {
      throw fail(BLUEPRINT_CODE.SURROGATE, `input ${input.id} contains an unpaired Unicode surrogate`, path);
    }
    if (input.type === "directory" && value.length === 0) {
      throw fail(BLUEPRINT_CODE.INPUT_TYPE, `input ${input.id} directory must be non-empty`, path);
    }
    return { status: "value", value };
  }
  if (input.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw fail(BLUEPRINT_CODE.INPUT_TYPE, `input ${input.id} requires a finite number`, path);
    }
    return { status: "value", value: normalizeNumber(value) };
  }
  if (typeof value !== "boolean") {
    throw fail(BLUEPRINT_CODE.INPUT_TYPE, `input ${input.id} requires a boolean`, path);
  }
  return { status: "value", value };
}

function missingInput(id: string): BlueprintError {
  return fail(BLUEPRINT_CODE.INPUT_REQUIRED, `required input ${id} is missing`, inputPath(id));
}

function diagnoseRequirements(
  blueprint: Blueprint,
  environment: BlueprintEnvironment | undefined,
  diagnostics: BlueprintDiagnostic[],
): void {
  const requirements = blueprint.requirements;
  if (!requirements) return;
  checkHostRange("dsh", requirements.dsh, environment?.dsh, "/requirements/dsh", diagnostics);
  checkHostRange("spaces", requirements.spaces, environment?.spaces, "/requirements/spaces", diagnostics);
  checkHostRange("node", requirements.node, environment?.node, "/requirements/node", diagnostics);
  if (requirements.os) {
    if (!environment?.os) {
      diagnostics.push({
        code: "blueprint.requirement.os.unknown",
        message: "author declared OS requirements; receiver OS is unknown",
        severity: "info",
        path: "/requirements/os",
      });
    } else if (!requirements.os.includes(environment.os)) {
      diagnostics.push({
        code: "blueprint.requirement.os",
        message: `receiver OS ${environment.os} is outside ${requirements.os.join(", ")}`,
        severity: "error",
        path: "/requirements/os",
      });
    }
  }
  if (requirements.arch) {
    if (!environment?.arch) {
      diagnostics.push({
        code: "blueprint.requirement.arch.unknown",
        message: "author declared architecture requirements; receiver architecture is unknown",
        severity: "info",
        path: "/requirements/arch",
      });
    } else if (!requirements.arch.includes(environment.arch)) {
      diagnostics.push({
        code: "blueprint.requirement.arch",
        message: `receiver architecture ${environment.arch} is outside ${requirements.arch.join(", ")}`,
        severity: "error",
        path: "/requirements/arch",
      });
    }
  }
}

function checkHostRange(
  name: string,
  range: string | undefined,
  actual: string | undefined,
  path: string,
  diagnostics: BlueprintDiagnostic[],
): void {
  if (!range) return;
  if (!actual) {
    diagnostics.push({
      code: `blueprint.requirement.${name}.unknown`,
      message: `author declared a ${name} range; receiver ${name} version is unknown`,
      severity: "info",
      path,
    });
    return;
  }
  if (!semverSatisfies(actual, range, { includePrerelease: false })) {
    diagnostics.push({
      code: `blueprint.requirement.${name}`,
      message: `receiver ${name} ${actual} does not satisfy ${range}`,
      severity: "error",
      path,
    });
  }
}

function diagnoseTestedWith(blueprint: Blueprint, diagnostics: BlueprintDiagnostic[]): void {
  if (!blueprint.testedWith || blueprint.testedWith.length === 0) {
    diagnostics.push({
      code: "blueprint.testedWith.absent",
      message: "author did not report verification records; this is not a Spaces certification",
      severity: "info",
      path: "/testedWith",
    });
  }
}

function diagnosePackages(blueprint: Blueprint, diagnostics: BlueprintDiagnostic[]): void {
  for (const [index, pkg] of blueprint.packages.entries()) {
    if (!pkg.integrity && pkg.source.type === "npm") {
      diagnostics.push({
        code: "blueprint.integrity.unlocked",
        message: `package ${pkg.name}@${pkg.version} does not lock an artifact digest`,
        severity: "info",
        path: `/packages/${index}`,
      });
    }
    if (pkg.source.type === "github") {
      diagnostics.push({
        code: "blueprint.source.github",
        message: `GitHub source for ${pkg.name} is optional; unsupported receivers must not substitute npm`,
        severity: "warning",
        path: `/packages/${index}/source`,
      });
    }
  }
}

function diagnosePatchNames(blueprint: Blueprint, diagnostics: BlueprintDiagnostic[]): void {
  const selected = new Set(blueprint.packages.map((pkg) => pkg.name));
  const walk = (entry: BlueprintPatchEntry, path: string): void => {
    if (entry.name && !entry.name.startsWith("cordis:")) {
      const pkg = packageNameOfModule(entry.name);
      if (pkg && !selected.has(pkg) && !HOST_PACKAGE_SET.has(pkg)) {
        diagnostics.push({
          code: "blueprint.patch.module",
          message: `patch module ${entry.name} is not a selected package; dependency resolution is pending`,
          severity: "warning",
          path: `${path}/name`,
        });
      }
    } else if (entry.name?.startsWith("cordis:")) {
      diagnostics.push({
        code: "blueprint.patch.builtin",
        message: `patch module ${entry.name} is a host loader builtin; runtime support is not implied`,
        severity: "info",
        path: `${path}/name`,
      });
    }
    const children = entry.group === true ? groupChildEntries(entry.config) : undefined;
    if (children) {
      for (const [index, child] of children.entries()) {
        walk(child, `${path}/config/${index}`);
      }
    }
  };
  for (const [index, item] of blueprint.profile.patch.entries()) {
    const path = `/profile/patch/${index}`;
    if (isInsertOp(item)) {
      for (const [insertIndex, entry] of item.insert.entries()) walk(entry, `${path}/insert/${insertIndex}`);
    } else {
      walk(item, path);
    }
  }
}

function diagnosePatchApply(blueprint: Blueprint, diagnostics: BlueprintDiagnostic[]): void {
  type Sim = { id: string; group: boolean; name?: string; children: Sim[] };
  const root: Sim[] = [];
  const index = new Map<string, Sim>();

  const indexEntry = (entry: Sim): void => {
    index.set(entry.id, entry);
    for (const child of entry.children) indexEntry(child);
  };

  const toSim = (entry: BlueprintPatchEntry): Sim => {
    const nested = entry.group === true ? groupChildEntries(entry.config) : undefined;
    return {
      id: entry.id,
      group: entry.group === true,
      name: entry.name,
      children: nested ? nested.map(toSim) : [],
    };
  };

  const addSiblings = (entries: BlueprintPatchEntry[], siblings: Sim[], path: string): void => {
    const seen = new Set(siblings.map((row) => row.id));
    for (const [offset, entry] of entries.entries()) {
      if (seen.has(entry.id)) {
        diagnostics.push({
          code: "blueprint.patch.entry.duplicate",
          message: `duplicate inserted id ${entry.id} in the same scope; later composition must use actual parent evidence`,
          severity: "warning",
          path: `${path}/${offset}/id`,
        });
      }
      seen.add(entry.id);
      const sim = toSim(entry);
      siblings.push(sim);
      indexEntry(sim);
    }
  };

  for (const [indexItem, item] of blueprint.profile.patch.entries()) {
    const path = `/profile/patch/${indexItem}`;
    if (isInsertOp(item)) {
      if (item.id) {
        const target = index.get(item.id);
        if (!target) {
          diagnostics.push({
            code: "blueprint.patch.target.unresolved",
            message: `insert target ${item.id} is not an explicit group in this patch list; actual composition must resolve it`,
            severity: "info",
            path: `${path}/id`,
          });
        } else if (!target.group) {
          diagnostics.push({
            code: "blueprint.patch.insert-target.not-group",
            message: `insert target ${item.id} is not a group in this patch list`,
            severity: "error",
            path: `${path}/id`,
          });
        } else {
          addSiblings(item.insert, target.children, `${path}/insert`);
        }
      } else {
        addSiblings(item.insert, root, `${path}/insert`);
      }
    } else {
      const target = index.get(item.id);
      if (!target) {
        diagnostics.push({
          code: "blueprint.patch.target.unresolved",
          message: `overlay ${item.id} is not inserted in this patch list; actual composition must resolve it`,
          severity: "info",
          path: `${path}/id`,
        });
      } else {
        if (item.name !== undefined && target.name !== undefined && item.name !== target.name) {
          diagnostics.push({
            code: "blueprint.patch.name-mismatch",
            message: `overlay name for ${item.id} is a match guard, not a replacement; backend must skip on mismatch`,
            severity: "info",
            path: `${path}/name`,
          });
        }
        if (item.group === true) target.group = true;
        if (item.group === false) target.group = false;
        const overlayChildren = item.group === true ? groupChildEntries(item.config) : undefined;
        if (overlayChildren) {
          target.children = [];
          addSiblings(overlayChildren, target.children, `${path}/config`);
        }
      }
    }
  }
}

interface PackageState {
  name: string;
  selected: boolean;
  selectedVersion?: string;
  installed: boolean;
  installedVersion?: string;
  bundled: boolean;
  active: boolean;
}

function diagnoseRelations(
  blueprint: Blueprint,
  environment: BlueprintEnvironment | undefined,
  diagnostics: BlueprintDiagnostic[],
): void {
  const states = packageStates(blueprint, environment);
  for (const [index, relation] of blueprint.relations.entries()) {
    const path = `/relations/${index}`;
    const from = states.get(relation.from) ?? emptyState(relation.from);
    if (relation.fromVersion) {
      if (!from.selectedVersion) continue;
      if (!semverSatisfies(from.selectedVersion, relation.fromVersion, { includePrerelease: false })) continue;
    }
    if (relation.type === "after" && relation.toVersion && from.selectedVersion) {
      const to = states.get(relation.to) ?? emptyState(relation.to);
      const toVersion = versionForRange(to);
      if (toVersion && !semverSatisfies(toVersion, relation.toVersion, { includePrerelease: false })) continue;
    }
    if (relation.type === "requires") diagnoseRequires(relation, path, states, diagnostics);
    else if (relation.type === "conflicts") diagnoseConflicts(relation, path, states, diagnostics);
    else if (relation.type === "integrates") diagnoseIntegrates(relation, path, states, diagnostics);
    else diagnoseAfter(relation, path, blueprint.profile.bundles, states, diagnostics);
  }
  diagnoseRequiresCycles(blueprint, states, diagnostics);
}

function diagnoseRequiresCycles(
  blueprint: Blueprint,
  states: Map<string, PackageState>,
  diagnostics: BlueprintDiagnostic[],
): void {
  const graph = new Map<string, string[]>();
  for (const relation of blueprint.relations) {
    if (relation.type !== "requires") continue;
    const from = states.get(relation.from);
    if (!from?.selectedVersion) continue;
    if (relation.fromVersion && !semverSatisfies(from.selectedVersion, relation.fromVersion, { includePrerelease: false })) {
      continue;
    }
    const to = states.get(relation.to);
    if (!to?.selected) continue;
    const list = graph.get(relation.from) ?? [];
    list.push(relation.to);
    graph.set(relation.from, list);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visitNode = (name: string, stack: string[]): boolean => {
    if (visited.has(name)) return false;
    if (visiting.has(name)) {
      diagnostics.push({
        code: "blueprint.relation.requires.cycle",
        message: `requires cycle ${[...stack, name].join(" -> ")}; the blueprint is not rewritten`,
        severity: "warning",
      });
      return true;
    }
    visiting.add(name);
    for (const next of graph.get(name) ?? []) {
      if (visitNode(next, [...stack, name])) return true;
    }
    visiting.delete(name);
    visited.add(name);
    return false;
  };
  for (const name of graph.keys()) visitNode(name, []);
}

function diagnoseRequires(
  relation: BlueprintRelation,
  path: string,
  states: Map<string, PackageState>,
  diagnostics: BlueprintDiagnostic[],
): void {
  const to = states.get(relation.to) ?? emptyState(relation.to);
  const host = HOST_PACKAGE_SET.has(relation.to);
  if (!to.selected && !host) {
    diagnostics.push({
      code: "blueprint.relation.requires.unselected",
      message: `${relation.from} requires ${relation.to}, which is not selected by this blueprint${evidenceSuffix(to)}`,
      severity: "error",
      path,
    });
  } else if (!host && !to.bundled) {
    diagnostics.push({
      code: "blueprint.relation.requires.inactive",
      message: `${relation.from} requires ${relation.to} in the composition, but it is not in profile.bundles`,
      severity: "error",
      path,
    });
  }
  diagnoseTargetVersion(relation, path, to, "requires", diagnostics);
  if (!to.active) {
    diagnostics.push({
      code: "blueprint.package.inactive-unknown",
      message: `no runtime evidence that ${relation.to} is active; bundled does not prove every plugin is running`,
      severity: "warning",
      path,
    });
  }
}

function diagnoseConflicts(
  relation: BlueprintRelation,
  path: string,
  states: Map<string, PackageState>,
  diagnostics: BlueprintDiagnostic[],
): void {
  const from = states.get(relation.from) ?? emptyState(relation.from);
  const to = states.get(relation.to) ?? emptyState(relation.to);
  const fromIn = from.bundled || (HOST_PACKAGE_SET.has(relation.from) && from.installed);
  const toSelected = to.selected || HOST_PACKAGE_SET.has(relation.to);
  if (!toSelected && !to.installed && !to.bundled && !to.active) {
    diagnostics.push({
      code: "blueprint.relation.conflicts.unselected",
      message: `${relation.from} declares a conflict with ${relation.to}, which is not selected by this blueprint; existence is unknown`,
      severity: "info",
      path,
    });
    return;
  }
  const toIn = to.bundled || (HOST_PACKAGE_SET.has(relation.to) && to.installed);
  if (!fromIn || !toIn) {
    diagnostics.push({
      code: "blueprint.relation.conflicts.not-current",
      message: `conflict between ${relation.from} and ${relation.to} is declared, but both are not in the current composition`,
      severity: "info",
      path,
    });
    diagnoseUnknownConflictVersion(relation, path, to, diagnostics);
    return;
  }
  const versionIssue = targetVersionIssue(relation, to);
  if (versionIssue === "unknown") {
    diagnostics.push({
      code: "blueprint.package.version-unknown",
      message: `conflict with ${relation.to} cannot be ruled out because its version is unknown`,
      severity: "warning",
      path,
    });
    return;
  }
  if (versionIssue === "miss") return;
  diagnostics.push({
    code: "blueprint.relation.conflicts",
    message: `${relation.from} conflicts with ${relation.to}${relation.toVersion ? ` @${relation.toVersion}` : ""}: ${relation.reason}`,
    severity: "error",
    path,
  });
}

function diagnoseIntegrates(
  relation: BlueprintRelation,
  path: string,
  states: Map<string, PackageState>,
  diagnostics: BlueprintDiagnostic[],
): void {
  const to = states.get(relation.to) ?? emptyState(relation.to);
  if (!to.selected && !to.installed && !to.bundled && !HOST_PACKAGE_SET.has(relation.to)) {
    diagnostics.push({
      code: "blueprint.relation.integrates.absent",
      message: `${relation.from} can integrate with ${relation.to} when present; it is not selected and there is no evidence it exists`,
      severity: "info",
      path,
    });
    return;
  }
  const versionIssue = targetVersionIssue(relation, to);
  if (versionIssue === "unknown") {
    diagnostics.push({
      code: "blueprint.package.version-unknown",
      message: `integration with ${relation.to} is version-unknown`,
      severity: "info",
      path,
    });
    return;
  }
  if (versionIssue === "miss") return;
  diagnostics.push({
    code: "blueprint.relation.integrates",
    message: `${relation.from} may integrate with ${relation.to}; presence does not enable the integration automatically`,
    severity: "info",
    path,
  });
}

function diagnoseAfter(
  relation: BlueprintRelation,
  path: string,
  bundles: string[],
  states: Map<string, PackageState>,
  diagnostics: BlueprintDiagnostic[],
): void {
  const fromIndex = bundles.indexOf(relation.from);
  const toIndex = bundles.indexOf(relation.to);
  if (fromIndex < 0 || toIndex < 0) {
    diagnostics.push({
      code: "blueprint.relation.after.inapplicable",
      message: `order ${relation.from} after ${relation.to} does not apply because both are not in profile.bundles`,
      severity: "info",
      path,
    });
    return;
  }
  const to = states.get(relation.to) ?? emptyState(relation.to);
  if (relation.toVersion) {
    const version = versionForRange(to);
    if (!version) {
      diagnostics.push({
        code: "blueprint.package.version-unknown",
        message: `order relative to ${relation.to} is version-unknown`,
        severity: "warning",
        path,
      });
      return;
    }
    if (!semverSatisfies(version, relation.toVersion, { includePrerelease: false })) return;
  }
  if (fromIndex < toIndex) {
    diagnostics.push({
      code: "blueprint.relation.after",
      message: `${relation.from} should be after ${relation.to} in profile.bundles; the list is not reordered`,
      severity: "error",
      path,
    });
  }
}

function diagnoseTargetVersion(
  relation: BlueprintRelation,
  path: string,
  to: PackageState,
  kind: string,
  diagnostics: BlueprintDiagnostic[],
): void {
  const issue = targetVersionIssue(relation, to);
  if (issue === "unknown") {
    diagnostics.push({
      code: "blueprint.package.version-unknown",
      message: `${kind} target ${relation.to} version is unknown; this is not treated as compatible`,
      severity: "warning",
      path,
    });
  } else if (issue === "miss") {
    diagnostics.push({
      code: `blueprint.relation.${kind}.version`,
      message: `${relation.to} ${versionForRange(to)} does not satisfy ${relation.toVersion}`,
      severity: "error",
      path,
    });
  }
}

function diagnoseUnknownConflictVersion(
  relation: BlueprintRelation,
  path: string,
  to: PackageState,
  diagnostics: BlueprintDiagnostic[],
): void {
  if (relation.toVersion && !versionForRange(to)) {
    diagnostics.push({
      code: "blueprint.package.version-unknown",
      message: `conflict with ${relation.to} is version-unknown`,
      severity: "warning",
      path,
    });
  }
}

function targetVersionIssue(relation: BlueprintRelation, to: PackageState): "ok" | "miss" | "unknown" | "skip" {
  if (!relation.toVersion) return "ok";
  const version = versionForRange(to);
  if (!version) return "unknown";
  return semverSatisfies(version, relation.toVersion, { includePrerelease: false }) ? "ok" : "miss";
}

function versionForRange(state: PackageState): string | undefined {
  return state.selectedVersion ?? state.installedVersion;
}

function evidenceSuffix(state: PackageState): string {
  if (state.installed) return "; a same-named install is not treated as satisfying a runtime requirement";
  if (!state.installed && !state.active) return "; existence is unknown";
  return "";
}

function packageStates(blueprint: Blueprint, environment?: BlueprintEnvironment): Map<string, PackageState> {
  const states = new Map<string, PackageState>();
  const ensure = (name: string): PackageState => {
    const existing = states.get(name);
    if (existing) return existing;
    const created = emptyState(name);
    states.set(name, created);
    return created;
  };
  for (const pkg of blueprint.packages) {
    const state = ensure(pkg.name);
    state.selected = true;
    state.selectedVersion = pkg.version;
  }
  for (const name of blueprint.profile.bundles) {
    ensure(name).bundled = true;
  }
  for (const row of environment?.packages ?? []) {
    if (!row || typeof row.name !== "string") continue;
    const state = ensure(row.name);
    if (row.installed) state.installed = true;
    if (row.active) state.active = true;
    if (row.bundled) {
      // Receiver evidence of an installed/running space; do not treat as this blueprint's composition.
    }
    if (typeof row.version === "string" && row.version) {
      if (!state.selectedVersion) state.installedVersion = row.version;
      else if (row.installed) state.installedVersion = row.version;
    }
  }
  return states;
}

function emptyState(name: string): PackageState {
  return { name, selected: false, installed: false, bundled: false, active: false };
}

function expectDefault(value: unknown, type: BlueprintInputType, path: string): string | number | boolean {
  if (type === "string") return expectString(value, path);
  if (type === "number") {
    if (typeof value !== "number") throw fail(BLUEPRINT_CODE.INVALID_FIELD, "default must be a number", path);
    return normalizeNumber(value, path);
  }
  if (typeof value !== "boolean") throw fail(BLUEPRINT_CODE.INVALID_FIELD, "default must be a boolean", path);
  return value;
}

function expectModuleName(value: unknown, path: string): string {
  const name = expectNonEmptyString(value, path);
  const lower = name.toLowerCase();
  const scheme = lower.match(/^([a-z][a-z0-9+.-]*):/);
  if (scheme && scheme[1] !== "cordis") {
    throw fail(BLUEPRINT_CODE.DYNAMIC, "patch modules cannot use unsupported specifiers or URLs", path);
  }
  if (name.startsWith(".") || name.startsWith("/") || name.includes("\\") || /^[A-Za-z]:[\\/]/.test(name)) {
    throw fail(BLUEPRINT_CODE.DYNAMIC, "patch modules cannot be filesystem paths", path);
  }
  if (/[\s;|&$`<>()]/.test(name) || name.includes("\0")) {
    throw fail(BLUEPRINT_CODE.DYNAMIC, "patch modules cannot contain command metacharacters", path);
  }
  if (name.startsWith("cordis:")) {
    const builtin = name.slice("cordis:".length);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(builtin)) {
      throw fail(BLUEPRINT_CODE.DYNAMIC, "cordis builtin module names cannot contain path segments", path);
    }
    return name;
  }
  const pkg = packageNameOfModule(name);
  if (!pkg || !isNpmPackageName(pkg)) {
    throw fail(BLUEPRINT_CODE.INVALID_FIELD, "patch module must be a package name or package subpath", path);
  }
  if (name.length > pkg.length) {
    if (!name.startsWith(`${pkg}/`)) {
      throw fail(BLUEPRINT_CODE.INVALID_FIELD, "patch module must be a package name or package subpath", path);
    }
    const segments = name.slice(pkg.length + 1).split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw fail(BLUEPRINT_CODE.DYNAMIC, "patch module subpaths cannot contain empty, '.', or '..' segments", path);
    }
  }
  return name;
}

function packageNameOfModule(name: string): string | undefined {
  if (name.startsWith("@")) {
    const parts = name.split("/");
    if (parts.length < 2) return undefined;
    return `${parts[0]}/${parts[1]}`;
  }
  return name.split("/")[0];
}

function assertUserPackage(name: string, path: string): void {
  if (HOST_PACKAGE_SET.has(name)) {
    throw fail(
      BLUEPRINT_CODE.INVALID_FIELD,
      `${name} is provided by the host and cannot appear in packages or bundles`,
      path,
    );
  }
  if (CONTROL_PACKAGE_SET.has(name)) {
    throw fail(
      BLUEPRINT_CODE.INVALID_FIELD,
      `${name} is a Spaces control component and cannot be distributed as a user plugin`,
      path,
    );
  }
}

function assertNoJsExpr(value: BlueprintJson, path: string): void {
  if (value === null || typeof value !== "object") return;
  if (isPlainObject(value) && ownStringKeys(value).includes("__jsExpr")) {
    throw fail(BLUEPRINT_CODE.DYNAMIC, "blueprint JSON cannot carry loader !!js expressions", path);
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertNoJsExpr(item, `${path}/${index}`);
    return;
  }
  for (const key of ownStringKeys(value)) {
    assertNoJsExpr(value[key] as BlueprintJson, `${path}/${jsonPointerToken(key)}`);
  }
}

function parseJsonPointer(pointer: string, path: string): string[] {
  if (!pointer.startsWith("/") || pointer.length < 2) {
    throw fail(BLUEPRINT_CODE.POINTER, "JSON Pointer must be a non-empty RFC 6901 pointer", path);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((token) => decodePointerToken(token, path));
}

function decodePointerToken(token: string, path: string): string {
  let decoded = "";
  for (let index = 0; index < token.length; index++) {
    const ch = token[index]!;
    if (ch !== "~") {
      decoded += ch;
      continue;
    }
    const next = token[index + 1];
    if (next === "0") {
      decoded += "~";
      index += 1;
    } else if (next === "1") {
      decoded += "/";
      index += 1;
    } else {
      throw fail(BLUEPRINT_CODE.POINTER, "JSON Pointer ~ must be followed by 0 or 1", path);
    }
  }
  return decoded;
}

function formatJsonPointer(tokens: string[]): string {
  return `/${tokens.map(jsonPointerToken).join("/")}`;
}

function jsonPointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function getPointer(
  root: BlueprintJson,
  tokens: string[],
  path: string,
): { parent: BlueprintJson; key: string; value: BlueprintJson } {
  let current: BlueprintJson = root;
  let parent: BlueprintJson = root;
  let key = "";
  for (const token of tokens) {
    parent = current;
    key = token;
    current = stepPointer(current, token, path);
  }
  return { parent, key, value: current };
}

function stepPointer(current: BlueprintJson, token: string, path: string): BlueprintJson {
  if (Array.isArray(current)) {
    if (token === "-") throw fail(BLUEPRINT_CODE.POINTER, "JSON Pointer append '-' is not allowed", path);
    if (!/^(0|[1-9][0-9]*)$/.test(token)) {
      throw fail(BLUEPRINT_CODE.POINTER, "array index must be a canonical RFC 6901 index", path);
    }
    const index = Number(token);
    if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) {
      throw fail(BLUEPRINT_CODE.POINTER, "JSON Pointer does not refer to an existing array index", path);
    }
    return current[index] as BlueprintJson;
  }
  if (!isPlainObject(current) || !Object.hasOwn(current, token)) {
    throw fail(BLUEPRINT_CODE.POINTER, "JSON Pointer does not refer to an existing location", path);
  }
  return current[token] as BlueprintJson;
}

function setPointer(root: BlueprintJsonObject, pointer: string, value: BlueprintJson): void {
  const tokens = parseJsonPointer(pointer, pointer);
  const last = tokens.pop();
  if (last === undefined) throw fail(BLUEPRINT_CODE.POINTER, "cannot replace the document root", pointer);
  let current: BlueprintJson = root;
  for (const token of tokens) current = stepPointer(current, token, pointer);
  writeChild(current, last, value, pointer);
}

function deletePointer(root: BlueprintJsonObject, pointer: string): void {
  const tokens = parseJsonPointer(pointer, pointer);
  const last = tokens.pop();
  if (last === undefined) throw fail(BLUEPRINT_CODE.POINTER, "cannot delete the document root", pointer);
  let current: BlueprintJson = root;
  for (const token of tokens) current = stepPointer(current, token, pointer);
  if (Array.isArray(current)) {
    throw fail(BLUEPRINT_CODE.BINDING, "optional bindings cannot remove array elements", pointer);
  }
  if (!isPlainObject(current) || !Object.hasOwn(current, last)) {
    throw fail(BLUEPRINT_CODE.POINTER, "JSON Pointer does not refer to an existing location", pointer);
  }
  delete current[last];
}

function writeChild(parent: BlueprintJson, key: string, value: BlueprintJson, path: string): void {
  if (Array.isArray(parent)) {
    if (!/^(0|[1-9][0-9]*)$/.test(key)) {
      throw fail(BLUEPRINT_CODE.POINTER, "array index must be a canonical RFC 6901 index", path);
    }
    const index = Number(key);
    if (index < 0 || index >= parent.length) {
      throw fail(BLUEPRINT_CODE.POINTER, "JSON Pointer does not refer to an existing array index", path);
    }
    parent[index] = value;
    return;
  }
  if (!isPlainObject(parent) || !Object.hasOwn(parent, key)) {
    throw fail(BLUEPRINT_CODE.POINTER, "JSON Pointer does not refer to an existing location", path);
  }
  defineOwn(parent, key, value);
}

function reviveJson(value: unknown, depth: number, path: string): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && hasUnpairedSurrogate(value)) {
      throw fail(BLUEPRINT_CODE.SURROGATE, "JSON string contains an unpaired Unicode surrogate", path || undefined);
    }
    return value;
  }
  if (typeof value === "number") return normalizeNumber(value, path || undefined);
  if (Array.isArray(value)) {
    if (depth > BLUEPRINT_MAX_DEPTH) {
      throw fail(BLUEPRINT_CODE.DEPTH, `JSON nesting exceeds ${BLUEPRINT_MAX_DEPTH}`, path || undefined);
    }
    return value.map((item, index) => reviveJson(item, depth + 1, `${path}/${index}`));
  }
  if (!isPlainObject(value)) {
    throw fail(BLUEPRINT_CODE.INVALID_JSON, "JSON value is not representable", path || undefined);
  }
  if (depth > BLUEPRINT_MAX_DEPTH) {
    throw fail(BLUEPRINT_CODE.DEPTH, `JSON nesting exceeds ${BLUEPRINT_MAX_DEPTH}`, path || undefined);
  }
  const out: UnknownRecord = emptyObject();
  for (const key of ownStringKeys(value)) {
    if (hasUnpairedSurrogate(key)) {
      throw fail(BLUEPRINT_CODE.SURROGATE, "JSON object key contains an unpaired Unicode surrogate", path || undefined);
    }
    defineOwn(out, key, reviveJson(value[key], depth + 1, `${path}/${jsonPointerToken(key)}`));
  }
  return out;
}

function assertYamlJsonNumbers(doc: ReturnType<typeof parseDocument>): void {
  visit(doc, {
    Scalar(_key, node) {
      if (!isScalar(node) || typeof node.value !== "number") return;
      const source = typeof node.source === "string" ? node.source : undefined;
      normalizeNumber(node.value, undefined, source);
    },
  });
}

function normalizeNumber(value: number, path?: string, source?: string): number {
  if (!Number.isFinite(value)) {
    throw fail(BLUEPRINT_CODE.NUMBER, "numbers must be finite IEEE 754 binary64 values", path);
  }
  if (Object.is(value, -0) || source === "-0") return 0;
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw fail(
      BLUEPRINT_CODE.NUMBER,
      "integer values must be within [-9007199254740991, 9007199254740991]",
      path,
    );
  }
  if (source && INTEGER_TOKEN.test(source)) {
    try {
      if (BigInt(source) !== BigInt(value)) {
        throw fail(BLUEPRINT_CODE.NUMBER, "integer JSON tokens cannot be rounded to binary64", path);
      }
    } catch (error) {
      if (error instanceof BlueprintError) throw error;
      throw fail(BLUEPRINT_CODE.NUMBER, "integer JSON tokens cannot be rounded to binary64", path);
    }
  }
  return value;
}

function expectObject(value: unknown, path: string): UnknownRecord {
  if (!isPlainObject(value)) {
    throw fail(BLUEPRINT_CODE.INVALID_TYPE, "expected an object", path || undefined);
  }
  return value;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw fail(BLUEPRINT_CODE.INVALID_TYPE, "expected an array", path);
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") throw fail(BLUEPRINT_CODE.INVALID_TYPE, "expected a string", path);
  if (hasUnpairedSurrogate(value)) {
    throw fail(BLUEPRINT_CODE.SURROGATE, "string contains an unpaired Unicode surrogate", path);
  }
  return value;
}

function expectNonEmptyString(value: unknown, path: string): string {
  const text = expectString(value, path);
  if (text.length === 0) throw fail(BLUEPRINT_CODE.INVALID_FIELD, "string must be non-empty", path);
  return text;
}

function expectEnum(value: unknown, allowed: Set<string>, path: string): string {
  const text = expectNonEmptyString(value, path);
  if (!allowed.has(text)) throw fail(BLUEPRINT_CODE.INVALID_FIELD, `unsupported value ${text}`, path);
  return text;
}

function uniqueEnumArray(value: unknown, allowed: Set<string>, path: string): string[] {
  const rows = expectArray(value, path);
  if (rows.length === 0) throw fail(BLUEPRINT_CODE.INVALID_FIELD, "array must not be empty", path);
  const seen = new Set<string>();
  return rows.map((item, index) => {
    const text = expectEnum(item, allowed, `${path}/${index}`);
    if (seen.has(text)) throw fail(BLUEPRINT_CODE.INVALID_FIELD, `duplicate value ${text}`, `${path}/${index}`);
    seen.add(text);
    return text;
  });
}

function expectExactSemver(value: unknown, path: string): string {
  const text = expectNonEmptyString(value, path);
  if (text.startsWith("v") || text.startsWith("V")) {
    throw fail(BLUEPRINT_CODE.INVALID_FIELD, "exact SemVer cannot use a v prefix", path);
  }
  const parsed = parseSemVer(text, { loose: false });
  if (!parsed || parsed.raw !== text) {
    throw fail(BLUEPRINT_CODE.INVALID_FIELD, "expected an exact npm SemVer version", path);
  }
  return text;
}

function expectSemverRange(value: unknown, path: string): string {
  const text = expectNonEmptyString(value, path);
  const range = semverValidRange(text, { loose: false, includePrerelease: false });
  if (!range) throw fail(BLUEPRINT_CODE.INVALID_FIELD, "expected an npm SemVer range", path);
  return text;
}

function expectNpmPackageName(value: unknown, path: string): string {
  const text = expectNonEmptyString(value, path);
  if (!isNpmPackageName(text)) throw fail(BLUEPRINT_CODE.INVALID_FIELD, "expected a legal npm package name", path);
  return text;
}

function expectHttpsUrl(value: unknown, path: string): string {
  const text = expectNonEmptyString(value, path);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw fail(BLUEPRINT_CODE.INVALID_FIELD, "expected an HTTPS URL", path);
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    throw fail(BLUEPRINT_CODE.INVALID_FIELD, "expected an HTTPS URL without credentials", path);
  }
  return text;
}

function expectRfc3339(value: unknown, path: string): string {
  const text = expectNonEmptyString(value, path);
  if (!RFC3339.test(text) || !Number.isFinite(Date.parse(text))) {
    throw fail(BLUEPRINT_CODE.INVALID_FIELD, "expected RFC 3339 date-time with timezone", path);
  }
  return text;
}

function expectSha512Integrity(value: unknown, path: string): string {
  const text = expectNonEmptyString(value, path);
  if (!text.startsWith("sha512-")) {
    throw fail(BLUEPRINT_CODE.INVALID_FIELD, "integrity must be sha512-<standard Base64>", path);
  }
  const b64 = text.slice("sha512-".length);
  const bytes = decodeStdBase64(b64, path);
  if (bytes.length !== 64) {
    throw fail(BLUEPRINT_CODE.INVALID_FIELD, "sha512 integrity must decode to 64 bytes", path);
  }
  return text;
}

function expectJson(value: unknown, path: string): BlueprintJson {
  const revived = reviveJson(value, 1, path);
  assertNoJsExpr(revived as BlueprintJson, path);
  return revived as BlueprintJson;
}

function expectJsonObject(value: unknown, path: string): BlueprintJsonObject {
  const json = expectJson(value, path);
  if (!isPlainObject(json)) throw fail(BLUEPRINT_CODE.INVALID_TYPE, "expected a JSON object", path);
  return json;
}

function assertClosed(row: UnknownRecord, allowed: Set<string>, path: string): void {
  for (const key of ownStringKeys(row)) {
    if (!allowed.has(key)) {
      throw fail(
        BLUEPRINT_CODE.UNKNOWN_FIELD,
        `unknown field ${key}`,
        path ? `${path}/${jsonPointerToken(key)}` : `/${jsonPointerToken(key)}`,
      );
    }
  }
}

function isNpmPackageName(name: string): boolean {
  if (name.length === 0 || name.length > 214) return false;
  if (name !== name.toLowerCase() || name.trim() !== name) return false;
  if (name === "node_modules" || name === "favicon.ico") return false;
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    if (slash <= 1 || slash !== name.lastIndexOf("/")) return false;
    return isNpmNamePart(name.slice(1, slash)) && isNpmNamePart(name.slice(slash + 1));
  }
  return isNpmNamePart(name);
}

function isNpmNamePart(part: string): boolean {
  if (!part || part.startsWith(".") || part.startsWith("_")) return false;
  return /^[a-z0-9][a-z0-9._-]*$/.test(part) && encodeURIComponent(part) === part;
}

function decodeStdBase64(text: string, path: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw fail(BLUEPRINT_CODE.INVALID_FIELD, "integrity Base64 is not standard Base64", path);
  }
  const table = stdBase64Table();
  const last = table[text.charCodeAt(text.length - 1)]!;
  if (text.endsWith("==")) {
    if ((table[text.charCodeAt(text.length - 3)]! & 0x0f) !== 0) {
      throw fail(BLUEPRINT_CODE.INVALID_FIELD, "integrity Base64 leftover bits must be zero", path);
    }
  } else if (text.endsWith("=") && (last & 0x03) !== 0) {
    throw fail(BLUEPRINT_CODE.INVALID_FIELD, "integrity Base64 leftover bits must be zero", path);
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function stdBase64Table(): Uint8Array {
  const table = new Uint8Array(256).fill(255);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let index = 0; index < alphabet.length; index++) table[alphabet.charCodeAt(index)] = index;
  return table;
}

function isModelRef(value: unknown): value is BlueprintModelRef {
  if (!isPlainObject(value)) return false;
  const keys = ownStringKeys(value);
  if (keys.length !== 2 || !keys.includes("connectionId") || !keys.includes("modelId")) return false;
  return (
    typeof value.connectionId === "string" &&
    value.connectionId.length > 0 &&
    typeof value.modelId === "string" &&
    value.modelId.length > 0 &&
    !hasUnpairedSurrogate(value.connectionId) &&
    !hasUnpairedSurrogate(value.modelId)
  );
}

function isPlainObject(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ownStringKeys(value: object): string[] {
  return Reflect.ownKeys(value).filter((key): key is string => typeof key === "string");
}

function defineOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function emptyObject<T extends object>(): T {
  return Object.create(null) as T;
}

function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") return normalizeNumber(value) as T;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
  const out: UnknownRecord = emptyObject();
  for (const key of ownStringKeys(value)) defineOwn(out, key, cloneJson((value as UnknownRecord)[key]));
  return out as T;
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return "unsupported";
}

function inputPath(id: string): string {
  return `/inputs/${jsonPointerToken(id)}`;
}

function fail(code: string, message: string, path?: string): BlueprintError {
  return new BlueprintError(code, message, path);
}
