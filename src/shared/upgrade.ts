export type UpgradePhase =
  | "drain"
  | "stop"
  | "snapshot"
  | "install"
  | "stage"
  | "verify"
  | "smoke"
  | "commit"
  | "rollback"
  | "done";

export interface MaintenanceStatus {
  busy: boolean;
  current?: string;
  mutations: number;
}

export interface OfficialPluginChange {
  name: string;
  from?: string;
  to?: string;
}

export interface UpgradeProfilePreview {
  name: string;
  official: OfficialPluginChange[];
  thirdParty: string[];
}

export interface UpgradePreview {
  version: string;
  currentVersion?: string;
  profiles: UpgradeProfilePreview[];
  officialTargets?: { base?: string; web?: string };
}

export interface UpgradeProgress {
  phase: UpgradePhase;
  detail?: string;
}

export interface UpgradeResult {
  version: string;
  snapshotId: string;
  profiles: string[];
  official: { base?: string; web?: string };
}
