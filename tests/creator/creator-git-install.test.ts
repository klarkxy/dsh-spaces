import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
import { listProfilePlugins } from "../../src/adapters/node/products/plugin-ops.ts";

/**
 * Real CLI acceptance for the creator Git path. A controlled local repository
 * answers the GitHub transport through a fixture-scoped global gitconfig
 * (GIT_CONFIG_GLOBAL + GIT_CONFIG_NOSYSTEM): nothing reads or writes the real
 * user or system git configuration, and no public GitHub access is claimed.
 *
 * The fixture repo id deliberately does not exist on GitHub, so pnpm's
 * codeload tarball optimization (public repos only) cannot run; the install
 * resolves through `git ls-remote`/clone over the mapped transport, which is
 * exactly the commit+path spec the creator emits. The installed bundle content
 * is verified so a real public repo with the same id could not pass silently.
 *
 * The CLI under test is the declared dev-dependency @deepseek-ai/dsh bin by
 * default; DSH_CREATOR_TEST_BIN overrides it with an isolated runtime.
 */

const TEST_BIN = process.env.DSH_CREATOR_TEST_BIN?.trim()
  || resolve("node_modules/@deepseek-ai/dsh/lib/bin.js");
const REPO_ID = "dsh-spaces-fixtures/creator-git-fixture-8f3a2c1b";
const SUBDIR = "plugins/dsh-git-fixture";
const PACKAGE = "dsh-git-fixture";
const FIXTURE_MARK = "dsh-creator-git-fixture-marker-4b7e9d";

const temps: string[] = [];

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return (result.stdout ?? "").trim();
}

function gitEnv(): NodeJS.ProcessEnv {
  return { GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@localhost", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@localhost" };
}

function writeProfile(home: string, name: string): void {
  const dir = join(home, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ private: true, type: "module", dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2)}\n`,
  );
}

/** Fixture-scoped git config: isolated global file + no system config. */
function childGitEnv(home: string, repo: string, root: string): NodeJS.ProcessEnv {
  const globalFile = join(root, "gitconfig.fixture");
  const file = pathToFileURL(repo).href;
  writeFileSync(
    globalFile,
    [
      `[url "${file}"]`,
      `\tinsteadOf = https://github.com/${REPO_ID}`,
      `\tinsteadOf = https://github.com/${REPO_ID}.git`,
      "",
    ].join("\n"),
  );
  return {
    ...process.env,
    DSH_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalFile,
    // No credential prompt can ever block the controlled transport.
    GIT_TERMINAL_PROMPT: "0",
  };
}

function pluginAdd(profile: string, spec: string, env: NodeJS.ProcessEnv, extra: string[] = []) {
  return spawnSync(
    process.execPath,
    [TEST_BIN, "plugin", "--profile", profile, "add", spec, ...extra],
    { encoding: "utf8", timeout: 240_000, env },
  );
}

function writeFixturePackage(dir: string, marker = FIXTURE_MARK): void {
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: PACKAGE, version: "1.0.0", type: "module", main: "index.js", dsh: { bundle: { patch: "cordis.patch.yml" } } }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, "cordis.patch.yml"),
    `- insert:\n    - id: ${PACKAGE}\n      name: '${PACKAGE}'\n      config: {}\n`,
  );
  writeFileSync(
    join(dir, "index.js"),
    `export const marker = "${marker}"\nexport default class DshGitFixture {}\n`,
  );
}

/** Two commits with different content; the returned sha is the OLDER one. */
function initRepoTwoCommits(dir: string, pkgDir = dir): { pinned: string; head: string } {
  writeFixturePackage(pkgDir);
  const env = gitEnv();
  git(["init", "-q"], dir, env);
  git(["add", "-A"], dir, env);
  git(["commit", "-qm", "pinned"], dir, env);
  const pinned = git(["rev-parse", "HEAD"], dir, env);
  writeFileSync(join(pkgDir, "index.js"), `export const marker = "UNPINNED-head-change"\n`);
  git(["add", "-A"], dir, env);
  git(["commit", "-qm", "head"], dir, env);
  const head = git(["rev-parse", "HEAD"], dir, env);
  return { pinned, head };
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the CLI accepts github:owner/repo#commit&path:/sub and records the pinned source", { timeout: 300_000 }, () => {
  assert.ok(existsSync(TEST_BIN), `dsh CLI bin missing at ${TEST_BIN}`);
  const root = mkdtempSync(join(tmpdir(), "dsh-spaces-creator-git-"));
  temps.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const repo = join(root, "repo");
  mkdirSync(join(repo, SUBDIR), { recursive: true });
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ private: true })}\n`);
  const { pinned: commit, head } = initRepoTwoCommits(repo, join(repo, SUBDIR));
  assert.notEqual(commit, head, "fixture must hold two distinct commits");
  const profile = "space-git";
  writeProfile(home, profile);

  const spec = `github:${REPO_ID}#${commit}&path:/${SUBDIR}`;
  const result = pluginAdd(profile, spec, childGitEnv(home, repo, root));
  assert.equal(
    result.status,
    0,
    `dsh plugin add exited ${result.status}:\n${result.stderr}\n${result.stdout}`,
  );

  // The recorded dependency value is a bare repo URL for private repos —
  // the authoritative pin lives in pnpm-lock.yaml's resolution.
  const manifest = JSON.parse(
    readFileSync(join(home, "profiles", profile, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const recorded = manifest.dependencies?.[PACKAGE];
  assert.ok(recorded, `dependency ${PACKAGE} was not recorded: ${JSON.stringify(manifest.dependencies)}`);
  const lockfile = readFileSync(join(home, "profiles", profile, "pnpm-lock.yaml"), "utf8");
  assert.match(lockfile, new RegExp(`commit: ['"]?${commit}`), `lockfile lost the pinned commit:\n${lockfile.slice(0, 4000)}`);
  assert.match(lockfile, new RegExp(`path: ['"]?/?${SUBDIR.replaceAll("/", "\\/")}`), `lockfile lost the subdirectory:\n${lockfile.slice(0, 4000)}`);

  // The installed package is the fixture content from the pinned commit,
  // not HEAD and not another same-named repo.
  const installedManifest = JSON.parse(
    readFileSync(join(home, "profiles", profile, "node_modules", PACKAGE, "package.json"), "utf8"),
  ) as { name?: string };
  assert.equal(installedManifest.name, PACKAGE);
  const installedSource = readFileSync(join(home, "profiles", profile, "node_modules", PACKAGE, "index.js"), "utf8");
  assert.ok(installedSource.includes(FIXTURE_MARK), "installed index.js is not the fixture content");
  assert.ok(!installedSource.includes("UNPINNED"), "installed index.js came from HEAD, not the pinned commit");

  // The production read-back path accepts what the real installer wrote.
  const rows = listProfilePlugins(home, profile);
  const installed = rows.find((row) => row.name === PACKAGE);
  assert.ok(installed, "listProfilePlugins did not read back the installed bundle");
});

test("git prepare is deny-by-default and runs only under the exact allowBuilds key", { timeout: 300_000 }, () => {
  assert.ok(existsSync(TEST_BIN), `dsh CLI bin missing at ${TEST_BIN}`);
  const root = mkdtempSync(join(tmpdir(), "dsh-spaces-creator-git-prepare-"));
  temps.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const sentinel = join(root, "prepared.marker");
  const mark = join(root, "attempted.marker");
  writeFileSync(
    join(repo, "package.json"),
    `${JSON.stringify({ name: PACKAGE, version: "1.0.0", type: "module", main: "index.js", scripts: { prepare: `node -e "require('fs').writeFileSync(process.env.PREPARE_SENTINEL,'built');require('fs').writeFileSync(process.env.PREPARE_ATTEMPTED,'tried')"` }, dsh: { bundle: { patch: "cordis.patch.yml" } } }, null, 2)}\n`,
  );
  writeFileSync(
    join(repo, "cordis.patch.yml"),
    `- insert:\n    - id: ${PACKAGE}\n      name: '${PACKAGE}'\n      config: {}\n`,
  );
  writeFileSync(join(repo, "index.js"), `export const marker = "${FIXTURE_MARK}"\n`);
  const env = { GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@localhost", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@localhost" };
  git(["init", "-q"], repo, env);
  git(["add", "-A"], repo, env);
  git(["commit", "-qm", "fixture"], repo, env);
  const commit = git(["rev-parse", "HEAD"], repo, env);
  const profile = "space-git-prepare";
  writeProfile(home, profile);
  const childEnv = {
    ...childGitEnv(home, repo, root),
    PREPARE_SENTINEL: sentinel,
    PREPARE_ATTEMPTED: mark,
  };
  const spec = `github:${REPO_ID}#${commit}`;

  // Phase A: no approval. Either the CLI refuses outright or it reports the
  // build ignored; the prepare must never execute.
  const denied = pluginAdd(profile, spec, childEnv);
  const deniedOut = `${denied.stderr}\n${denied.stdout}`;
  assert.equal(
    existsSync(mark) || existsSync(sentinel),
    false,
    `prepare ran without an approval (status ${denied.status}):\n${deniedOut}`,
  );
  const refused = denied.status !== 0;
  if (!refused) {
    assert.match(
      deniedOut,
      /Ignored build scripts|GIT_DEP_PREPARE|ignored/i,
      `status 0 without approval must still report the build was ignored:\n${deniedOut}`,
    );
  }

  // Phase B: a different exact key still cannot run it.
  writeFileSync(
    join(home, "profiles", profile, "pnpm-workspace.yaml"),
    `allowBuilds:\n  dsh-other-package: true\n`,
  );
  const wrongKey = pluginAdd(profile, spec, childEnv);
  const wrongOut = `${wrongKey.stderr}\n${wrongKey.stdout}`;
  assert.equal(
    existsSync(mark) || existsSync(sentinel),
    false,
    `prepare ran under a mismatched key (status ${wrongKey.status}):\n${wrongOut}`,
  );
  assert.notEqual(wrongKey.status, 0, `a mismatched key must not satisfy the prepare gate:\n${wrongOut}`);

  // Phase C: the exact package name in allowBuilds is the approval the CLI
  // honors; the prepare must actually run, proving the gate is real.
  writeFileSync(
    join(home, "profiles", profile, "pnpm-workspace.yaml"),
    `allowBuilds:\n  ${PACKAGE}: true\n`,
  );
  const approved = pluginAdd(profile, spec, childEnv);
  const approvedOut = `${approved.stderr}\n${approved.stdout}`;
  assert.equal(
    approved.status,
    0,
    `dsh plugin add with approved build exited ${approved.status}:\n${approvedOut}`,
  );
  assert.equal(
    existsSync(sentinel),
    true,
    `the approved prepare did not run (status ${approved.status}):\n${approvedOut}`,
  );
});

test("the CLI accepts github:owner/repo#commit for a root package", { timeout: 300_000 }, () => {
  assert.ok(existsSync(TEST_BIN), `dsh CLI bin missing at ${TEST_BIN}`);
  const root = mkdtempSync(join(tmpdir(), "dsh-spaces-creator-git-root-"));
  temps.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const { pinned: commit, head } = initRepoTwoCommits(repo);
  assert.notEqual(commit, head, "fixture must hold two distinct commits");
  const profile = "space-git-root";
  writeProfile(home, profile);

  const spec = `github:${REPO_ID}#${commit}`;
  const result = pluginAdd(profile, spec, childGitEnv(home, repo, root));
  assert.equal(
    result.status,
    0,
    `dsh plugin add exited ${result.status}:\n${result.stderr}\n${result.stdout}`,
  );
  const rows = listProfilePlugins(home, profile);
  const installed = rows.find((row) => row.name === PACKAGE);
  const lockfile = readFileSync(join(home, "profiles", profile, "pnpm-lock.yaml"), "utf8");
  assert.match(lockfile, new RegExp(`commit: ['"]?${commit}`), `lockfile lost the pinned commit:\n${lockfile.slice(0, 4000)}`);
  assert.ok(installed, "listProfilePlugins did not read back the installed bundle");
  const installedSource = readFileSync(join(home, "profiles", profile, "node_modules", PACKAGE, "index.js"), "utf8");
  assert.ok(installedSource.includes(FIXTURE_MARK), "installed index.js is not the fixture content");
  assert.ok(!installedSource.includes("UNPINNED"), "installed index.js came from HEAD, not the pinned commit");
});

test("one CLI Git-root add can explicitly authorize prepare without a preconfigured profile", { timeout: 300_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-spaces-git-root-build-"));
  temps.push(root);
  const home = join(root, "home"), repo = join(root, "repo");
  mkdirSync(home); mkdirSync(repo);
  writeFixturePackage(repo);
  const manifestPath = join(repo, "package.json");
  const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
  pkg.main = "lib/index.js";
  pkg.files = ["lib", "cordis.patch.yml"];
  pkg.scripts = { prepare: "node build.cjs" };
  writeFileSync(manifestPath, JSON.stringify(pkg));
  writeFileSync(join(repo, "build.cjs"),
    `const fs=require('node:fs');fs.mkdirSync('lib',{recursive:true});fs.writeFileSync('lib/index.js','export const marker = ${JSON.stringify(FIXTURE_MARK)};\\n');\n`);
  const env = gitEnv();
  git(["init", "-q"], repo, env);
  git(["add", "-A"], repo, env);
  git(["commit", "-qm", "root-prepare"], repo, env);
  const commit = git(["rev-parse", "HEAD"], repo, env);
  const profile = "space-root-build";
  writeProfile(home, profile);
  assert.equal(existsSync(join(repo, "lib/index.js")), false);
  assert.equal(existsSync(join(home, "profiles", profile, "pnpm-workspace.yaml")), false);
  const added = pluginAdd(profile, `github:${REPO_ID}#${commit}`, childGitEnv(home, repo, root), [`--allow-build=${PACKAGE}`]);
  assert.equal(added.status, 0, `${added.stderr}\n${added.stdout}`);
  const installed = join(home, "profiles", profile, "node_modules", PACKAGE);
  assert.ok(readFileSync(join(installed, "lib/index.js"), "utf8").includes(FIXTURE_MARK));
  assert.equal(existsSync(join(installed, "build.cjs")), false);
});
