import { t } from "../shared/i18n";
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
  emit("validate", t("create.progressValidate"));
  registry.validateNewName(name);
  emit("plugin", t("create.progressPlugin"));
  await addWebApp(dshHome, name);
  emit("patch", t("create.progressPatch"));
  patchWriter.ensureWorkbenchPatch(name);
  emit("verify", t("create.progressVerify"));
  await patchWriter.verify(name);
  emit("meta", t("create.progressMeta"));
  registry.updateMeta(name, {
    displayName: displayName?.trim() || name,
    order: 1000,
  });
}
