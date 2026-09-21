/** Public product contracts. Jobs never carry local paths, archive bytes or credentials. Transient blueprint preview/generate responses may include receiver-local input values. */
import type { ConfigBackupMeta, DiagnosticLogEntry } from './diagnostics';
import type { SpaceImportResult, SpaceSharePreview, SpaceTemplate } from './space-share';
import type { LocalePreference, PackageSource, PluginCatalogSnapshot, PluginLibrarySource, ThemePreference } from './types';
import type { WorkbenchPackageRelease } from './workbench';
import type {
  WorkbenchBlueprintApplyCommand,
  WorkbenchBlueprintApplyOutcome,
  WorkbenchBlueprintGeneratePayload,
  WorkbenchBlueprintGenerateRequest,
  WorkbenchBlueprintInspectPayload,
  WorkbenchBlueprintInspectRequest,
  WorkbenchBlueprintPreviewPayload,
  WorkbenchBlueprintPreviewRequest,
  WorkbenchBlueprintSourcePayload,
  WorkbenchBlueprintSourceRequest,
} from './workbench-blueprint';

export const MAX_WORKBENCH_SHARE_BYTES = 8 * 1024 * 1024;
export const MAX_WORKBENCH_SHARE_BASE64 = Math.ceil(MAX_WORKBENCH_SHARE_BYTES / 3) * 4;
export const WORKBENCH_IMPORT_TTL_MS = 5 * 60_000;

export interface WorkbenchHomeSettings {
  portStart: number;
  portEnd: number;
  packageSource: PackageSource;
  catalogUrl: string;
}

export interface WorkbenchLibraryItem {
  id: string;
  packageName: string;
  title: string;
  version: string | null;
  source: PluginLibrarySource;
  downloadedAt: string;
  installedIn: string[];
}

export interface WorkbenchDiagnostics {
  spaceId: string;
  status: 'running' | 'starting' | 'stopping' | 'stopped' | 'crashed' | 'unknown';
  lastError?: string;
  logs: DiagnosticLogEntry[];
  logError?: string;
  backups: ConfigBackupMeta[];
}

export type WorkbenchProductRequest =
  | { method: 'settings' }
  | { method: 'catalog'; query?: string }
  | { method: 'library' }
  | { method: 'diagnostics'; spaceId: string }
  | { method: 'templates' }
  | { method: 'share.export'; spaceId: string; includeConfig?: boolean }
  | { method: 'share.previewImport'; archiveBase64: string }
  | WorkbenchBlueprintSourceRequest
  | WorkbenchBlueprintGenerateRequest
  | WorkbenchBlueprintInspectRequest
  | WorkbenchBlueprintPreviewRequest;

/** Read observations bind drafts to the state they displayed. */
export interface WorkbenchProductObservation {
  serviceEpoch: string;
  expectedRevision: string;
}

export type WorkbenchProductResult = (
  | { method: 'settings'; settings: WorkbenchHomeSettings; clientDefaults: { locale: LocalePreference; theme: ThemePreference } }
  | { method: 'catalog'; catalog: PluginCatalogSnapshot }
  | { method: 'library'; items: WorkbenchLibraryItem[] }
  | { method: 'diagnostics'; diagnostics: WorkbenchDiagnostics }
  | { method: 'templates'; templates: SpaceTemplate[] }
  | { method: 'share.export'; fileName: string; archiveBase64: string; preview: SpaceSharePreview }
  | { method: 'share.previewImport'; importId: string; expiresAt: string; preview: SpaceSharePreview }
  | WorkbenchBlueprintSourcePayload
  | WorkbenchBlueprintGeneratePayload
  | WorkbenchBlueprintInspectPayload
  | WorkbenchBlueprintPreviewPayload
) & { observation: WorkbenchProductObservation };

export type WorkbenchProductCommand =
  | { kind: 'workbench.prepare'; version?: string }
  | { kind: 'settings.update'; settings: WorkbenchHomeSettings }
  | { kind: 'catalog.refresh'; url?: string }
  | { kind: 'plugin.download'; catalogId?: string; spec?: string; version?: string }
  | { kind: 'plugin.library.remove'; libraryId: string }
  | { kind: 'template.save'; spaceId: string; name: string; includeConfig?: boolean }
  | { kind: 'template.create'; templateId: string; name: string; displayName?: string }
  | { kind: 'space.import'; importId: string; name: string; displayName?: string }
  | WorkbenchBlueprintApplyCommand;

/** This is safe to persist in succeeded or partially failed jobs. */
export type WorkbenchProductOutcome =
  | { kind: 'workbench.prepare'; candidate: WorkbenchPackageRelease }
  | { kind: 'settings.update'; settings: WorkbenchHomeSettings }
  | { kind: 'catalog.refresh'; count: number }
  | { kind: 'plugin.download'; item: WorkbenchLibraryItem }
  | { kind: 'plugin.library.remove'; libraryId: string }
  | { kind: 'template.save'; templateId: string }
  | { kind: 'template.create' | 'space.import'; import: SpaceImportResult }
  | WorkbenchBlueprintApplyOutcome;

export function isWorkbenchProductCommand(value: { kind: string }): value is WorkbenchProductCommand {
  return ['workbench.prepare', 'settings.update', 'catalog.refresh', 'plugin.download', 'plugin.library.remove',
    'template.save', 'template.create', 'space.import', 'blueprint.apply'].includes(value.kind);
}
