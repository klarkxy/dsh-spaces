import type { CreateProgress } from "../shared/types";
import { addWebApp } from "./dsh-cli";
import { PatchWriter } from "./patch-writer";
import { ProfileRegistry } from "./profile-registry";

export async function createProfile(
  dshHome: string,
  registry: ProfileRegistry,
  patchWriter: PatchWriter,
  name: string,
  displayName: string | undefined,
  onProgress?: (progress: CreateProgress) => void,
): Promise<void> {
  const emit = (step: CreateProgress["step"], message: string) => onProgress?.({ step, message });
  emit("validate", "Validating name…");
  registry.validateNewName(name);
  emit("plugin", "Installing @deepseek-ai/dsh-web-app (queued)…");
  await addWebApp(dshHome, name);
  emit("patch", "Writing dual-root isolation patch…");
  patchWriter.ensureWorkbenchPatch(name);
  emit("verify", "Verifying dump-config…");
  await patchWriter.verify(name);
  emit("meta", "Saving space metadata…");
  registry.updateMeta(name, {
    displayName: displayName?.trim() || name,
    order: 1000,
  });
}
