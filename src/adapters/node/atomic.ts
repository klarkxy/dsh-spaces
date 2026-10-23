import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { dirname } from "node:path";

/** Same-volume temp + rename. Do not use os.tmpdir() — Windows cross-drive rename fails. */
export function atomicWrite(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, "utf8");
  renameDirectory(tmp, filePath);
}

/** A failed atomic publication is reported unchanged, without retrying. */
export function renameDirectory(source: string, destination: string): void {
  renameSync(source, destination);
}

/** Async publication has the same single-attempt failure boundary. */
export async function renameDirectoryAsync(source: string, destination: string): Promise<void> {
  await rename(source, destination);
}
