import { BrowserWindow, WebContentsView } from "electron";

export const RAIL_WIDTH = 72;

export class ViewManager {
  private readonly views = new Map<string, WebContentsView>();
  private selected: string | null = null;
  private overlayOpen = false;
  private gutter = 0;

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
    this.layout();
  }

  setGutter(width: number): void {
    this.gutter = Math.max(0, width);
    this.layout();
  }

  hideAll(): void {
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

  private layout(): void {
    const bounds = this.window.getContentBounds();
    const inset = RAIL_WIDTH + this.gutter;
    for (const [key, child] of this.views) {
      const visible = !this.overlayOpen && key === this.selected;
      child.setVisible(visible);
      if (visible) {
        child.setBounds({
          x: inset,
          y: 0,
          width: Math.max(0, bounds.width - inset),
          height: bounds.height,
        });
      }
    }
  }
}
