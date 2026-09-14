import type {
  CreateSpaceInput,
  SpaceDetail,
  SpaceSummary,
  SpacesCapabilities,
  SpacesControlApi,
  VerifySpaceResult,
} from "../../../../src/shared/spaces-control";
import { displayMessage } from "./remote";

/** Display-safe strings only: every error field below is pre-sanitized. */

export interface OverviewState {
  status: "loading" | "ready" | "error";
  capabilities: SpacesCapabilities | null;
  spaces: SpaceSummary[];
  error: string | null;
  /** True while a refresh runs on top of already-visible data. */
  refreshing: boolean;
}

export interface DetailState {
  id: string;
  status: "loading" | "ready" | "error";
  detail: SpaceDetail | null;
  error: string | null;
  verifying: boolean;
  verifyResult: VerifySpaceResult | null;
  verifyError: string | null;
}

export interface CreateState {
  pending: boolean;
  error: string | null;
}

export interface SpacesPanelSnapshot {
  overview: OverviewState;
  selectedId: string | null;
  detail: DetailState | null;
  create: CreateState;
}

const initialOverview: OverviewState = {
  status: "loading",
  capabilities: null,
  spaces: [],
  error: null,
  refreshing: false,
};

const initialCreate: CreateState = { pending: false, error: null };

const CREATE_DENIED_MESSAGE = "Creation is not available in the current mode.";

/**
 * Framework-free panel store.
 *
 * Staleness discipline: two independent generation counters.
 * - `overviewGeneration` invalidates superseded overview refreshes.
 * - `detailGeneration` is incremented by EVERY detail load (including a
 *   same-selection reload after refresh) and by selection clears, so a
 *   slow response for an older request — even for the still-selected id —
 *   can never overwrite a newer one.
 * Capability gates are evaluated against the latest snapshot at call time
 * and require explicit `true`; unknown or stale-replaced capabilities never
 * enable a control.
 */
export class SpacesPanelStore {
  private snapshot: SpacesPanelSnapshot = {
    overview: initialOverview,
    selectedId: null,
    detail: null,
    create: initialCreate,
  };

  private readonly listeners = new Set<() => void>();
  private overviewGeneration = 0;
  private selectionGeneration = 0;
  private detailGeneration = 0;

  constructor(private readonly remote: SpacesControlApi) {}

  getSnapshot = (): SpacesPanelSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(patch: Partial<SpacesPanelSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Load or reload the overview. Keeps current data visible while refreshing. */
  refresh = async (): Promise<void> => {
    const generation = ++this.overviewGeneration;
    const hadData = this.snapshot.overview.status === "ready";
    this.emit({
      overview: {
        ...this.snapshot.overview,
        status: hadData ? "ready" : "loading",
        refreshing: true,
        error: null,
      },
    });
    try {
      const overview = await this.remote.overview();
      if (generation !== this.overviewGeneration) return;
      const spaces = Array.isArray(overview.spaces) ? overview.spaces : [];
      this.emit({
        overview: {
          status: "ready",
          capabilities: overview.capabilities ?? null,
          spaces,
          error: null,
          refreshing: false,
        },
      });
      this.reconcileSelection(spaces);
    } catch (error) {
      if (generation !== this.overviewGeneration) return;
      const current = this.snapshot.overview;
      this.emit({
        overview: {
          ...current,
          status: current.status === "ready" ? "ready" : "error",
          error: displayMessage(error),
          refreshing: false,
        },
      });
    }
  };

  /** After a successful overview, repair or establish the selection. */
  private reconcileSelection(spaces: SpaceSummary[]): void {
    const selectedId = this.snapshot.selectedId;
    if (selectedId !== null && spaces.some((space) => space.id === selectedId)) {
      this.loadDetail(selectedId);
      return;
    }
    const first = spaces[0];
    this.select(first ? first.id : null);
  }

  /** Select a space (or clear with null) and load its detail. */
  select = (id: string | null): void => {
    const current = this.snapshot.detail;
    if (id !== null && this.snapshot.selectedId === id && current?.status === "ready") return;
    ++this.selectionGeneration;
    if (id === null) {
      ++this.detailGeneration;
      this.emit({ selectedId: null, detail: null });
      return;
    }
    this.emit({ selectedId: id });
    this.loadDetail(id);
  };

  /** Start a detail load; every call invalidates all previous detail requests. */
  private loadDetail(id: string): void {
    const generation = ++this.detailGeneration;
    const current = this.snapshot.detail;
    this.emit({
      detail:
        current?.id === id
          ? { ...current, status: "loading", error: null }
          : {
              id,
              status: "loading",
              detail: null,
              error: null,
              verifying: false,
              verifyResult: null,
              verifyError: null,
            },
    });
    void this.fetchDetail(id, generation);
  }

  private async fetchDetail(id: string, generation: number): Promise<void> {
    const isCurrent = (): boolean =>
      generation === this.detailGeneration && this.snapshot.selectedId === id;
    try {
      const detail = await this.remote.detail(id);
      if (!isCurrent()) return;
      const prior = this.snapshot.detail;
      const keepVerify = prior?.id === id;
      this.emit({
        detail: {
          id,
          status: "ready",
          detail,
          error: null,
          verifying: keepVerify ? prior.verifying : false,
          verifyResult: keepVerify ? prior.verifyResult : null,
          verifyError: keepVerify ? prior.verifyError : null,
        },
      });
    } catch (error) {
      if (!isCurrent()) return;
      this.emit({
        detail: {
          id,
          status: "error",
          detail: null,
          error: displayMessage(error),
          verifying: false,
          verifyResult: null,
          verifyError: null,
        },
      });
    }
  }

  /**
   * Create a non-host space. Requires capabilities.canCreate === true at call
   * time; otherwise the transport is never invoked. The backend still denies
   * host mutation independently.
   */
  createSpace = async (input: CreateSpaceInput): Promise<void> => {
    if (this.snapshot.create.pending) return;
    if (this.snapshot.overview.capabilities?.canCreate !== true) {
      this.emit({ create: { pending: false, error: CREATE_DENIED_MESSAGE } });
      return;
    }
    this.emit({ create: { pending: true, error: null } });
    try {
      const created = await this.remote.create(input);
      this.emit({ create: { pending: false, error: null } });
      await this.refresh();
      this.select(created.id);
    } catch (error) {
      this.emit({ create: { pending: false, error: displayMessage(error) } });
    }
  };

  /**
   * Verify the selected space. Non-host only and requires
   * capabilities.canVerify === true; otherwise a no-op.
   */
  verifySelected = async (): Promise<void> => {
    const { detail, overview } = this.snapshot;
    if (!detail || detail.status !== "ready" || detail.verifying) return;
    if (!detail.detail || detail.detail.space.isHost) return;
    if (overview.capabilities?.canVerify !== true) return;
    const id = detail.id;
    const generation = this.selectionGeneration;
    this.emit({ detail: { ...detail, verifying: true, verifyResult: null, verifyError: null } });
    try {
      const verifyResult = await this.remote.verify(id);
      if (generation !== this.selectionGeneration || this.snapshot.selectedId !== id) return;
      const current = this.snapshot.detail;
      if (!current || current.id !== id) return;
      this.emit({ detail: { ...current, verifying: false, verifyResult, verifyError: null } });
    } catch (error) {
      if (generation !== this.selectionGeneration || this.snapshot.selectedId !== id) return;
      const current = this.snapshot.detail;
      if (!current || current.id !== id) return;
      this.emit({ detail: { ...current, verifying: false, verifyError: displayMessage(error) } });
    }
  };
}
