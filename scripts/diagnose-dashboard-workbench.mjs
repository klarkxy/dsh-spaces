/** Collect non-sensitive browser styling evidence without changing any test assertion. */
import { chromium } from 'playwright';
const launch = chromium.launch.bind(chromium);
chromium.launch = async options => {
  const browser = await launch(options);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async options => {
    const context = await newContext(options);
    context.on('page', page => {
      page.on('console', message => {
        if (message.type() === 'error' && /style|stylesheet|Content Security|CSP/i.test(message.text())) {
          console.error('STYLE_CONSOLE', message.text().replace(/([?&]token=)[^&\s]+/g, '$1[redacted]').slice(0, 3000));
        }
      });
    });
    return context;
  };
  const close = browser.close.bind(browser);
  browser.close = async options => {
    for (const context of browser.contexts()) for (const page of context.pages()) for (const frame of page.frames()) {
      try {
        const report = await frame.evaluate(() => {
          const root = document.querySelector('.dsh-workbench'); if (!root) return null;
          const css = element => { const style = getComputedStyle(element); const box = element.getBoundingClientRect(); return { tag: element.tagName, cls: element.className, width: box.width, height: box.height, scroll: element.scrollWidth, client: element.clientWidth, display: style.display, overflow: style.overflow, background: style.backgroundColor }; };
          return {
            viewport: innerWidth, root: css(root), main: css(root.querySelector('.dsh-wb-main')),
            styles: [...document.querySelectorAll('style')].map(style => ({ length: style.textContent.length, prefix: style.textContent.slice(0, 150), media: style.media, type: style.type, connected: style.isConnected, sheet: !!style.sheet, parent: style.parentElement?.tagName, namespace: style.namespaceURI })),
            sheets: [...document.styleSheets].map(sheet => { let rules; try { rules = sheet.cssRules.length; } catch { rules = 'unreadable'; } return { href: sheet.href?.split('?')[0], disabled: sheet.disabled, media: sheet.media.mediaText, rules }; }),
          };
        });
        if (report) console.log('WORKBENCH_STYLE_EVIDENCE', JSON.stringify(report));
      } catch (error) { console.error('STYLE_EVIDENCE_UNAVAILABLE', error.name); }
    }
    return close(options);
  };
  return browser;
};
await import('./test-dashboard-workbench-native.mjs');
