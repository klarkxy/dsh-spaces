import type { BlueprintDocument } from './document.mjs';
import type { BlueprintEncodeMode } from './lib/v1/types.js';
export function decodeBlueprintDocument(text: string): BlueprintDocument;
export function encodeBlueprintDocument(document: BlueprintDocument, encoding?: BlueprintEncodeMode): string;
export function stringifyBlueprintDocument(document: BlueprintDocument): string;
