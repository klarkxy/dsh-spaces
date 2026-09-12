/**
 * Panel copy for zh/en. Locale selection is documented in
 * `tasks/pluginization-localization.md`: browser language, then a visible
 * 中文/English switch. Host `ctx.locale` is not used — the locale plugin is
 * not in this package's inject/peers, and declaring `locale:` on a slot
 * throws if the face is missing.
 */

export type SpacesLocale = "zh" | "en";

export function inferSpacesLocale(tag?: string): SpacesLocale {
  const value =
    tag ??
    firstNavigatorLanguage() ??
    (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().locale : "en");
  return /^zh([-_]|$)/i.test(value) ? "zh" : "en";
}

function firstNavigatorLanguage(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  const languages = navigator.languages;
  if (Array.isArray(languages) && typeof languages[0] === "string" && languages[0]) {
    return languages[0];
  }
  return navigator.language || undefined;
}

const en = {
  "panel.title": "Spaces",
  "panel.refresh": "Refresh",
  "panel.refreshing": "Refreshing…",
  "panel.loading": "Loading spaces…",
  "panel.language": "Language",
  "list.label": "Spaces",
  "list.empty": "No spaces yet. Create one above to get started.",
  "list.host": "Host",
  "status.running": "Running",
  "status.stopped": "Stopped",
  "status.unknown": "Unknown",
  "capabilities.label": "Capabilities",
  "capabilities.reasons": "Why capabilities are restricted",
  "mode.verified-full": "Verified — creation and verification available",
  "mode.verified-limited": "Verified — limited access",
  "mode.unknown-readonly": "Unknown runtime — read-only",
  "mode.recovery-only": "Recovery only",
  "create.form": "Create space",
  "create.title": "Create space",
  "create.name": "Name",
  "create.displayName": "Display name (optional)",
  "create.submit": "Create",
  "create.pending": "Creating…",
  "create.denied": "Creation is not available in the current mode.",
  "detail.label": "Space details",
  "detail.placeholder": "Select a space to see its details.",
  "detail.loading": "Loading space details…",
  "detail.failed": "Space details could not be loaded.",
  "detail.id": "ID",
  "detail.status": "Status",
  "detail.webApp": "Web app",
  "detail.webAppInstalled": "Installed",
  "detail.webAppNone": "None",
  "detail.plugins": "Plugins",
  "detail.pluginsEmpty": "No plugins installed.",
  "detail.pluginName": "Name",
  "detail.pluginVersion": "Version",
  "detail.unknown": "unknown",
  "detail.snapshots": "Snapshots",
  "detail.snapshotsEmpty": "No snapshots recorded.",
  "detail.snapshotId": "ID",
  "detail.snapshotCreated": "Created",
  "detail.snapshotRuntime": "Runtime",
  "detail.diagnostics": "Diagnostics",
  "detail.hostLocked": "The host space cannot be verified or modified from here.",
  "detail.verifyDenied": "Verification is not available in the current mode.",
  "detail.verify": "Verify isolation",
  "detail.verifying": "Verifying…",
  "isolation.verified": "Isolation verified",
  "isolation.unverified": "Isolation unverified",
  "isolation.invalid": "Isolation invalid",
  "isolation.default": "Default profile",
  "isolation.lastPassed": "Last isolation check passed",
  "isolation.lastFailed": "Last isolation check failed",
  "error.generic": "The Spaces service request failed. Try again later.",
  "error.invalidInput": "The request is not a valid space operation.",
  "error.notFound": "That space was not found.",
  "error.hostDenied": "The current host space cannot be modified this way.",
  "error.readOnly": "Spaces are read-only until the host identity and runtime are confirmed.",
  "error.unavailable": "A previous space operation did not finish. Recovery is required.",
  "error.locked": "Another space operation is already running.",
  "error.alreadyExists": "A space with that name already exists.",
  "error.operationFailed": "The space operation could not be completed.",
  "diag.hostIdentityUnconfirmed":
    "Host identity could not be confirmed from DSH home, loader root, and invocation profile.",
  "diag.runtimeUnbound": "The bound DSH CLI could not be validated from the current process.",
  "diag.runtimeIncompatible": "The bound DSH CLI is not a known compatible version.",
  "diag.loaderMissing": "Required loader service is not available.",
  "diag.liveConfigUnverified": "Current host configuration roots could not be verified.",
  "diag.recoveryNeeded": "A previous space mutation did not finish.",
  "diag.lockHeld": "A home operation lock is already held.",
  "diag.lockResidue": "A home operation lock is incomplete or ambiguous and was not stolen.",
  "diag.snapshotsUnavailable": "Snapshot metadata is unavailable because no snapshot root is configured.",
  "diag.snapshotsUnreadable": "Configured snapshot root could not be read safely.",
  "diag.isolationFileOnly":
    "Isolation is not marked verified without current composed configuration evidence.",
  "diag.registryCorrupt": "The spaces registry could not be read safely.",
  "verify.passed": "Isolation matches the current composed configuration.",
  "verify.failed": "Isolation could not be verified.",
} as const;

export type SpacesMessageKey = keyof typeof en;

const zh: Record<SpacesMessageKey, string> = {
  "panel.title": "空间",
  "panel.refresh": "刷新",
  "panel.refreshing": "正在刷新…",
  "panel.loading": "正在加载空间…",
  "panel.language": "语言",
  "list.label": "空间列表",
  "list.empty": "还没有空间。请先在上方创建一个。",
  "list.host": "宿主",
  "status.running": "运行中",
  "status.stopped": "已停止",
  "status.unknown": "未知",
  "capabilities.label": "能力",
  "capabilities.reasons": "能力受限原因",
  "mode.verified-full": "已验证 — 可创建和验证",
  "mode.verified-limited": "已验证 — 访问受限",
  "mode.unknown-readonly": "未知运行时 — 只读",
  "mode.recovery-only": "仅恢复",
  "create.form": "创建空间",
  "create.title": "创建空间",
  "create.name": "名称",
  "create.displayName": "显示名称（可选）",
  "create.submit": "创建",
  "create.pending": "正在创建…",
  "create.denied": "当前模式不可创建。",
  "detail.label": "空间详情",
  "detail.placeholder": "选择一个空间查看详情。",
  "detail.loading": "正在加载空间详情…",
  "detail.failed": "无法加载空间详情。",
  "detail.id": "ID",
  "detail.status": "状态",
  "detail.webApp": "Web 应用",
  "detail.webAppInstalled": "已安装",
  "detail.webAppNone": "无",
  "detail.plugins": "插件",
  "detail.pluginsEmpty": "未安装插件。",
  "detail.pluginName": "名称",
  "detail.pluginVersion": "版本",
  "detail.unknown": "未知",
  "detail.snapshots": "快照",
  "detail.snapshotsEmpty": "没有快照记录。",
  "detail.snapshotId": "ID",
  "detail.snapshotCreated": "创建时间",
  "detail.snapshotRuntime": "运行时",
  "detail.diagnostics": "诊断",
  "detail.hostLocked": "宿主空间不能在此验证或修改。",
  "detail.verifyDenied": "当前模式不可验证。",
  "detail.verify": "验证隔离",
  "detail.verifying": "正在验证…",
  "isolation.verified": "隔离已验证",
  "isolation.unverified": "隔离未验证",
  "isolation.invalid": "隔离无效",
  "isolation.default": "默认配置",
  "isolation.lastPassed": "最近一次隔离检查通过",
  "isolation.lastFailed": "最近一次隔离检查失败",
  "error.generic": "Spaces 服务请求失败，请稍后重试。",
  "error.invalidInput": "这不是一次有效的空间操作。",
  "error.notFound": "找不到该空间。",
  "error.hostDenied": "当前宿主空间不能这样修改。",
  "error.readOnly": "在确认宿主身份和运行时之前，空间为只读。",
  "error.unavailable": "上一次空间操作未完成，需要恢复。",
  "error.locked": "已有空间操作正在进行。",
  "error.alreadyExists": "已存在同名空间。",
  "error.operationFailed": "无法完成该空间操作。",
  "diag.hostIdentityUnconfirmed": "无法从 DSH Home、加载器根目录和调用配置确认宿主身份。",
  "diag.runtimeUnbound": "无法从当前进程校验已绑定的 DSH CLI。",
  "diag.runtimeIncompatible": "已绑定的 DSH CLI 不是已知兼容版本。",
  "diag.loaderMissing": "所需的加载器服务不可用。",
  "diag.liveConfigUnverified": "无法验证当前宿主配置根目录。",
  "diag.recoveryNeeded": "上一次空间变更未完成。",
  "diag.lockHeld": "Home 操作锁已被占用。",
  "diag.lockResidue": "Home 操作锁不完整或状态不明，未抢占。",
  "diag.snapshotsUnavailable": "未配置快照根目录，快照元数据不可用。",
  "diag.snapshotsUnreadable": "无法安全读取已配置的快照根目录。",
  "diag.isolationFileOnly": "没有当前组合配置证据时，隔离不会标记为已验证。",
  "diag.registryCorrupt": "无法安全读取空间注册表。",
  "verify.passed": "隔离与当前组合配置一致。",
  "verify.failed": "无法验证隔离。",
};

export const MESSAGES: Record<SpacesLocale, Record<SpacesMessageKey, string>> = { en, zh };

/** Stable labels for acceptance scripts. Values match the panel dictionaries. */
export const ACCEPTANCE_LABELS = {
  en: {
    panelTitle: en["panel.title"],
    refresh: en["panel.refresh"],
    language: en["panel.language"],
    loading: en["panel.loading"],
    empty: en["list.empty"],
    host: en["list.host"],
    running: en["status.running"],
    create: en["create.submit"],
    createDenied: en["create.denied"],
    verify: en["detail.verify"],
    hostLocked: en["detail.hostLocked"],
    verifyDenied: en["detail.verifyDenied"],
    lastCheckPassed: en["isolation.lastPassed"],
    lastCheckFailed: en["isolation.lastFailed"],
    genericError: en["error.generic"],
    hostDenied: en["error.hostDenied"],
    modeFull: en["mode.verified-full"],
    modeReadonly: en["mode.unknown-readonly"],
  },
  zh: {
    panelTitle: zh["panel.title"],
    refresh: zh["panel.refresh"],
    language: zh["panel.language"],
    loading: zh["panel.loading"],
    empty: zh["list.empty"],
    host: zh["list.host"],
    running: zh["status.running"],
    create: zh["create.submit"],
    createDenied: zh["create.denied"],
    verify: zh["detail.verify"],
    hostLocked: zh["detail.hostLocked"],
    verifyDenied: zh["detail.verifyDenied"],
    lastCheckPassed: zh["isolation.lastPassed"],
    lastCheckFailed: zh["isolation.lastFailed"],
    genericError: zh["error.generic"],
    hostDenied: zh["error.hostDenied"],
    modeFull: zh["mode.verified-full"],
    modeReadonly: zh["mode.unknown-readonly"],
  },
} as const;

const ENGLISH_TO_KEY: Record<string, SpacesMessageKey> = {
  [en["create.denied"]]: "create.denied",
  [en["detail.failed"]]: "detail.failed",
  [en["error.generic"]]: "error.generic",
  [en["error.invalidInput"]]: "error.invalidInput",
  [en["error.notFound"]]: "error.notFound",
  [en["error.hostDenied"]]: "error.hostDenied",
  [en["error.readOnly"]]: "error.readOnly",
  [en["error.unavailable"]]: "error.unavailable",
  [en["error.locked"]]: "error.locked",
  [en["error.alreadyExists"]]: "error.alreadyExists",
  [en["error.operationFailed"]]: "error.operationFailed",
  [en["diag.hostIdentityUnconfirmed"]]: "diag.hostIdentityUnconfirmed",
  [en["diag.runtimeUnbound"]]: "diag.runtimeUnbound",
  [en["diag.runtimeIncompatible"]]: "diag.runtimeIncompatible",
  [en["diag.loaderMissing"]]: "diag.loaderMissing",
  [en["diag.liveConfigUnverified"]]: "diag.liveConfigUnverified",
  [en["diag.recoveryNeeded"]]: "diag.recoveryNeeded",
  [en["diag.lockHeld"]]: "diag.lockHeld",
  [en["diag.lockResidue"]]: "diag.lockResidue",
  [en["diag.snapshotsUnavailable"]]: "diag.snapshotsUnavailable",
  [en["diag.snapshotsUnreadable"]]: "diag.snapshotsUnreadable",
  [en["diag.isolationFileOnly"]]: "diag.isolationFileOnly",
  [en["diag.registryCorrupt"]]: "diag.registryCorrupt",
  [en["verify.passed"]]: "verify.passed",
  [en["verify.failed"]]: "verify.failed",
  "The host space cannot be modified.": "error.hostDenied",
  "Space not found.": "error.notFound",
  "Space is locked.": "error.locked",
};

const ERROR_CODE_TO_KEY: Record<string, SpacesMessageKey> = {
  "spaces/read-only": "error.readOnly",
  "spaces/host-denied": "error.hostDenied",
  "spaces/invalid-input": "error.invalidInput",
  "spaces/not-found": "error.notFound",
  "spaces/already-exists": "error.alreadyExists",
  "spaces/locked": "error.locked",
  "spaces/unavailable": "error.unavailable",
};

const DIAGNOSTIC_CODE_TO_KEY: Record<string, SpacesMessageKey> = {
  HOST_IDENTITY_UNCONFIRMED: "diag.hostIdentityUnconfirmed",
  RUNTIME_UNBOUND: "diag.runtimeUnbound",
  RUNTIME_INCOMPATIBLE: "diag.runtimeIncompatible",
  LOADER_MISSING: "diag.loaderMissing",
  LIVE_CONFIG_UNVERIFIED: "diag.liveConfigUnverified",
  RECOVERY_NEEDED: "diag.recoveryNeeded",
  LOCK_HELD: "diag.lockHeld",
  LOCK_RESIDUE: "diag.lockResidue",
  SNAPSHOTS_UNAVAILABLE: "diag.snapshotsUnavailable",
  SNAPSHOTS_UNREADABLE: "diag.snapshotsUnreadable",
  ISOLATION_FILE_ONLY: "diag.isolationFileOnly",
  REGISTRY_CORRUPT: "diag.registryCorrupt",
};

export function t(locale: SpacesLocale, key: SpacesMessageKey): string {
  return MESSAGES[locale][key] ?? MESSAGES.en[key];
}

/**
 * Convert a backend English string or known code to the active locale.
 * Unknown text is replaced with the generic error — never shown raw.
 */
export function localizeSafeText(
  locale: SpacesLocale,
  text: string | null | undefined,
  code?: string | null,
): string {
  if (code && ERROR_CODE_TO_KEY[code]) return t(locale, ERROR_CODE_TO_KEY[code]);
  if (code && DIAGNOSTIC_CODE_TO_KEY[code]) return t(locale, DIAGNOSTIC_CODE_TO_KEY[code]);
  if (text && ENGLISH_TO_KEY[text]) return t(locale, ENGLISH_TO_KEY[text]);
  return t(locale, "error.generic");
}

export function localizeDiagnostic(
  locale: SpacesLocale,
  code: string,
  message: string,
): string {
  if (DIAGNOSTIC_CODE_TO_KEY[code]) return t(locale, DIAGNOSTIC_CODE_TO_KEY[code]);
  if (ENGLISH_TO_KEY[message]) return t(locale, ENGLISH_TO_KEY[message]);
  return t(locale, "error.generic");
}
