/**
 * Styles of the desktop (Electron) host shell.
 *
 * The native guest is a child of `.dsh-native-container`, and the container is
 * measured by the host to place the native view. Nothing in this file may
 * transform, filter or resize the container or its ancestors: the motion
 * lives on the rail, on the guide and on the loading notice, all of them
 * siblings of the container.
 */
export const NATIVE_HOST_CSS = `
[data-windows-titlebar] .dsh-host-dock[data-spaces-native] { --dsh-frame-top-clearance: var(--dsh-windows-titlebar-height); }
.dsh-host-dock[data-spaces-native] .dsh-host-rail {
  background: var(--host-rail-bg, var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f0f1f5)));
  border-color: var(--host-border, var(--dsw-alias-border-l3, #d6d8de));
}
.dsh-native-container { overflow: hidden; display: flex; }
.dsh-native-container[hidden] { display: none; }
.dsh-native-guest { display: flex; width: 100%; height: 100%; border: 0; }
.dsh-host-rail button[aria-current="page"] { border-color: currentColor; background: color-mix(in srgb, currentColor 12%, transparent); }
.dsh-host-dock[data-spaces-native] .dsh-host-rail-btn[aria-current="page"] { border-color: transparent; background: transparent; }
.dsh-host-dock[data-spaces-native] .dsh-native-service-error { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--host-danger, #d1242f); color: #fff; font: bold 12px/16px system-ui; text-align: center; }
`;

/** Styles of the official Browser tab inside a native space. */
export const NATIVE_BROWSER_CSS = `
.dsh-native-browser-tab { position: absolute; display: flex; border: 0; background: #fff; z-index: 1; }
.dsh-native-browser-tab[hidden] { display: none; }
`;
