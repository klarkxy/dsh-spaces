import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { MANAGED_HOME_ENTRIES, RESTORE_STAGE_DIR } from "../../../../src/shared/snapshots";
import { ensureNode, npmCliJs, setToolchainRoot } from "../../../../src/main/toolchain";

export const PACK_TIMEOUT_MS = 240_000;

export interface PackedArtifacts {
  pluginArtifact: string;
  viewBridgeArtifact: string;
}

export interface PackOneRequest {
  packageRoot: string;
  destination: string;
  npmCli: string;
  execPath: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface PackArtifactsOptions {
  pluginPackageRoot: string;
  viewBridgeRoot: string;
  artifactDir: string;
  home: string;
  execPath: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  npmCli?: string;
  pack?: (request: PackOneRequest) => Promise<string>;
}

/**
 * Pack the installed plugin and view-bridge as local tarballs into a directory
 * outside Home and outside the package itself. Does not write tgz back into
 * the plugin tree (avoids self-nesting).
 */
export async function packLocalArtifacts(options: PackArtifactsOptions): Promise<PackedArtifacts | { reasons: string[] }> {
  const home = realDirectory(options.home);
  const pluginRoot = realDirectory(options.pluginPackageRoot);
  const viewRoot = realDirectory(options.viewBridgeRoot);
  if (!home || !pluginRoot || !viewRoot) {
    return { reasons: ["Plugin or view-bridge package directory is missing."] };
  }
  if (!packageNameIs(pluginRoot, "@dsh-spaces/plugin") || !packageNameIs(viewRoot, "@dsh-spaces/view-bridge")) {
    return { reasons: ["Artifact sources are not the installed Spaces plugin and view-bridge packages."] };
  }
  if (containsTarball(join(pluginRoot, "lib")) || containsTarball(viewRoot)) {
    return { reasons: ["Refusing to pack a package that already contains a tarball."] };
  }
  const artifactDir = resolve(options.artifactDir);
  if (inside(home, artifactDir) || inside(pluginRoot, artifactDir) || inside(viewRoot, artifactDir)) {
    return { reasons: ["Artifact directory must be outside Home and outside the plugin packages."] };
  }
  try {
    mkdirSync(artifactDir, { recursive: true });
  } catch {
    return { reasons: ["Artifact directory could not be created."] };
  }
  const dest = realDirectory(artifactDir);
  if (!dest) return { reasons: ["Artifact directory is not a real directory."] };

  const toolsRoot = dirname(dest);
  let npm = options.npmCli ?? resolveNpmCli(options.execPath, toolsRoot);
  if (!npm && !options.pack) {
    try {
      setToolchainRoot(toolsRoot);
      await ensureNode();
      npm = npmCliJs();
    } catch {
      npm = undefined;
    }
  }
  if (!options.pack && (!npm || !isRealFile(npm))) {
    return { reasons: ["npm-cli.js was not found next to the current Node executable."] };
  }

  const pack = options.pack ?? defaultNpmPack;
  npm = npm ?? "npm-cli.js";
  const timeoutMs = options.timeoutMs ?? PACK_TIMEOUT_MS;
  try {
    const pluginArtifact = await pack({
      packageRoot: pluginRoot,
      destination: dest,
      npmCli: npm,
      execPath: options.execPath,
      timeoutMs,
      env: options.env,
    });
    const viewBridgeArtifact = await pack({
      packageRoot: viewRoot,
      destination: dest,
      npmCli: npm,
      execPath: options.execPath,
      timeoutMs,
      env: options.env,
    });
    if (!isRealFile(pluginArtifact) || !isRealFile(viewBridgeArtifact)) {
      return { reasons: ["npm pack did not produce tarballs."] };
    }
    if (inside(pluginRoot, pluginArtifact) || inside(viewRoot, viewBridgeArtifact)) {
      return { reasons: ["Pack wrote a tarball back into the plugin directory."] };
    }
    return { pluginArtifact, viewBridgeArtifact };
  } catch (error) {
    return { reasons: [error instanceof Error ? error.message : "npm pack failed."] };
  }
}

export function resolveNpmCli(execPath: string, toolsRoot?: string): string | undefined {
  const dir = dirname(execPath);
  const candidates = [
    join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(dir, "..", "node_modules", "npm", "bin", "npm-cli.js"),
    join(dir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const found = candidates.find((path) => isRealFile(path));
  if (found) return found;
  if (toolsRoot) {
    try {
      setToolchainRoot(toolsRoot);
    } catch {
      /* keep looking */
    }
  }
  return npmCliJs();
}

export function validateSnapshotRoot(home: string, snapshotRoot: string): string | null {
  if (!isAbsolute(snapshotRoot)) return null;
  const real = realDirectory(snapshotRoot);
  if (!real) return null;
  const homeReal = realDirectory(home);
  if (!homeReal) return null;
  for (const entry of MANAGED_HOME_ENTRIES) {
    const replaced = join(homeReal, entry);
    if (samePath(real, replaced) || inside(replaced, real)) return null;
  }
  const restore = join(homeReal, RESTORE_STAGE_DIR);
  if (samePath(real, restore) || inside(restore, real)) return null;
  return real;
}

export function pluginPackageRootFromLib(payloadRoot: string): string | null {
  const lib = realDirectory(payloadRoot);
  if (!lib) return null;
  const parent = dirname(lib);
  if (packageNameIs(parent, "@dsh-spaces/plugin")) return parent;
  if (packageNameIs(lib, "@dsh-spaces/plugin")) return lib;
  return null;
}

async function defaultNpmPack(request: PackOneRequest): Promise<string> {
  const timeoutMs = request.timeoutMs;
  const args = ["pack", "--ignore-scripts", "--json", "--pack-destination", request.destination];
  const stdout = await runNode(request.execPath, [request.npmCli, ...args], request.packageRoot, request.env, timeoutMs);
  const filename = filenameFromNpmPackJson(stdout);
  if (!filename) throw new Error("npm pack JSON did not name a tarball.");
  const path = isAbsolute(filename) ? filename : join(request.destination, filename);
  if (!isRealFile(path)) throw new Error("npm pack tarball is missing.");
  return path;
}

function filenameFromNpmPackJson(stdout: string): string | null {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("[");
  const jsonText = start >= 0 ? trimmed.slice(start) : trimmed;
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!row || typeof row !== "object") return null;
    const filename = (row as { filename?: unknown }).filename;
    return typeof filename === "string" && filename.endsWith(".tgz") ? filename : null;
  } catch {
    return null;
  }
}

function runNode(
  execPath: string,
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(execPath, argv, {
      cwd,
      env: env ?? process.env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("npm pack timed out."));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || stdout || "npm pack failed.").slice(0, 500)));
        return;
      }
      resolveRun(stdout);
    });
  });
}

function packageNameIs(dir: string, name: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown };
    return pkg.name === name;
  } catch {
    return false;
  }
}

function containsTarball(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => name.endsWith(".tgz"));
  } catch {
    return false;
  }
}

function isRealFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    realpathSync(path);
    return true;
  } catch {
    return false;
  }
}

function realDirectory(path: string): string | null {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    return realpathSync(path);
  } catch {
    return null;
  }
}

function inside(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  if (samePath(r, t)) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  const left = process.platform === "win32" ? prefix.toLowerCase() : prefix;
  const right = process.platform === "win32" ? t.toLowerCase() : t;
  return right.startsWith(left);
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
}
