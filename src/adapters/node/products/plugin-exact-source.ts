/**
 * Node-side helpers for the closed exact plugin source (shared
 * contract in src/shared/plugin-source.ts): install spec generation, the
 * pnpm allowBuilds policy write, lockfile-based git read-back, pending
 * build-key extraction, and post-install verification. Shared by the
 * Creator create pipeline and the maintenance `plugin.install.spec` plan.
 *
 * All helpers throw plain Errors carrying public-safe text; callers map
 * them onto their own closed error codes.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isAlias, isMap, isNode, parseDocument, visit } from "yaml";
import { atomicWrite } from "../atomic";
import type { ExactPluginSource } from "../../../shared/plugin-source";

/** Public provenance for the step record and the pnpm spec derived from it. */
export function pinDetailFor(plugin: ExactPluginSource): string {
  if (plugin.kind === "npm") return `${plugin.packageName}@${plugin.version}`;
  return plugin.path
    ? `${plugin.owner}/${plugin.repo}/${plugin.path}#${plugin.commit}`
    : `${plugin.owner}/${plugin.repo}#${plugin.commit}`;
}

export function installSpecFor(plugin: ExactPluginSource): string {
  if (plugin.kind === "npm") return `${plugin.packageName}@${plugin.version}`;
  // pnpm's git resolver splits the fragment on "&": every segment except
  // path:/semver: is the committish. The official subdirectory form is
  // github:owner/repo#<commit>&path:/<subdir> (same as installBundle).
  return plugin.path
    ? `github:${plugin.owner}/${plugin.repo}#${plugin.commit}&path:/${plugin.path}`
    : `github:${plugin.owner}/${plugin.repo}#${plugin.commit}`;
}

/**
 * Persist the channel's build policy in the profile's pnpm-workspace.yaml
 * before install: an explicit deny-by-default stance plus the caller's exact
 * allowBuilds keys. Same file, keys and value semantics as the official
 * manager's allowBuilds handling; unknown or wildcard keys never reach here.
 */
export function writeBuildPolicy(profileDir: string, names: readonly string[]): void {
  const file = join(profileDir, "pnpm-workspace.yaml");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "{}\n";
  const document = parseDocument(text);
  if (document.errors[0] !== undefined) throw document.errors[0];
  if (document.contents !== null && !isMap(document.contents)) {
    throw new Error("pnpm-workspace.yaml must be a YAML mapping.");
  }
  const builds = document.get("allowBuilds");
  if (builds !== undefined && !isMap(builds)) {
    throw new Error("allowBuilds must be a YAML mapping.");
  }
  visit(builds ?? null, (_key, node) => {
    if (isAlias(node) || (isNode(node) && "anchor" in node && node.anchor)) {
      throw new Error("allowBuilds must not contain YAML anchors or aliases.");
    }
  });
  document.setIn(["dangerouslyAllowAllBuilds"], false);
  for (const name of names) document.setIn(["allowBuilds", name], true);
  atomicWrite(file, String(document));
}

/**
 * Verify an install under the frozen source read back what the plan
 * authorized: the package must exist under its declared name, an npm
 * install must resolve to the exact version, and a git install must be
 * proven from the pinned repo/commit/subdirectory by the lockfile.
 */
export function verifyExactInstall(installed: Array<{
  name: string;
  requestedSpec?: string;
  resolvedVersion?: string | null;
}>, home: string, spaceId: string, plugin: ExactPluginSource): void {
  const hit = installed.find(
    (row) => row.name.toLowerCase() === plugin.packageName.toLowerCase(),
  );
  if (!hit) {
    throw new Error(`Plugin ${plugin.packageName} was not installed or read back under a different name.`);
  }
  if (plugin.kind === "npm" && hit.resolvedVersion !== plugin.version) {
    throw new Error(`Plugin ${plugin.packageName} resolved to ${hit.resolvedVersion ?? "an unverified version"}, not ${plugin.version}.`);
  }
  if (plugin.kind === "github") {
    const expectedRepo = `${plugin.owner}/${plugin.repo}`;
    const normalizedPath = plugin.path ? `/${plugin.path}` : undefined;
    const expected = `Plugin ${plugin.packageName} was not read back from the pinned source ${expectedRepo}${normalizedPath ?? ""}#${plugin.commit}.`;
    const requested = hit.requestedSpec ?? "";
    const declared = parseGitDependencySource(requested);
    // A recorded pin must never contradict the frozen one; a bare URL only
    // means the lockfile below has to prove it.
    if (declared && (declared.repo !== expectedRepo || declared.commit !== plugin.commit || declared.path !== normalizedPath)) {
      throw new Error(expected);
    }
    const resolution = gitResolutionFor(home, spaceId, plugin.packageName);
    if (
      !resolution ||
      resolution.repo !== expectedRepo ||
      resolution.commit !== plugin.commit ||
      resolution.path !== normalizedPath
    ) {
      throw new Error(expected);
    }
  }
}

/**
 * Normalize a recorded git dependency into host/owner/repo, commit and
 * subdirectory. Accepts the forms pnpm and the CLI record for GitHub deps:
 * github:owner/repo#commit[&path:/sub], git+<url>#[commit&]path:/sub,
 * and https://github.com/owner/repo(.git)#... . Anything else returns null
 * so the read-back check fails instead of guessing a match.
 */
export function parseGitDependencySource(raw: string): { repo: string; commit: string; path?: string } | null {
  const trimmed = raw.trim();
  let repo = "";
  let fragment = "";
  if (trimmed.startsWith("github:")) {
    const body = trimmed.slice("github:".length);
    const at = body.indexOf("#");
    repo = at === -1 ? body : body.slice(0, at);
    fragment = at === -1 ? "" : body.slice(at + 1);
  } else {
    const match = /^(?:git\+)?https?:\/\/github\.com\/([^/]+\/[^/#?]+?)(?:\.git)?#(.*)$/.exec(trimmed);
    if (!match) return null;
    repo = match[1]!;
    fragment = match[2] ?? "";
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo)) return null;
  let commit: string | undefined;
  let path: string | undefined;
  for (const segment of fragment.split("&")) {
    if (segment.startsWith("path:")) path = segment.slice(5);
    else if (segment.startsWith("commit:")) commit = segment.slice(7);
    else if (!segment.startsWith("semver:")) commit = segment;
  }
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) return null;
  const normalizedPath = path === undefined ? undefined : path.startsWith("/") ? path : `/${path}`;
  return { repo, commit, ...(normalizedPath !== undefined ? { path: normalizedPath } : {}) };
}

/**
 * The authoritative git resolution for one installed bundle. The importer
 * entry in pnpm-lock.yaml binds the exact depPath the installer resolved for
 * this package; its snapshot resolution then proves the source:
 *   {type: git, repo, commit, path?}        — private repo, cloned transport
 *   {tarball: https://codeload.github.com/o/r/tar.gz/<sha>, path?}
 *                                           — public repo, codeload tarball
 * A package.json dependency value may drop the pin entirely, so the lockfile
 * is the only authoritative record. Returns null on any ambiguity.
 */
export function gitResolutionFor(
  home: string,
  spaceId: string,
  packageName: string,
): { repo: string; commit: string; path?: string } | null {
  const lockfile = join(home, "profiles", spaceId, "pnpm-lock.yaml");
  let text: string;
  try {
    text = readFileSync(lockfile, "utf8");
  } catch {
    return null;
  }
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(text);
    if (document.errors[0] !== undefined) return null;
  } catch {
    return null;
  }
  if (!isMap(document.contents)) return null;
  const importer = document.getIn(["importers", "."]);
  if (!isMap(importer)) return null;
  const deps = importer.get("dependencies");
  if (!isMap(deps)) return null;
  const dep = deps.get(packageName);
  if (!isMap(dep)) return null;
  const version = dep.get("version");
  if (typeof version !== "string" || !version.trim()) return null;
  const sections = [document.get("snapshots"), document.get("packages")];
  for (const section of sections) {
    if (!isMap(section)) continue;
    const entry = section.get(`${packageName}@${version}`);
    if (!isMap(entry)) continue;
    const resolution = entry.get("resolution");
    if (!isMap(resolution)) continue;
    return readGitResolution(resolution, version);
  }
  return null;
}

/** Read a lockfile resolution into repo/commit/path, in both git and codeload forms. */
function readGitResolution(
  resolution: ReturnType<ReturnType<typeof parseDocument>["get"]>,
  depPath: string,
): { repo: string; commit: string; path?: string } | null {
  if (!isMap(resolution)) return null;
  const path = resolution.get("path");
  const normalizedPath = typeof path === "string" ? (path.startsWith("/") ? path : `/${path}`) : pathFromDepPath(depPath);
  const commit = resolution.get("commit");
  const repo = resolution.get("repo");
  if (typeof commit === "string" && typeof repo === "string") {
    const parsed = repoFromGitUrl(repo);
    if (!parsed || !/^[a-f0-9]{40}$/.test(commit)) return null;
    return { repo: parsed, commit, ...(normalizedPath !== undefined ? { path: normalizedPath } : {}) };
  }
  const tarball = resolution.get("tarball");
  if (typeof tarball === "string") {
    const match = /^https?:\/\/codeload\.github\.com\/([^/]+\/[^/]+?)\/tar\.gz\/([a-f0-9]{40})(?:#.*)?$/.exec(tarball);
    if (!match) return null;
    return { repo: match[1]!, commit: match[2]!, ...(normalizedPath !== undefined ? { path: normalizedPath } : {}) };
  }
  return null;
}

/** Subdirectory encoded on the depPath (`#path:/sub`) when the resolution omits it. */
function pathFromDepPath(depPath: string): string | undefined {
  const match = /[#&]path:(\/[^&#]+)/.exec(depPath);
  return match ? match[1]! : undefined;
}

/** owner/repo from a hosted git URL (https, git+ or scp ssh forms, GitHub only). */
function repoFromGitUrl(repo: string): string | null {
  const trimmed = repo.replace(/^git\+/, "");
  const https = /^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:#.*)?$/.exec(trimmed);
  if (https) return https[1]!;
  const ssh = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(trimmed);
  return ssh ? ssh[1]! : null;
}

const IGNORED_BUILDS = /\bIgnored build scripts: (.+)/;
const GIT_DEP_PREPARE = /ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED[\s\S]*?^allowBuilds:\r?\n[ \t]+(.+?): true$/m;

/** Exact allowBuilds keys a failed run reported as still awaiting a decision. */
export function pendingBuildKeys(output: string): string[] {
  const ignored = IGNORED_BUILDS.exec(output)?.[1]?.split(",") ?? [];
  const git = GIT_DEP_PREPARE.exec(output)?.[1];
  return [...ignored, ...(git === undefined ? [] : [git])]
    .map((name) => name.trim())
    .filter((name) => name !== "" && !/[*?]/.test(name));
}
