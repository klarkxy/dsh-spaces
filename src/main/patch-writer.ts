import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { t } from "../shared/i18n";
import { atomicWrite } from "./atomic";
import { runDsh } from "./dsh-cli";

export const SESSION_ROW_ID = "session-persistence-jsonl";
export const STORAGE_ROW_ID = "storage-json";

export class PatchForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchForbiddenError";
  }
}

export class PatchVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchVerifyError";
  }
}

type PatchEntry = {
  id?: string;
  config?: { root?: unknown };
  [key: string]: unknown;
};

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
    const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
    writeFileSync(`${path}.bak-${stamp}`, original, "utf8");

    const docs = yaml.load(original) as unknown;
    const entries: PatchEntry[] = Array.isArray(docs) ? (docs as PatchEntry[]) : [];
    const others = entries.filter(
      (entry) => entry?.id !== SESSION_ROW_ID && entry?.id !== STORAGE_ROW_ID,
    );
    const header = [
      "# Your patch layer for this dsh profile, applied after every bundle layer.",
      "# DSH Spaces workbench isolation: dual-root overlay.",
    ];
    const othersYaml = others.length > 0 ? `${yaml.dump(others).trimEnd()}\n` : "";
    const body = `${header.join("\n")}
${othersYaml}- id: ${SESSION_ROW_ID}
  config:
    root: !!js dshHomePath('hub/${name}/sessions')
- id: ${STORAGE_ROW_ID}
  config:
    root: !!js dshHomePath('hub/${name}/storages')
`;
    atomicWrite(path, body);
  }

  async verify(name: string): Promise<void> {
    if (name === "web") return;
    const dump = await dumpConfig(this.dshHome, name);
    assertDumpPatched(dump, name);
  }
}

export function extractRoot(dump: string, id: string): string | null {
  const block = dump.split(`- id: ${id}`)[1];
  if (!block) return null;
  const match = block.match(/root:\s*(.+)/);
  return match?.[1]?.trim() ?? null;
}

export function assertDumpPatched(dump: string, name: string): void {
  const sessionRoot = extractRoot(dump, SESSION_ROW_ID);
  const storageRoot = extractRoot(dump, STORAGE_ROW_ID);
  const expectedSession = `dshHomePath('hub/${name}/sessions')`;
  const expectedStorage = `dshHomePath('hub/${name}/storages')`;
  if (!sessionRoot) {
    throw new PatchVerifyError(t("errors.missingDumpRow", { id: SESSION_ROW_ID, name }));
  }
  if (!storageRoot) {
    throw new PatchVerifyError(t("errors.missingDumpRow", { id: STORAGE_ROW_ID, name }));
  }
  if (!sessionRoot.includes(`hub/${name}/sessions`) && !sessionRoot.includes(expectedSession)) {
    throw new PatchVerifyError(
      t("errors.dumpRootMismatch", { id: SESSION_ROW_ID, actual: sessionRoot, name, kind: "sessions" }),
    );
  }
  if (!storageRoot.includes(`hub/${name}/storages`) && !storageRoot.includes(expectedStorage)) {
    throw new PatchVerifyError(
      t("errors.dumpRootMismatch", { id: STORAGE_ROW_ID, actual: storageRoot, name, kind: "storages" }),
    );
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

