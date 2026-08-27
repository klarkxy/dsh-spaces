import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Same-volume temp + rename. Do not use os.tmpdir() — Windows cross-drive rename fails. */
export function atomicWrite(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, "utf8");
  renameSync(tmp, filePath);
}
