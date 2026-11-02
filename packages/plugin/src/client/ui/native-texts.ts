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
  desktopMain: string;
  desktopMainPinned: string;
  newSpace: string;
  scopeHelpLabel: string;
  scopeHelpHint: string;
  operating: string;
  settings: string;
  settingsStopped: string;
  settingsUnavailable: string;
  dismissOperationError: string;
  guideLabel: string;
  guideLoading: string;
  guidePreparing: string;
  guideStopping: string;
  guideStopped: string;
  guideLaunching: string;
  guideInitialize: string;
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
  scopeHelpTitle: string;
  scopeHelpClose: string;
  scopeHelpQuit: string;
  scopeHelpStopSpace: string;
  scopeHelpStopService: string;
  scopeHelpNote: string;
  scopeHelpOk: string;
  scopeHelpGoSettings: string;
  openingSpace: string;
  stoppingSpace: string;
  restartingSpace: string;
  opening: string;
  launchingService: string;
  serviceOperation: string;
  serviceManual: string;
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
  serviceMainSpaceNote: string;
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
  serviceUnavailable: string;
  guestContent: string;
  desktopLaunchUnsupported: string;
  launchObservationEnded: string;
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
}

const texts: Record<SpacesLocale, NativeShellTexts> = {
  zh: {
    rail: "空间",
    desktopMain: "Desktop · 主空间",
    desktopMainPinned: "Desktop · 主空间（始终置顶）",
    newSpace: "新建空间",
    scopeHelpLabel: "运行与退出说明",
    scopeHelpHint: "退出 Desktop 后，Spaces 仍在后台运行；点击查看停止范围",
    operating: "操作中",
    settings: "设置",
    settingsStopped: "设置 · Spaces 服务已停止",
    settingsUnavailable: "设置 · 空间服务不可用（查看详情）",
    dismissOperationError: "关闭操作提示",
    guideLabel: "空间状态",
    guideLoading: "正在连接空间服务…",
    guidePreparing: "正在准备 Spaces 管理服务及所需组件，首次初始化可能需要几分钟…",
    guideStopping: "正在停止 Spaces 服务，并确认停机结果…",
    guideStopped: "Spaces 服务已停止。会话记录保留，Desktop 主空间仍可使用。",
    guideLaunching: "Spaces 管理服务没有在运行，正在随本次打开启动它…",
    guideInitialize: "初始化独立的 Spaces 管理服务后，即可在这里切换空间。",
    initialize: "初始化 Spaces",
    backToMain: "返回主空间",
    confirmInterruptLabel: "确认任务中断影响",
    stopTitle: "停止 {name}？",
    restartTitle: "重启 {name}？",
    confirmBusyBody: "这个空间有正在执行的任务。",
    confirmUnknownBody: "无法确认这个空间是否还有正在执行的任务。",
    confirmInterruptTail: "继续操作会中断任务，会话记录保留，中断的任务不会自动继续。",
    cancel: "取消",
    stopSpace: "停止空间",
    restartSpace: "重启空间",
    scopeHelpTitle: "关闭、退出和停止的区别",
    scopeHelpClose: "关闭窗口（×）：收起到托盘，Desktop 和空间继续运行。",
    scopeHelpQuit: "退出 Desktop：退出主空间；Spaces 和子空间仍在后台运行。使用主空间模型的子空间需要 Desktop 保持打开。",
    scopeHelpStopSpace: "停止空间：仅停止所选空间；正在执行的任务会中断。",
    scopeHelpStopService: "停止整个服务：停止管理服务及其管理的所有空间，Desktop 主空间保持打开。",
    scopeHelpNote: "会话记录会保留。退出 Desktop 后，子空间里未发送的输入和附件会丢失。中断的任务不会自动继续。",
    scopeHelpOk: "知道了",
    scopeHelpGoSettings: "前往服务设置",
    openingSpace: "正在打开空间",
    stoppingSpace: "正在停止",
    restartingSpace: "正在重启",
    opening: "正在打开",
    launchingService: "正在启动 Spaces 服务",
    serviceOperation: "Spaces 服务操作",
    serviceManual: "手动启动 / 重启 Spaces 服务…",
    serviceActionFailed: "服务操作失败，未自动重试。",
    servicePreviewReading: "正在读取服务和受影响空间…",
    serviceStopping: "正在停止 Spaces 服务及其空间，并确认完成…",
    serviceStarting: "正在启动 Spaces 管理服务…",
    serviceRestarting: "正在正常停止旧服务并启动一次新服务…",
    closeNotice: "关闭提示",
    serviceStopTitle: "停止 Spaces 服务？",
    serviceRestartTitle: "重启 Spaces 服务？",
    serviceStartTitle: "启动 Spaces 服务？",
    serviceStopBody: "将停止以下空间和 Spaces 管理服务。运行中的任务会中断，会话记录保留；再次启动后不会自动继续任务。",
    serviceRestartBody: "将停止当前 Spaces 服务及以下空间，再启动管理服务。运行中的任务会中断；子空间保持停止，不自动继续任务。",
    serviceStartBody: "当前没有存活的 Spaces 服务。将启动管理服务，子空间保持停止，中断的任务不会继续。",
    serviceMainSpaceNote: "Desktop 主空间保持打开。退出 Desktop 不会停止这些后台空间，但使用主空间模型的空间需要 Desktop 保持运行。",
    serviceSpaceRunning: "运行中，将停止",
    serviceSpaceManaged: "已由此服务管理",
    serviceConfirmDetails: "查看确认信息",
    serviceConfirmValid: "有效期至 {time}；空间状态发生变化后需要重新确认。",
    serviceStopConfirm: "停止服务",
    serviceRestartConfirm: "停止并重启服务",
    serviceStartConfirm: "启动服务",
    menuLabel: "空间操作",
    statusUnknown: "状态未知",
    start: "启动",
    stop: "停止",
    restart: "重启",
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
    serviceStartedNotice: "Spaces 服务已启动，子空间保持停止。可从左侧选择空间启动。",
    spaceStoppedNotice: "{name} 已停止。会话记录保留。",
    spaceRestartedNotice: "{name} 已重启。会话记录保留，中断的任务不会继续。",
    spaceStartedNotice: "{name} 已启动。",
    spaceNotRunning: "该空间尚未运行。请在设置中明确启动。",
    spaceChangedRetry: "空间已发生变化，请重新确认操作。",
    spaceActionFailed: "空间操作失败。该次请求没有重发。",
    spaceViewFailed: "空间页面未能打开，该次操作已失败。",
    createDialogFailed: "新建空间对话框未能打开，该次操作已失败。",
    serviceUnavailable: "空间服务或页面不可用。该次连接已停止，主空间仍可使用。",
    guestContent: "空间内容",
    desktopLaunchUnsupported: "当前 Desktop 无法提供所需的启动状态，空间服务是否已启动无法确认。",
    launchObservationEnded: "启动操作或空间服务已变化，本次启动观察已结束。",
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
  },
  en: {
    rail: "Spaces",
    desktopMain: "Desktop · main space",
    desktopMainPinned: "Desktop · main space (always on top)",
    newSpace: "New space",
    scopeHelpLabel: "Run and quit behaviour",
    scopeHelpHint: "Spaces keeps running after Desktop quits; click to see what stops",
    operating: "busy",
    settings: "Settings",
    settingsStopped: "Settings · Spaces service stopped",
    settingsUnavailable: "Settings · space service unavailable (details)",
    dismissOperationError: "Dismiss the operation notice",
    guideLabel: "Space status",
    guideLoading: "Connecting to the space service…",
    guidePreparing: "Preparing the Spaces manager service and its components. First-time setup can take a few minutes…",
    guideStopping: "Stopping the Spaces service and confirming the shutdown…",
    guideStopped: "The Spaces service is stopped. Conversation history is kept; the Desktop main space stays usable.",
    guideLaunching: "The Spaces manager service is not running; it is starting with this launch…",
    guideInitialize: "Initialize the independent Spaces manager service to switch spaces here.",
    initialize: "Initialize Spaces",
    backToMain: "Back to main space",
    confirmInterruptLabel: "Confirm task interruption",
    stopTitle: "Stop {name}?",
    restartTitle: "Restart {name}?",
    confirmBusyBody: "This space has a task in progress.",
    confirmUnknownBody: "Whether this space still has a task in progress could not be confirmed.",
    confirmInterruptTail: "Continuing interrupts the task. Conversation history is kept; an interrupted task does not resume automatically.",
    cancel: "Cancel",
    stopSpace: "Stop space",
    restartSpace: "Restart space",
    scopeHelpTitle: "Close, quit and stop",
    scopeHelpClose: "Closing the window (×) hides Desktop to the tray; Desktop and spaces keep running.",
    scopeHelpQuit: "Quitting Desktop exits the main space; Spaces and child spaces keep running in the background. Spaces using the main space model need Desktop to stay open.",
    scopeHelpStopSpace: "Stopping a space stops only that space; a running task is interrupted.",
    scopeHelpStopService: "Stopping the whole service stops the manager and every space it manages; the Desktop main space stays open.",
    scopeHelpNote: "Conversation history is kept. After quitting Desktop, unsent input and attachments in child spaces are lost. Interrupted tasks do not resume automatically.",
    scopeHelpOk: "Got it",
    scopeHelpGoSettings: "Open service settings",
    openingSpace: "Opening space",
    stoppingSpace: "Stopping",
    restartingSpace: "Restarting",
    opening: "Opening",
    launchingService: "Starting the Spaces service",
    serviceOperation: "Spaces service operation",
    serviceManual: "Start / restart the Spaces service manually…",
    serviceActionFailed: "The service operation failed; it was not retried.",
    servicePreviewReading: "Reading the service and the affected spaces…",
    serviceStopping: "Stopping the Spaces service and its spaces, and confirming completion…",
    serviceStarting: "Starting the Spaces manager service…",
    serviceRestarting: "Stopping the old service normally and starting a new one…",
    closeNotice: "Dismiss",
    serviceStopTitle: "Stop the Spaces service?",
    serviceRestartTitle: "Restart the Spaces service?",
    serviceStartTitle: "Start the Spaces service?",
    serviceStopBody: "The spaces below and the Spaces manager service will stop. Running tasks are interrupted; conversation history is kept and tasks do not resume on the next start.",
    serviceRestartBody: "The current Spaces service and the spaces below will stop, then the manager service starts. Running tasks are interrupted; child spaces stay stopped and tasks do not resume.",
    serviceStartBody: "No live Spaces service was found. The manager service will start; child spaces stay stopped and interrupted tasks do not resume.",
    serviceMainSpaceNote: "The Desktop main space stays open. Quitting Desktop does not stop these background spaces, but spaces using the main space model need Desktop running.",
    serviceSpaceRunning: "running, will stop",
    serviceSpaceManaged: "managed by this service",
    serviceConfirmDetails: "Confirmation details",
    serviceConfirmValid: "Valid until {time}; the confirmation must be requested again after a space state change.",
    serviceStopConfirm: "Stop service",
    serviceRestartConfirm: "Stop and restart service",
    serviceStartConfirm: "Start service",
    menuLabel: "Space actions",
    statusUnknown: "Status unknown",
    start: "Start",
    stop: "Stop",
    restart: "Restart",
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
    serviceStartedNotice: "The Spaces service started; child spaces stay stopped. Pick a space on the left to start it.",
    spaceStoppedNotice: "{name} stopped. Conversation history is kept.",
    spaceRestartedNotice: "{name} restarted. Conversation history is kept; the interrupted task does not resume.",
    spaceStartedNotice: "{name} started.",
    spaceNotRunning: "This space is not running. Start it explicitly in settings.",
    spaceChangedRetry: "The space changed. Confirm the operation again.",
    spaceActionFailed: "The space operation failed. The request was not resent.",
    spaceViewFailed: "The space page could not open; that operation failed.",
    createDialogFailed: "The new space dialog could not open; that operation failed.",
    serviceUnavailable: "The space service or page is unavailable. This connection was stopped; the main space stays usable.",
    guestContent: "Space content",
    desktopLaunchUnsupported: "This Desktop cannot provide the required startup state. Whether the space service has started could not be confirmed.",
    launchObservationEnded: "The startup operation or space service has changed. Observation of this launch has ended.",
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
