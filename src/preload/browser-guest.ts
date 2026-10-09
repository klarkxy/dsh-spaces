import { ipcRenderer } from 'electron';
import { BROWSER_GUEST_IPC, BROWSER_RESULT, parseBrowserRelay, clipBrowserViewport } from '../shared/browser-guest';
/** Only the trusted Supervisor top frame gets this preload; subframes get none. */
window.addEventListener('message', async event => {
  const request = parseBrowserRelay(event.data);
  const frame = document.getElementById('manager-frame') as HTMLIFrameElement | null;
  if (!request || !frame || frame.hidden || event.source !== frame.contentWindow) return;
  const rect = frame.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  let relay = request;
  if (request.kind === 'present') {
    const viewport = clipBrowserViewport({ ...request.viewport, x: rect.x + request.viewport.x, y: rect.y + request.viewport.y },
      { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    if (!viewport) return;
    relay = { ...request, viewport };
  }
  try {
    const result = await ipcRenderer.invoke(BROWSER_GUEST_IPC, { managerOrigin: event.origin, relay });
    if (frame.isConnected && frame.contentWindow === event.source) (event.source as Window).postMessage(result, event.origin);
  } catch {
    (event.source as Window).postMessage({ source: BROWSER_RESULT, requestId: request.requestId, ok: false, error: 'unavailable' }, event.origin);
  }
});
