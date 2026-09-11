import type { RuntimeInventory } from "./runtime";
import type { SnapshotMeta } from "./snapshots";

export interface MaintenanceView {
  inventory: RuntimeInventory;
  snapshots: SnapshotMeta[];
  profiles: string[];
  operation?: string;
  error?: string;
}
