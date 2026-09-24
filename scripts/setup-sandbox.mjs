#!/usr/bin/env node
/**
 * Create sandbox profiles for CI / local isolation runs.
 * Never points DSH_HOME at the real ~/.dsh.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = resolve(process.argv[2] || join(REPO, ".sandbox", "dsh-home"));
const REAL = join(homedir(), ".dsh");

function dshBin() {
  const explicit = process.env.DSH_TEST_BIN || process.env.DSH_TEST_CLI_BIN;
  if (explicit) {
    const bin = resolve(explicit);
    if (!existsSync(bin)) throw new Error("Explicit DSH test CLI is missing");
    return bin;
  }
  const win = process.env.APPDATA
    ? join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
    : "";
  if (win && existsSync(win)) return win;
  const probe = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: true });
  const root = (probe.stdout || "").trim();
  const candidate = join(root, "@deepseek-ai", "dsh", "lib", "bin.js");
  if (existsSync(candidate)) return candidate;
  throw new Error("dsh CLI not found; install @deepseek-ai/dsh globally");
}

function run(args) {
  const result = spawnSync(process.execPath, [dshBin(), ...args], {
    env: {
      ...process.env,
      DSH_HOME: HOME,
      // Official profiles are themselves pnpm workspaces; pnpm 9 refuses `add` without -w.
      npm_config_ignore_workspace_root_check: "true",
    },
    encoding: "utf8",
    timeout: 180_000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n");
    throw new Error(`dsh ${args.join(" ")} failed (${result.status}):\n${detail}`);
  }
  return result.stdout || "";
}

function version() {
  const text = run(["--version"]);
  const match = text.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
  if (!match) throw new Error(`could not parse dsh version: ${text}`);
  return match[1];
}

function writePatch(name) {
  const path = join(HOME, "profiles", name, "cordis.patch.yml");
  writeFileSync(
    path,
    `# DSH Spaces isolation: sessions, storage and credentials; settings are profile-owned.
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('hub/${name}/sessions')
- id: storage-json
  config:
    root: !!js dshHomePath('hub/${name}/storages')
- id: credentials
  config:
    path: !!js dshHomePath('hub/${name}/.credentials.yaml')
`,
    "utf8",
  );
}

function main() {
  if (resolve(HOME).toLowerCase() === resolve(REAL).toLowerCase()) {
    throw new Error("refusing real ~/.dsh");
  }
  mkdirSync(HOME, { recursive: true });
  console.log(`INFO  sandbox ${HOME}`);
  const ver = version();
  for (const name of ["coding", "writing"]) {
    const dir = join(HOME, "profiles", name);
    if (!existsSync(join(dir, "package.json"))) {
      console.log(`INFO  creating ${name} with dsh-web-app@${ver}`);
      run(["--profile", name, "--from-default-profile", "web", "--dump-config"]);
    }
    writePatch(name);
    const dump = run(["--profile", name, "--dump-config"]);
    if (!dump.includes(`hub/${name}/sessions`) || !dump.includes(`hub/${name}/storages`)) {
      throw new Error(`${name} dump-config did not pick up hub roots`);
    }
    console.log(`INFO  ${name} patched`);
  }
  console.log("SETUP SANDBOX: OK");
}

main();
