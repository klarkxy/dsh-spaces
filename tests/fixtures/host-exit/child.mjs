import { writeFileSync } from "node:fs";
import { join } from "node:path";

const marker = process.env.HOST_EXIT_MARKER ?? "marker.txt";
const dir = process.env.HOST_EXIT_TMP ?? process.cwd();
if (!process.send || !process.connected) {
  process.exit(4);
}
process.once("disconnect", () => {
  writeFileSync(join(dir, marker), "disconnected");
  process.exit(0);
});
setTimeout(() => process.exit(2), 30_000);
process.send("ready");
