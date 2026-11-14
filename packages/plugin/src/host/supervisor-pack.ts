import { inside, lstatSync, realpathSync, samePath } from "../../../../src/shared/node/filesystem";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { MANAGED_HOME_ENTRIES, RESTORE_STAGE_DIR } from "../../../../src/shared/snapshots";
import { ensureNode, npmCliJs, setToolchainRoot } from "../../../../src/adapters/node/runtime/toolchain";

export const PACK_TIMEOUT_MS = 240_000;

export interface PackedArtifacts {
  pluginArtifact: string;
  viewBridgeArtifact: string;
  browserArtifact?: string;
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
  browserRoot?: string;
  artifactDir: string;
  home: string;
  execPath: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  npmCli?: string;
  pack?: (request: PackOneRequest) => Promise<string>;
}

/**
 * Pack the installed plugin, view-bridge, and optional browser as local
 * tarballs into a directory outside Home and outside the package itself.
 * Does not write tgz back into the plugin tree (avoids self-nesting).
 */
export async function packLocalArtifacts(options: PackArtifactsOptions): Promise<PackedArtifacts | { reasons: string[] }> {
  const home = realDirectory(options.home);
  const pluginRoot = realDirectory(options.pluginPackageRoot);
  const viewRoot = realDirectory(options.viewBridgeRoot);
  const browserRoot = options.browserRoot === undefined ? undefined : realDirectory(options.browserRoot);
  if (!home || !pluginRoot || !viewRoot) {
    return { reasons: ["Plugin or view-bridge package directory is missing."] };
  }
  if (options.browserRoot !== undefined && !browserRoot) {
    return { reasons: ["browser package directory is missing."] };
  }
  if (!packageNameIs(pluginRoot, "dsh-spaces") || !packageNameIs(viewRoot, "@dsh-spaces/view-bridge")) {
    return { reasons: ["Artifact sources are not the installed Spaces plugin and view-bridge packages."] };
  }
  if (browserRoot && !packageNameIs(browserRoot, "@dsh-spaces/browser")) {
    return { reasons: ["Artifact sources are not the installed Spaces browser package."] };
  }
  if (containsTarball(join(pluginRoot, "lib")) || containsTarball(viewRoot) || (browserRoot && containsTarball(browserRoot))) {
    return { reasons: ["Refusing to pack a package that already contains a tarball."] };
  }
  const artifactDir = resolve(options.artifactDir);
  if (
    inside(home, artifactDir) ||
    inside(pluginRoot, artifactDir) ||
    inside(viewRoot, artifactDir) ||
    (browserRoot && inside(browserRoot, artifactDir))
  ) {
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
    const browserArtifact = browserRoot ? await pack({
      packageRoot: browserRoot,
      destination: dest,
      npmCli: npm,
      execPath: options.execPath,
      timeoutMs,
      env: options.env,
    }) : undefined;
    if (!isRealFile(pluginArtifact) || !isRealFile(viewBridgeArtifact) || (browserRoot && !browserArtifact)) {
      return { reasons: ["npm pack did not produce tarballs."] };
    }
    if (browserRoot && browserArtifact && !isRealFile(browserArtifact)) {
      return { reasons: ["npm pack did not produce tarballs."] };
    }
    if (
      inside(pluginRoot, pluginArtifact) ||
      inside(viewRoot, viewBridgeArtifact) ||
      (browserRoot && browserArtifact && inside(browserRoot, browserArtifact))
    ) {
      return { reasons: ["Pack wrote a tarball back into the plugin directory."] };
    }
    return { pluginArtifact, viewBridgeArtifact,
      ...(browserArtifact ? { browserArtifact } : {}),
    };
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

