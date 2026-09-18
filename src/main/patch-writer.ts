import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { t } from "../shared/i18n";
import {
  PatchForbiddenError,
  PatchVerifyError,
  applyIsolationPatch,
  assertDumpPatched,
} from "../core/domain/isolation";
import { atomicWrite } from "./atomic";
import { runDsh } from "./dsh-cli";

export {
  SESSION_ROW_ID,
  STORAGE_ROW_ID,
  SETTINGS_ROW_ID,
  CREDENTIALS_ROW_ID,
  PatchForbiddenError,
  PatchVerifyError,
  applyIsolationPatch,
  assertDumpPatched,
  assertDumpConfigIsolated,
  configPathExpr,
  extractConfigField,
  extractRoot,
  isExpectedIsolationPath,
  isExpectedIsolationRoot,
  isolationExpr,
  patchTextLooksConfigIsolated,
  patchTextLooksIsolated,
} from "../core/domain/isolation";

export class PatchWriter {
  constructor(private readonly dshHome: string) {}

  patchPath(name: string): string {
    return join(this.dshHome, "profiles", name, "cordis.patch.yml");
  }

  ensureWorkbenchPatch(name: string): void {
    if (name === "web") {
      throw new PatchForbiddenError(t("errors.webSacred"));
    }
    const path = this.patchPath(name);
    if (!existsSync(path)) {
      throw new Error(t("errors.missingPatch", { path }));
    }
    const original = readFileSync(path, "utf8");
    const body = applyIsolationPatch(original, name, path);
    const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
    writeFileSync(`${path}.bak-${stamp}-${randomUUID()}`, original, { encoding: "utf8", flag: "wx" });
    atomicWrite(path, body);
  }

  async verify(name: string): Promise<void> {
    if (name === "web") return;
    const dump = await dumpConfig(this.dshHome, name);
    assertDumpPatched(dump, name);
  }
}

export async function dumpConfig(dshHome: string, name: string): Promise<string> {
  return runDsh(dshHome, ["--profile", name, "--dump-config"], { timeoutMs: 30_000 }).then(
    ({ stdout, stderr, code }) => {
      if (code !== 0) {
        throw new PatchVerifyError(t("errors.dumpConfigFailed", { code, detail: stderr.slice(0, 400) }));
      }
      return stdout;
    },
  );
}
