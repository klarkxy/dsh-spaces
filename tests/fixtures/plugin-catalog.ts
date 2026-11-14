import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import catalog from "./plugin-catalog.json" with { type: "json" };
import { parseCatalog } from "../../src/adapters/node/products/plugin-catalog.ts";

export const testCatalog = parseCatalog(catalog);

export function writeTestCatalog(home: string): void {
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(join(home, "hub", "plugin-catalog.json"), JSON.stringify(testCatalog));
}
