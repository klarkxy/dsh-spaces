import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';

export interface Tab { id: string; requestedUrl: string | null; url: string | null; title: string }
type Connection = Pick<ConnectionHandle, 'rpc'>;
type Method = 'listTabs' | 'openURL' | 'observe';
type Phase = 'request' | 'http' | 'remote' | 'decode';
const REMOTE_CODES = new Set(['gateway/bad-request', 'gateway/cancelled', 'gateway/internal']);

export class BrowserRequestFailure extends Error {
  constructor(readonly method: Method, readonly phase: Phase, readonly code: string, readonly status?: number) {
    super(`Request: ${method}. Phase: ${phase}.${status === undefined ? '' : ` HTTP ${status}.`} Code: ${code}.`);
  }
}

export function displayBrowserFailure(error: unknown, fallback: string): string {
  return error instanceof BrowserRequestFailure ? `${fallback} ${error.message}` : fallback;
}

async function call(connection: Connection, method: Method, args: Record<string, unknown>): Promise<unknown> {
  let result;
  try { result = await connection.rpc.call('/api', `spacesBrowser/${method}`, { args }); }
  catch (error) {
    // Classify only the SDK's exact status form; raw messages never leave this boundary.
    const status = error instanceof Error
      ? /^transport failure for \/api\/spacesBrowser\/(?:listTabs|openURL|observe): HTTP ([1-5][0-9]{2})$/.exec(error.message)
      : null;
    const http = status ? Number(status[1]) : undefined;
    throw new BrowserRequestFailure(method, http === undefined ? 'request' : 'http',
      http === 401 ? 'browser/unauthenticated' : http === 403 ? 'browser/forbidden' :
      http === undefined ? 'browser/request-failed' : 'browser/http-failed', http);
  }
  if (!result.ok) {
    throw new BrowserRequestFailure(method, 'remote',
      REMOTE_CODES.has(result.error.code) ? result.error.code : 'browser/remote-failed');
  }
  return result.value;
}

function invalid(method: Method): never {
  throw new BrowserRequestFailure(method, 'decode', 'browser/response-invalid');
}

function parseTab(value: unknown, method: Method): Tab {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(method);
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || (row.requestedUrl !== null && typeof row.requestedUrl !== 'string') ||
    (row.url !== null && typeof row.url !== 'string') || typeof row.title !== 'string') return invalid(method);
  return { id: row.id, requestedUrl: row.requestedUrl, url: row.url, title: row.title } as Tab;
}

export async function listTabs(connection: Connection): Promise<Tab[]> {
  const value = await call(connection, 'listTabs', {});
  if (!Array.isArray(value) || value.length > 16) return invalid('listTabs');
  return value.map(tab => parseTab(tab, 'listTabs'));
}

export async function openURL(connection: Connection, url: string): Promise<Tab> {
  return parseTab(await call(connection, 'openURL', { url }), 'openURL');
}

export async function observe(connection: Connection, observations: unknown): Promise<Tab[]> {
  if (!Array.isArray(observations) || observations.length > 16) return invalid('observe');
  const value = await call(connection, 'observe', { observations });
  if (!Array.isArray(value) || value.length > 16) return invalid('observe');
  return value.map(tab => parseTab(tab, 'observe'));
}
