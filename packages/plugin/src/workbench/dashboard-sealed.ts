/**
 * The Home dashboard capability (the board itself and its publishing
 * permissions) is sealed as of 2026-10-21, to be woken later.
 *
 * Only the entries are hidden: the desktop rail "▦ 看板" button and the
 * 看板 / 发布授权 views of the home surface. The chat view stays. The
 * `@dashboard` portal target, the dashboard backend, the publication schemas
 * and every dashboard test keep running unchanged, so waking the capability
 * is a one-line change.
 *
 * Wake: set this back to false, then re-check the `@dashboard` selection flow
 * in tests/native-desktop.test.ts and re-shoot the rail screenshots in
 * `.sandbox/ui-overhaul-20261020/settings-wa/`.
 */
export const HOME_DASHBOARD_SEALED = true;
