import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname } from "node:path";

/** Same-volume temp + rename. Do not use os.tmpdir() — Windows cross-drive rename fails. */
export function atomicWrite(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, "utf8");
  renameDirectory(tmp, filePath);
}

/** Windows scanners can briefly deny a directory rename immediately after writes. */
export function renameDirectory(source: string, destination: string): void {
  const deadline = Date.now() + 500;
  for (;;) {
    try { renameSync(source, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/** Main-thread counterpart: scanner contention must not suspend the HTTP loop. */
export async function renameDirectoryAsync(source: string, destination: string): Promise<void> {
  const deadline = Date.now() + 500;
  for (;;) {
    try { await rename(source, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || Date.now() >= deadline) throw error;
      await delay(25);
    }
  }
}
