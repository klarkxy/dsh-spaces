import { validate } from './blueprint.mjs';
import { parseBlueprint, bindBlueprintInputs, diagnoseBlueprint } from './lib/v1/domain.js';
import { BlueprintError, BLUEPRINT_CODE } from './lib/v1/types.js';

/** Validate the original artifact without converting one protocol version into another. */
export function parseBlueprintDocument(value) {
  return value?.formatVersion === 2 ? validate(value) : parseBlueprint(value);
}

/** Project an already validated document. Persist/share `document`, never this view. */
export function blueprintRecipe(value) {
  const document = value;
  if (document.formatVersion === 1) return { ...document, document };
  return {
    kind: document.kind,
    formatVersion: 2,
    metadata: document.metadata,
    packages: document.packages.map(p => ({ name: p.name, version: p.version, source: { type: p.source } })),
    profile: { base: 'web', bundles: [...document.bundles], patch: [], settings: {} },
    inputs: [], bindings: [], relations: [], document,
  };
}

export function bindDocumentInputs(value, values) {
  const document = parseBlueprintDocument(value);
  if (document.formatVersion === 1) return bindBlueprintInputs(document, values);
  if (!values || typeof values !== 'object' || Array.isArray(values) || Reflect.ownKeys(values).length) {
    throw new BlueprintError(BLUEPRINT_CODE.INPUT_TYPE, 'Blueprint v2 does not declare receiver-local inputs.');
  }
  return { patch: [], settings: {} };
}

export function diagnoseDocument(value, environment) {
  const document = parseBlueprintDocument(value);
  return document.formatVersion === 1 ? diagnoseBlueprint(document, environment) : [];
}
