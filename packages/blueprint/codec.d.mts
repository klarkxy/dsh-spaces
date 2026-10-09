export const MAX_JSON: number;
export const MAX_SHARE: number;
export class BlueprintError extends Error { constructor(code: string, message: string); code: string }
export function fail(code: string, message: string): never;
export function plain(value: unknown): value is Record<string, unknown>;
export function forbidden(key: string): boolean;
export function parseJson(text: string): unknown;
export function decode(text: string): unknown;
export function encode(document: unknown): string;
