/** Chromium test of the shared view with synthetic browser-local data; not native DSH installation. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const bundled = await build({ entryPoints: ['tests/fixtures/dashboard-browser.tsx'], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022', jsx: 'automatic' });
const javascript = bundled.outputFiles[0].text;
const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'");
  if (request.url === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><html lang="zh"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard browser fixture</title><body><div id="root"></div><script src="/fixture.js"></script></body></html>'); }
  else if (request.url === '/fixture.js') { response.setHeader('Content-Type', 'text/javascript; charset=utf-8'); response.end(javascript); }
  else { response.statusCode = 404; response.end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors = [], unexpected = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(`http://127.0.0.1:${server.address().port}/`)) unexpected.push(request.url()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('heading', { name: '首页还没有固定组件' }).waitFor();
  assert.equal((await page.evaluate(() => window.dashboardTest.state())).writes, 1, 'Only initial provider publication writes; opening the page does not create a board');
  await page.getByRole('button', { name: '固定 写作进度', exact: true }).click();
  await page.locator('.dd-card progress').waitFor();
  assert.equal(await page.locator('.dd-card progress').getAttribute('value'), '3');
  await page.evaluate(() => window.dashboardTest.update());
  await page.waitForFunction(() => document.querySelector('.dd-card progress')?.getAttribute('value') === '7');
  await page.getByRole('button', { name: '固定 交付清单', exact: true }).click();
  await page.locator('.dd-card').filter({ has: page.getByRole('heading', { name: '交付清单', exact: true }) }).waitFor();
  await page.getByRole('button', { name: '固定 今日笔记', exact: true }).click();
  await page.locator('.dd-card pre').waitFor();
  assert.equal(await page.locator('.dd-card a, .dd-card img, .dd-card iframe').count(), 0);
  const progress = page.locator('.dd-card').filter({ has: page.locator('progress') });
  await progress.getByText('调整布局', { exact: true }).click();
  await progress.getByLabel('行', { exact: true }).fill('4');
  await progress.getByRole('button', { name: '保存位置' }).click();
  await page.waitForFunction(() => window.dashboardTest.state().boards[0]?.placements.some(p => p.ref.instanceId === 'story' && p.y === 4));
  await mkdir('.sandbox/dashboard-evidence', { recursive: true });
  await page.screenshot({ path: '.sandbox/dashboard-evidence/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.sandbox/dashboard-evidence/narrow.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Narrow viewport has no horizontal overflow');
  await progress.getByRole('button', { name: '移除固定组件' }).click();
  await page.waitForFunction(() => !window.dashboardTest.state().boards[0]?.placements.some(p => p.ref.instanceId === 'story'));
  assert.equal((await page.evaluate(() => window.dashboardTest.state())).providerInstances, 3, 'Unpin does not delete business instances');
  await page.evaluate(() => window.dashboardTest.revoke());
  await page.getByRole('alert').filter({ hasText: '看板读取已停止' }).waitFor();
  assert.equal(await page.locator('.dd-card').count(), 0, 'Authorization loss clears displayed source content');
  const stopped = (await page.evaluate(() => window.dashboardTest.state())).reads;
  await page.waitForTimeout(2500);
  assert.equal((await page.evaluate(() => window.dashboardTest.state())).reads, stopped, 'A failed read session does not poll again');
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  console.log('PASS Chromium shared-view flow: empty read, pin, live update, checklist/notes, safe rendering, layout save, narrow viewport, unpin, authorization loss and terminal polling.');
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
