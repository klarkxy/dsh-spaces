import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lstatSync } from "../../../shared/node/filesystem";
import { atomicWrite } from "../atomic";

const fileOf = (home: string) => join(home, "profiles", "desktop", "spaces-welcome-notice.json");
/** Only copies an actual acknowledgement from Desktop; never invents a current version. */
export function readWelcomeNotice(home: string): string | undefined {
  const file = fileOf(home);
  if (!existsSync(file)) return;
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024) throw Error("Invalid shared welcome acknowledgement.");
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (value.schemaVersion !== 1 || typeof value.version !== "string" || !/^[\w.-]{1,80}$/.test(value.version)) throw Error("Invalid shared welcome acknowledgement.");
  return value.version;
}
export function writeWelcomeNotice(home: string, version: unknown) {
  if (typeof version !== "string" || !/^[\w.-]{1,80}$/.test(version)) return;
  const dir = lstatSync(join(home, "profiles", "desktop"));
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw Error("Invalid Desktop profile for acknowledgement.");
  if (readWelcomeNotice(home) === version) return;
  const file = fileOf(home);
  if (existsSync(`${file}.${process.pid}.tmp`)) throw Error("An incomplete welcome acknowledgement write remains.");
  atomicWrite(file, JSON.stringify({ schemaVersion: 1, version }));
}
