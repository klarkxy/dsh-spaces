import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Same-volume temp + rename. Do not use os.tmpdir() — Windows cross-drive rename fails. */
export function atomicWrite(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, "utf8");
  renameSync(tmp, filePath);
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
