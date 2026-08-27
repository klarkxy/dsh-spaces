import type { OnboardingScan } from "../shared/types";
import { runDsh } from "./dsh-cli";
import { PatchWriter } from "./patch-writer";
import { ProfileRegistry } from "./profile-registry";

export async function confirmOnboarding(
  dshHome: string,
  registry: ProfileRegistry,
  patchWriter: PatchWriter,
): Promise<OnboardingScan> {
  await runDsh(dshHome, ["--profile", "web", "--dump-config"], { timeoutMs: 30_000 });
  const scan = registry.scanOnboarding();
  const toConvert = scan.profiles.filter((p) => p.action === "convert-workbench").map((p) => p.name);
  for (const name of toConvert) {
    patchWriter.ensureWorkbenchPatch(name);
    await patchWriter.verify(name);
  }
  registry.markOnboarded();
  return registry.scanOnboarding();
}
