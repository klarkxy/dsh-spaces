import { createElement, type ReactElement } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import { DashboardApp } from './view.js';
import { createDashboardHttpBackend } from './http-client.js';

export const name = 'dsh-dashboard-client';
export const inject = ['slots'];
export const DASHBOARD_PANEL_ID = 'dsh-dashboard';
function DashboardIcon(): ReactElement {
  return createElement('svg', { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
    createElement('rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }),
    createElement('rect', { x: 14, y: 3, width: 7, height: 11, rx: 1.5 }),
    createElement('rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }),
    createElement('path', { d: 'M14 18h7M14 21h7' }));
}
/** Native sidebar/main contributions only: never claims root or bundles its own React. */
export function apply(ctx: Context): void {
  const backend = createDashboardHttpBackend(window.location.origin);
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: DASHBOARD_PANEL_ID, order: 90, label: () => '工作首页',
  }, DashboardIcon));
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: DASHBOARD_PANEL_ID },
    () => createElement(DashboardApp, { backend })));
}
export default { name, inject, apply };
