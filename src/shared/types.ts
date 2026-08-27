export type ProfileKind = "root" | "workbench" | "hidden";

export type ProfileStatus = "stopped" | "starting" | "running" | "crashed";

export interface SpaceMeta {
  displayName: string;
  icon?: string;
  order: number;
}

export interface ProfileRecord {
  name: string;
  kind: ProfileKind;
  path: string;
  hasWebApp: boolean;
  needsConversion: boolean;
  meta: SpaceMeta;
  status: ProfileStatus;
  port?: number;
  lastError?: string;
}

export interface SpacesFile {
  version: 1;
  onboarded?: boolean;
  order: string[];
  meta: Record<string, SpaceMeta>;
}

export type QuitBehavior = "stop" | "keep";

export interface HubSettings {
  portStart: number;
  portEnd: number;
  quitBehavior: QuitBehavior;
}

export interface OnboardingProfile {
  name: string;
  kind: ProfileKind;
  action: "adopt-root" | "convert-workbench" | "already-workbench" | "hide";
}

export interface OnboardingScan {
  onboarded: boolean;
  dshHome: string;
  profiles: OnboardingProfile[];
}

export type CreateStep = "validate" | "plugin" | "patch" | "verify" | "meta";

export interface CreateProgress {
  step: CreateStep;
  message: string;
}

export interface PluginQueueSnapshot {
  pending: number;
  current?: string;
}

export const RESERVED_PROFILE_NAMES = ["web", "hub", "headless", "node_modules"] as const;

export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

export const PRESET_ICONS = [
  "code",
  "pencil",
  "terminal",
  "folder",
  "sparkles",
  "bot",
  "book",
  "wrench",
  "globe",
  "music",
] as const;

export type PresetIcon = (typeof PRESET_ICONS)[number];

export const DEFAULT_HUB_SETTINGS: HubSettings = {
  portStart: 3100,
  portEnd: 3199,
  quitBehavior: "stop",
};

export const ONBOARDING_NOTICE = "你的历史聊天统一由 web 维护，工作台从全新会话开始";
