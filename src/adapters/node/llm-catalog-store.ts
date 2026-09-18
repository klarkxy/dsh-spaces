import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWrite } from "../../main/atomic";
import {
  LLM_ERROR,
  LlmConfigError,
  emptyCatalog,
  parseCatalog,
  type GlobalLlmCatalog,
} from "../../core/domain/llm-connections";
import type { LlmCatalogStore } from "../../core/ports/llm-store";
import { withExclusiveDir } from "./llm-file-lock";
import { LLM_CATALOG_FILENAME, llmCatalogPath, llmControlDir } from "./llm-paths";

export { LLM_CATALOG_FILENAME, llmCatalogPath, llmControlDir } from "./llm-paths";

export class FileLlmCatalogStore implements LlmCatalogStore {
  constructor(private readonly home: string) {}

  async read(): Promise<GlobalLlmCatalog> {
    return readCatalogFile(llmCatalogPath(this.home));
  }

  async write(next: GlobalLlmCatalog, expectedRevision: number): Promise<GlobalLlmCatalog> {
    const path = llmCatalogPath(this.home);
    return withExclusiveDir(join(llmControlDir(this.home), `${LLM_CATALOG_FILENAME}.lock`), () => {
      const current = readCatalogFile(path);
      if (current.revision !== expectedRevision) {
        throw new LlmConfigError(LLM_ERROR.REVISION_CONFLICT, "catalog revision moved", {
          expected: expectedRevision,
          actual: current.revision,
        });
      }
      if (next.revision !== expectedRevision + 1) {
        throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "catalog write must increment revision by one");
      }
      const parsed = parseCatalog(next);
      atomicWrite(path, `${JSON.stringify(parsed, null, 2)}\n`);
      return parsed;
    });
  }
}

export function assertCatalogPathInsideHome(home: string, path: string): void {
  const root = resolve(llmControlDir(home));
  const target = resolve(path);
  if (target !== join(root, LLM_CATALOG_FILENAME) && !target.startsWith(`${root}/`)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "catalog path escaped the control home");
  }
  if (dirname(target) !== root) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "catalog must live in the llm control directory");
  }
}

function readCatalogFile(path: string): GlobalLlmCatalog {
  if (!existsSync(path)) return emptyCatalog();
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "catalog file is not valid JSON");
  }
  return parseCatalog(value);
}
