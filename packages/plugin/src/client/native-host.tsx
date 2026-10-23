/**
 * The desktop (Electron) host of Spaces.
 *
 * The parts live in focused modules under `client/ui/`:
 *
 * - `ui/native-controller.ts` — the native guest lifetime and the browser
 *   relay. It never touches the DOM of the guest it places.
 * - `ui/native-shell.tsx` — the rail, the guide and the loading notice. The
 *   motion lives on those siblings, never on the container that holds the
 *   native view.
 * - `ui/native-styles.ts` — the styles of both.
 *
 * This file keeps the public names and import paths stable.
 */
export { desktopBrowserBridge, NativeHostController } from "./ui/native-controller";
export type { DesktopBrowserBridge } from "./ui/native-controller";
export { NativeHostShell } from "./ui/native-shell";
export { NATIVE_BROWSER_CSS, NATIVE_HOST_CSS } from "./ui/native-styles";
