import { inferSpacesLocale, type SpacesLocale } from "../i18n";

/**
 * The words of the desktop (Electron) host shell.
 *
 * They follow the `host-texts.ts` pattern: every user-facing string of the
 * native rail, the guide, the space menu, the confirmations and the
 * controller notices lives in one table per locale, so the desktop surface
 * never hard-codes copy inside its components.
 */

/** Every string the desktop shell can show. */
export interface NativeShellTexts {
  rail: string;
  railCollapse: string;
  railExpand: string;
  desktopMain: string;
  desktopMainPinned: string;
  newSpace: string;
  operating: string;
  /** Label suffix while a space waits on an approval or a question. */
  attention: string;
  /** Label suffix while a space is running a task. */
  working: string;
  settings: string;
  settingsStopped: string;
  settingsUnavailable: string;
  dismissOperationError: string;
  guideLabel: string;
  guideLoading: string;
  guideStopping: string;
  guideStopped: string;
  initialize: string;
  backToMain: string;
  confirmInterruptLabel: string;
  stopTitle: string;
  restartTitle: string;
  confirmBusyBody: string;
  confirmUnknownBody: string;
  confirmInterruptTail: string;
  cancel: string;
  stopSpace: string;
  restartSpace: string;
  openingSpace: string;
  stoppingSpace: string;
  restartingSpace: string;
  opening: string;
  serviceOperation: string;
  serviceManual: string;
  surfaceReload: string;
  surfaceReloading: string;
  surfaceReloadedNotice: string;
  surfaceReloadUnavailable: string;
  surfaceReloadFailed: string;
  surfaceReloadServiceNotReady: string;
  serviceActionFailed: string;
  servicePreviewReading: string;
  serviceStopping: string;
  serviceStarting: string;
  serviceRestarting: string;
  closeNotice: string;
  serviceStopTitle: string;
  serviceRestartTitle: string;
  serviceStartTitle: string;
  serviceStopBody: string;
  serviceRestartBody: string;
  serviceStartBody: string;
  serviceSpaceRunning: string;
  serviceSpaceManaged: string;
  serviceConfirmDetails: string;
  serviceConfirmValid: string;
  serviceStopConfirm: string;
  serviceRestartConfirm: string;
  serviceStartConfirm: string;
  menuLabel: string;
  statusUnknown: string;
  start: string;
  stop: string;
  restart: string;
  spaceSettings: string;
  statusRunning: string;
  statusStopped: string;
  statusStarting: string;
  statusStopping: string;
  statusCrashed: string;
  statusUnopened: string;
  statusOpening: string;
  statusFailed: string;
  serviceCannotStop: string;
  serviceStopUnconfirmed: string;
  serviceStopFailed: string;
  restartUnavailable: string;
  restartFailed: string;
  serviceStartedNotice: string;
  spaceStoppedNotice: string;
  spaceRestartedNotice: string;
  spaceStartedNotice: string;
  spaceNotRunning: string;
  spaceChangedRetry: string;
  spaceActionFailed: string;
  spaceViewFailed: string;
  createDialogFailed: string;
  spaceSettingsFailed: string;
  serviceUnavailable: string;
  guestContent: string;
  desktopLaunchUnsupported: string;
  launchObservationEnded: string;
  selectionDeadline: string;
  selectionStageSuffix: string;
  selectionLoadMismatch: string;
  guestOpenFailed: string;
  guestInitialLoadTimeout: string;
  guestBootstrapFailed: string;
  guestLoadFailed: string;
  guestProcessGone: string;
  guestNavigatedAway: string;
  invalidPortalAddress: string;
  portalFailureNoDetail: string;
  browserResultFailed: string;
  hostRpcFailed: string;
  hostRpcConnectionSuffix: string;
  failureTime: string;
  failurePrimary: string;
  failureCleanup: string;
  failureInstance: string;
  instanceRetainedYes: string;
  instanceRetainedNo: string;
  startupLoading: string;
  startupDiscovering: string;
  startupPreparing: string;
  startupLaunching: string;
  startupStarting: string;
  startupConnecting: string;
  startupIdle: string;
  creationQueued: string;
  creationRunning: string;
  creationFailed: string;
  creationStepInstall: string;
  creationStepPrepare: string;
  creationStepConfig: string;
  creationStepView: string;
  creationStepModels: string;
  creationFailedTitle: string;
  creationViewTask: string;
  creationDismiss: string;
}

const texts: Record<SpacesLocale, NativeShellTexts> = {
  zh: {
    rail: "空间",
    railCollapse: "收起空间栏",
    railExpand: "展开空间栏",
    desktopMain: "Desktop · 主空间",
    desktopMainPinned: "Desktop · 主空间（始终置顶）",
    newSpace: "新建空间",
    operating: "操作中",
    attention: "等待处理",
    working: "正在工作",
    settings: "设置",
    settingsStopped: "设置 · Spaces 服务已停止",
    settingsUnavailable: "设置 · 空间服务不可用（查看详情）",
    dismissOperationError: "关闭操作提示",
    guideLabel: "空间状态",
    guideLoading: "正在连接空间服务…",
    guideStopping: "正在停止 Spaces 服务…",
    guideStopped: "Spaces 服务已停止。",
    initialize: "初始化 Spaces",
    backToMain: "返回主空间",
    confirmInterruptLabel: "确认任务中断影响",
    stopTitle: "停止 {name}？",
    restartTitle: "重启 {name}？",
    confirmBusyBody: "该空间有正在执行的任务，",
    confirmUnknownBody: "无法确认该空间是否有正在执行的任务，",
    confirmInterruptTail: "继续操作会中断任务。",
    cancel: "取消",
    stopSpace: "停止空间",
    restartSpace: "重启空间",
    openingSpace: "正在打开空间",
    stoppingSpace: "正在停止",
    restartingSpace: "正在重启",
    opening: "正在打开",
    serviceOperation: "Spaces 服务操作",
    serviceManual: "手动启动 / 重启 Spaces 服务…",
    surfaceReload: "重新加载空间界面",
    surfaceReloading: "正在重新加载空间界面…",
    surfaceReloadedNotice: "空间界面已重新加载。",
    surfaceReloadUnavailable: "当前无法重新加载空间界面。",
    surfaceReloadFailed: "重新加载空间界面失败。",
    surfaceReloadServiceNotReady: "Spaces 服务当前未就绪，无法仅重新加载空间界面。",
    serviceActionFailed: "服务操作失败。",
    servicePreviewReading: "正在检查受影响的空间…",
    serviceStopping: "正在停止 Spaces 服务…",
    serviceStarting: "正在启动 Spaces 服务…",
    serviceRestarting: "正在重启 Spaces 服务…",
    closeNotice: "关闭提示",
    serviceStopTitle: "停止 Spaces 服务？",
    serviceRestartTitle: "重启 Spaces 服务？",
    serviceStartTitle: "启动 Spaces 服务？",
    serviceStopBody: "将停止服务及以下空间，运行中的任务会中断。",
    serviceRestartBody: "将重启服务并停止以下空间，运行中的任务会中断。",
    serviceStartBody: "将启动 Spaces 服务，各子空间保持停止。",
    serviceSpaceRunning: "运行中，将停止",
    serviceSpaceManaged: "已停止",
    serviceConfirmDetails: "查看确认信息",
    serviceConfirmValid: "有效期至 {time}；空间状态变化后需重新确认。",
    serviceStopConfirm: "停止服务",
    serviceRestartConfirm: "停止并重启服务",
    serviceStartConfirm: "启动服务",
    menuLabel: "空间操作",
    statusUnknown: "状态未知",
    start: "启动",
    stop: "停止",
    restart: "重启",
    spaceSettings: "打开空间设置",
    statusRunning: "运行中",
    statusStopped: "已停止",
    statusStarting: "正在启动",
    statusStopping: "正在停止",
    statusCrashed: "异常退出",
    statusUnopened: "尚未打开",
    statusOpening: "正在打开",
    statusFailed: "打开失败",
    serviceCannotStop: "服务当前无法停止。",
    serviceStopUnconfirmed: "服务停止结果尚未确认。",
    serviceStopFailed: "服务停止未能确认。请查看详情。",
    restartUnavailable: "当前无法手动启动或重启服务。",
    restartFailed: "手动服务操作失败。",
    serviceStartedNotice: "Spaces 服务已启动。",
    spaceStoppedNotice: "{name} 已停止。",
    spaceRestartedNotice: "{name} 已重启。",
    spaceStartedNotice: "{name} 已启动。",
    spaceNotRunning: "该空间尚未运行，请先启动。",
    spaceChangedRetry: "空间状态已变化，请重新确认。",
    spaceActionFailed: "空间操作失败。",
    spaceViewFailed: "无法打开空间页面。",
    createDialogFailed: "无法打开新建空间窗口。",
    spaceSettingsFailed: "无法打开空间设置。",
    serviceUnavailable: "空间服务或页面不可用。",
    guestContent: "空间内容",
    desktopLaunchUnsupported: "无法读取启动状态，空间服务是否已启动无法确认。",
    launchObservationEnded: "启动状态已变化，本次启动观察已结束。",
    selectionDeadline: "90 秒内未收到空间页面的选择应答。",
    selectionStageSuffix: "（已到达阶段：{stages}）",
    selectionLoadMismatch: "空间页面未能完成选择跳转。",
    guestOpenFailed: "空间页面未能打开。",
    guestInitialLoadTimeout: "空间页面的初始加载超时（15 秒）。",
    guestBootstrapFailed: "空间服务入口未能载入空间页面。",
    guestLoadFailed: "空间页面加载失败（{detail}）。",
    guestProcessGone: "空间页面的渲染进程已退出（{detail}）。",
    guestNavigatedAway: "空间页面跳转到了空间入口之外。",
    invalidPortalAddress: "观察到无效的空间页面地址。",
    portalFailureNoDetail: "空间页面报告了失败，但未提供原因。",
    browserResultFailed: "空间页面的浏览器回执未能送达。",
    hostRpcFailed: "宿主通信中断（{endpoint}{state}）。",
    hostRpcConnectionSuffix: "，连接状态：{state}",
    failureTime: "失败时间：",
    failurePrimary: "失败原因",
    failureCleanup: "随后停止结果",
    failureInstance: "进程记录",
    instanceRetainedYes: "进程记录已保留。",
    instanceRetainedNo: "进程记录未保留。",
    startupLoading: "连接中",
    startupDiscovering: "检查中",
    startupPreparing: "准备中",
    startupLaunching: "发起中",
    startupStarting: "启动中",
    startupConnecting: "接入中",
    startupIdle: "未启动",
    creationQueued: "{name} · 等待开始",
    creationRunning: "{name} · 正在创建 · 第 {n}/{total} 步：{step}",
    creationFailed: "{name} · 创建失败：{error}",
    creationStepInstall: "安装 DSH",
    creationStepPrepare: "准备",
    creationStepConfig: "创建空间配置",
    creationStepView: "安装视图组件",
    creationStepModels: "连接模型",
    creationFailedTitle: "空间「{name}」创建失败",
    creationViewTask: "查看任务",
    creationDismiss: "移除",
  },
  en: {
    rail: "Spaces",
    railCollapse: "Hide spaces bar",
    railExpand: "Show spaces bar",
    desktopMain: "Desktop · main space",
    desktopMainPinned: "Desktop · main space (always on top)",
    newSpace: "New space",
    operating: "busy",
    attention: "Needs attention",
    working: "Working",
    settings: "Settings",
    settingsStopped: "Settings · Spaces service stopped",
    settingsUnavailable: "Settings · space service unavailable (details)",
    dismissOperationError: "Dismiss the operation notice",
    guideLabel: "Space status",
    guideLoading: "Connecting to the space service…",
    guideStopping: "Stopping Spaces service…",
    guideStopped: "Spaces service stopped.",
    initialize: "Initialize Spaces",
    backToMain: "Back to main space",
    confirmInterruptLabel: "Confirm task interruption",
    stopTitle: "Stop {name}?",
    restartTitle: "Restart {name}?",
    confirmBusyBody: "This space has a running task. ",
    confirmUnknownBody: "Task activity could not be confirmed. ",
    confirmInterruptTail: "Continuing will interrupt running tasks.",
    cancel: "Cancel",
    stopSpace: "Stop space",
    restartSpace: "Restart space",
    openingSpace: "Opening space",
    stoppingSpace: "Stopping",
    restartingSpace: "Restarting",
    opening: "Opening",
    serviceOperation: "Spaces service operation",
    serviceManual: "Start / restart the Spaces service manually…",
    surfaceReload: "Reload Spaces view",
    surfaceReloading: "Reloading Spaces view…",
    surfaceReloadedNotice: "Spaces view reloaded.",
    surfaceReloadUnavailable: "Cannot reload the Spaces view right now.",
    surfaceReloadFailed: "Could not reload the Spaces view.",
    surfaceReloadServiceNotReady: "The Spaces service is not ready; cannot reload only the view.",
    serviceActionFailed: "Service operation failed.",
    servicePreviewReading: "Checking affected spaces…",
    serviceStopping: "Stopping Spaces service…",
    serviceStarting: "Starting Spaces service…",
    serviceRestarting: "Restarting Spaces service…",
    closeNotice: "Dismiss",
    serviceStopTitle: "Stop the Spaces service?",
    serviceRestartTitle: "Restart the Spaces service?",
    serviceStartTitle: "Start the Spaces service?",
    serviceStopBody: "Stops the service and the spaces below. Running tasks will be interrupted.",
    serviceRestartBody: "Restarts the service and stops the spaces below. Running tasks will be interrupted.",
    serviceStartBody: "Starts the Spaces service. Child spaces stay stopped.",
    serviceSpaceRunning: "running, will stop",
    serviceSpaceManaged: "stopped",
    serviceConfirmDetails: "Confirmation details",
    serviceConfirmValid: "Valid until {time}; reconfirm if space state changes.",
    serviceStopConfirm: "Stop service",
    serviceRestartConfirm: "Stop and restart service",
    serviceStartConfirm: "Start service",
    menuLabel: "Space actions",
    statusUnknown: "Status unknown",
    start: "Start",
    stop: "Stop",
    restart: "Restart",
    spaceSettings: "Space settings",
    statusRunning: "Running",
    statusStopped: "Stopped",
    statusStarting: "Starting",
    statusStopping: "Stopping",
    statusCrashed: "Exited unexpectedly",
    statusUnopened: "Not opened yet",
    statusOpening: "Opening",
    statusFailed: "Open failed",
    serviceCannotStop: "The service cannot be stopped right now.",
    serviceStopUnconfirmed: "The service stop result was not confirmed.",
    serviceStopFailed: "The service stop could not be confirmed. See details.",
    restartUnavailable: "Manual service start or restart is unavailable.",
    restartFailed: "The manual service operation failed.",
    serviceStartedNotice: "Spaces service started.",
    spaceStoppedNotice: "{name} stopped.",
    spaceRestartedNotice: "{name} restarted.",
    spaceStartedNotice: "{name} started.",
    spaceNotRunning: "This space is not running. Start it first.",
    spaceChangedRetry: "Space state changed. Please confirm again.",
    spaceActionFailed: "Space operation failed.",
    spaceViewFailed: "Could not open the space page.",
    createDialogFailed: "Could not open the new space dialog.",
    spaceSettingsFailed: "Could not open space settings.",
    serviceUnavailable: "The space service or page is unavailable.",
    guestContent: "Space content",
    desktopLaunchUnsupported: "Startup state is unavailable; whether the space service started could not be confirmed.",
    launchObservationEnded: "Startup state changed; launch observation ended.",
    selectionDeadline: "The space page did not answer the selection within 90 seconds.",
    selectionStageSuffix: " (Stages reached: {stages})",
    selectionLoadMismatch: "The space page could not complete the selection navigation.",
    guestOpenFailed: "The space page could not be opened.",
    guestInitialLoadTimeout: "The space page's initial load timed out after 15 seconds.",
    guestBootstrapFailed: "The Spaces entry could not be loaded into the space page.",
    guestLoadFailed: "The space page failed to load ({detail}).",
    guestProcessGone: "The space page's renderer exited ({detail}).",
    guestNavigatedAway: "The space page navigated away from the Spaces entry.",
    invalidPortalAddress: "The observed space page address was invalid.",
    portalFailureNoDetail: "The space page reported a failure without a reason.",
    browserResultFailed: "The space page's browser result could not be delivered.",
    hostRpcFailed: "Host RPC interrupted ({endpoint}{state}).",
    hostRpcConnectionSuffix: ", connection: {state}",
    failureTime: "Failed at: ",
    failurePrimary: "Failure",
    failureCleanup: "Stop result afterwards",
    failureInstance: "Process record",
    instanceRetainedYes: "The process record was kept.",
    instanceRetainedNo: "The process record was not kept.",
    startupLoading: "Connecting",
    startupDiscovering: "Checking",
    startupPreparing: "Preparing",
    startupLaunching: "Launching",
    startupStarting: "Starting",
    startupConnecting: "Attaching",
    startupIdle: "Idle",
    creationQueued: "{name} · Waiting to start",
    creationRunning: "{name} · Creating · step {n}/{total}: {step}",
    creationFailed: "{name} · Creation failed: {error}",
    creationStepInstall: "Installing DSH",
    creationStepPrepare: "Preparing",
    creationStepConfig: "Creating the space configuration",
    creationStepView: "Installing the view bridge",
    creationStepModels: "Connecting models",
    creationFailedTitle: "Creating “{name}” failed",
    creationViewTask: "View task",
    creationDismiss: "Remove",
  },
};

/** The native shell words for the current locale. */
export function nativeTexts(locale: SpacesLocale = inferSpacesLocale()): NativeShellTexts {
  return texts[locale];
}

/** Status text for a space row in the native rail and menu. */
export function nativeStatusText(status: string, texts: NativeShellTexts): string {
  switch (status) {
    case "running": return texts.statusRunning;
    case "stopped": return texts.statusStopped;
    case "starting": return texts.statusStarting;
    case "stopping": return texts.statusStopping;
    case "crashed": return texts.statusCrashed;
    case "unopened": return texts.statusUnopened;
    case "opening": return texts.statusOpening;
    case "failed": return texts.statusFailed;
    default: return texts.statusUnknown;
  }
}

/** Short rail copy for an in-progress startup phase. Terminal phases stay unlabeled. */
export function nativeStartupLabel(phase: string, texts: NativeShellTexts): string | null {
  switch (phase) {
    case "loading": return texts.startupLoading;
    case "discovering": return texts.startupDiscovering;
    case "preparing": return texts.startupPreparing;
    case "launching": return texts.startupLaunching;
    case "starting": return texts.startupStarting;
    case "connecting": return texts.startupConnecting;
    case "idle": return texts.startupIdle;
    default: return null;
  }
}
