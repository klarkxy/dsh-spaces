import type { Context } from '@deepseek-ai/cordis';
import type {} from '../../view-bridge/src/message-service';
import { parseViewEnv } from '../../view-bridge/src/env';
import { BrowserTabs } from './tabs';
import { BrowserRemote } from './remote';

export interface BrowserConfig { allowedSpaces?: readonly string[] }

export const name = 'dsh-spaces-browser';
export const inject = ['spaceMessages', 'webServer'];

/** A Space-owned Browser, independent of the Spaces manager and chat UI. */
export function apply(ctx: Context, config: BrowserConfig = {}): BrowserTabs {
  const allowed = config.allowedSpaces ?? [];
  if (!Array.isArray(allowed) || allowed.some(space => typeof space !== 'string' || !/^[a-z0-9][a-z0-9-]{0,38}$/.test(space))) {
    throw new Error('Invalid Browser allowedSpaces');
  }
  const parentOrigin = parseViewEnv(process.env)?.parentOrigin;
  const webServer = ctx.get('webServer') as { port?: number };
  const tabs = new BrowserTabs(() => {
    if (!Number.isInteger(webServer.port) || !webServer.port) throw new Error('Browser Host origin is unavailable');
    return new Set([String(webServer.port), ...(parentOrigin ? [new URL(parentOrigin).port] : [])]);
  });
  new BrowserRemote(ctx, tabs);
  ctx.spaceMessages.handle('browser.openURL', allowed, params => {
    if (!params || typeof params !== 'object' || Array.isArray(params) ||
      Object.keys(params).length !== 1 || typeof params.url !== 'string') throw new Error('Invalid Browser request');
    const tab = tabs.openURL(params.url);
    return { id: tab.id, requestedUrl: tab.requestedUrl, url: tab.url, title: tab.title };
  }, { description: 'Open an HTTP(S) URL in a new Browser tab.' });
  ctx.spaceMessages.handle('browser.listTabs', allowed, params => {
    if (params !== null) throw new Error('Invalid Browser request');
    return tabs.listTabs().map(tab => ({ id: tab.id, requestedUrl: tab.requestedUrl, url: tab.url, title: tab.title }));
  }, { description: 'List this Browser Space’s open tabs.' });
  return tabs;
}

export default { name, inject, apply };
