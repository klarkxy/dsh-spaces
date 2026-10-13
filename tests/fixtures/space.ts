import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spaceIdFromName } from "../../src/shared/types.ts";

/**
 * Shared fixture: a space exists only when hub/spaces.json registered it.
 * `id` is the full space id (`space-<name>`); use `spaceIdFromName` to derive it.
 */
export function writeRegisteredSpace(
  home: string,
  id: string,
  options: {
    pkg?: unknown;
    displayName?: string;
    dshVersion?: string;
    createdAt?: string;
    order?: number;
    icon?: string;
    /** Write hub/<id>/ as the space data dir. */
    hubData?: boolean;
  } = {},
): string {
  const dir = join(home, "profiles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      options.pkg ?? { dsh: { profile: { bundles: ["@deepseek-ai/dsh-web-app"] } } },
    ),
    "utf8",
  );
  const spacesPath = join(home, "hub", "spaces.json");
  const spaces = existsSync(spacesPath)
    ? (JSON.parse(readFileSync(spacesPath, "utf8")) as {
        version: 1;
        order: string[];
        meta: Record<string, Record<string, unknown>>;
      })
    : { version: 1 as const, order: [] as string[], meta: {} as Record<string, Record<string, unknown>> };
  const displayName = options.displayName ?? (id.startsWith("space-") ? id.slice(6) : id);
  const meta: Record<string, unknown> = {
    displayName,
    order: options.order ?? 1000,
    createdAt: options.createdAt ?? "2025-01-01T00:00:00.000Z",
  };
  if (options.dshVersion !== undefined) meta.dshVersion = options.dshVersion;
  if (options.icon !== undefined) meta.icon = options.icon;
  spaces.meta[id] = meta;
  if (!spaces.order.includes(id)) spaces.order.push(id);
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(spacesPath, `${JSON.stringify(spaces, null, 2)}\n`, "utf8");
  if (options.hubData) mkdirSync(join(home, "hub", id), { recursive: true });
  return id;
}

/** A plain profile directory that is NOT a registered space. */
export function writeOrdinaryProfile(home: string, name: string, pkg: unknown = {}): string {
  const dir = join(home, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg), "utf8");
  return name;
}

export { spaceIdFromName };
