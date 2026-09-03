import { BrowserWindow, WebContentsView } from "electron";
import { RAIL_WIDTH, TITLEBAR_HEIGHT } from "../shared/layout";

export { RAIL_WIDTH, TITLEBAR_HEIGHT };

const TIP_HEIGHT = 32;
const TIP_GAP = 8;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function estimateTipWidth(text: string): number {
  let units = 0;
  for (const char of text) {
    units += char.charCodeAt(0) > 0xff ? 1.9 : 1;
  }
  return Math.ceil(Math.min(320, Math.max(40, 24 + units * 7.2)));
}

function tooltipSrc(text: string): string {
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body {
    margin: 0;
    height: 100%;
    background: #09090b;
    color: #f2f3f5;
    font: 13px/32px "Segoe UI", system-ui, sans-serif;
    overflow: hidden;
    user-select: none;
  }
  body { padding: 0 12px; white-space: nowrap; }
</style>
</head>
<body>${escapeHtml(text)}</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export class ViewManager {
  private readonly views = new Map<string, WebContentsView>();
  private selected: string | null = null;
  private overlayOpen = false;
  private tooltip: WebContentsView | null = null;
  private tooltipText = "";

  constructor(private readonly window: BrowserWindow) {
    this.window.on("resize", () => this.layout());
  }

  select(name: string, port: number): void {
    this.selected = name;
    let view = this.views.get(name);
    if (!view) {
      view = new WebContentsView();
      this.views.set(name, view);
      this.window.contentView.addChildView(view);
      void view.webContents.loadURL(`http://127.0.0.1:${port}`);
    }
    this.layout();
  }

  setOverlayOpen(open: boolean): void {
    this.overlayOpen = open;
    if (open) this.hideTooltip();
    this.layout();
  }

  showTooltip(text: string, top: number): void {
    if (this.overlayOpen) return;
    const view = this.ensureTooltip();
    if (this.tooltipText !== text) {
      this.tooltipText = text;
      void view.webContents.loadURL(tooltipSrc(text));
    }
    view.setBounds({
      x: RAIL_WIDTH + TIP_GAP,
      y: Math.max(TITLEBAR_HEIGHT + 4, Math.round(top - 8)),
      width: estimateTipWidth(text),
      height: TIP_HEIGHT,
    });
    view.setVisible(true);
    this.window.contentView.addChildView(view);
  }

  hideTooltip(): void {
    this.tooltipText = "";
    this.tooltip?.setVisible(false);
  }

  hideAll(): void {
    this.hideTooltip();
    for (const view of this.views.values()) view.setVisible(false);
  }

  destroy(name: string): void {
    const view = this.views.get(name);
    if (!view) return;
    this.window.contentView.removeChildView(view);
    view.webContents.close();
    this.views.delete(name);
    if (this.selected === name) this.selected = null;
  }

  private ensureTooltip(): WebContentsView {
    if (this.tooltip) return this.tooltip;
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        javascript: false,
        contextIsolation: true,
      },
    });
    view.setBackgroundColor("#09090b");
    view.setBorderRadius(6);
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    this.tooltip = view;
    return view;
  }

  private layout(): void {
    const bounds = this.window.getContentBounds();
    for (const [key, child] of this.views) {
      const visible = !this.overlayOpen && key === this.selected;
      child.setVisible(visible);
      if (visible) {
        child.setBounds({
          x: RAIL_WIDTH,
          y: TITLEBAR_HEIGHT,
          width: Math.max(0, bounds.width - RAIL_WIDTH),
          height: Math.max(0, bounds.height - TITLEBAR_HEIGHT),
        });
      }
    }
    if (this.tooltip?.getVisible()) {
      this.window.contentView.addChildView(this.tooltip);
    }
  }
}
