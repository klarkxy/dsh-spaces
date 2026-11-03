import type { BlueprintRecipe as Blueprint } from "@klarkxy/dsh-blueprint/document";
import type { BlueprintInputValues, BlueprintPackage } from "@klarkxy/dsh-blueprint/v1/types";
import type { LlmApiRequest, LlmApiResult } from "../../../../shared/llm-api";
import type { WorkbenchSpace } from "../../../../shared/workbench";
import type { WorkbenchProductObservation } from "../../../../shared/workbench-product";
import type { BlueprintOriginRecord } from "../../../../shared/workbench-blueprint";
import type { PreparedBlueprintPackage } from "../blueprint-package";
import type { PluginFetcher } from "../../products/plugin-ops";
import type { WorkbenchJobContext } from "../../maintenance/workbench-jobs";

export type BlueprintCreateInput = { name: string; displayName?: string; icon?: string };

export type BlueprintRuntimeOptions = { home: string; bin: string; builtinPackages?: string[] };

export type BlueprintRuntimeInspect = {
  versions: { dsh: string | null; base: string | null; webApp: string | null };
  baseLayers: Array<{ name: string; version: string; packageDir: string; patchPath: string; patches: unknown[] }>;
  builtinLayers?: Array<{ name: string; version: string; packageDir: string; patchPath: string; patches: unknown[] }>;
  builtinCatalog?: string[];
  baseEntries: unknown[];
  homePatches: unknown[];
  fingerprint: string;
};

export type BlueprintRuntimeLayerIdentity = {
  name: string;
  version: string;
};

export type BlueprintRuntimeCompose = {
  versions: { dsh: string | null; base: string | null; webApp: string | null };
  layers: BlueprintRuntimeLayerIdentity[];
  entries: unknown[];
  warnings: string[];
  fingerprint: string;
};

export type BlueprintRuntimeModule = {
  packageName: string;
  packageVersion: string | null;
  resolvedPath: string | null;
  builtin: boolean;
};

export interface BlueprintWorkbenchPorts {
  home: string;
  observation(): WorkbenchProductObservation;
  managerId(): string | null;
  listSpaces(): WorkbenchSpace[];
  createSpace(input: BlueprintCreateInput, ctx: WorkbenchJobContext): Promise<unknown>;
  installPlugin(spaceId: string, spec: string): Promise<void>;
  llm(request: LlmApiRequest): Promise<LlmApiResult>;
  now?(): Date;
  fetchImpl?: PluginFetcher;
  writePatch?(spaceId: string, patch: string): void;
  dshVersion?(): string | null;
  spacesVersion?(): string | null;
  llmBridgeAvailable?(): boolean;
  llmAdmitted?(request: LlmApiRequest): Promise<LlmApiResult>;
  llmCatalogObservation?(): { revision: number; digest: string };
  runtimeBin?(spaceId?: string): string | undefined;
  inspectRuntime?(options: BlueprintRuntimeOptions): Promise<BlueprintRuntimeInspect>;
  composeRuntime?(
    options: BlueprintRuntimeOptions,
    input: { spaceId: string; bundles: string[]; patch: unknown[] },
  ): Promise<BlueprintRuntimeCompose>;
  resolveModule?(
    options: BlueprintRuntimeOptions,
    input: { spaceId: string; specifier: string },
  ): Promise<BlueprintRuntimeModule>;
  prepareBlueprintPackage?(
    home: string,
    pkg: BlueprintPackage,
    options?: { fetchImpl?: PluginFetcher; signal?: AbortSignal },
  ): Promise<PreparedBlueprintPackage>;
}

export type PlanObservation = {
  serviceEpoch: string;
  stateRevision: string;
  dshVersion: string | null;
  hostBaseVersion: string | null;
  hostWebAppVersion: string | null;
  homeSettingsDigest: string;
  homePatchDigest: string;
  runtimeFingerprint: string;
  llmCatalogRevision: number;
  llmCatalogDigest: string;
};

export type StagedPlan = {
  id: string;
  epoch: string;
  expiresAt: number;
  bytes: number;
  consumed: boolean;
  blueprint: Blueprint;
  name: string;
  displayName?: string;
  values: BlueprintInputValues;
  observation: PlanObservation;
};

export type OriginRecipe = Omit<BlueprintOriginRecord, "blueprint"> & { blueprint: Blueprint };

export type ProfileManifest = { dependencies: Record<string, string>; bundles: string[] };

export type InstalledManifest = { name: string; version: string; hasBundle: boolean; lifecycleScripts: string[]; dependencies: string[] };

export type ModuleIdentityEvidence = { name: string; version: string | null };
