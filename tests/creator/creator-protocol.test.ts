import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CreatorPublicError,
  parseCreatorCreateSpec,
  parseCreatorExecuteInput,
  parseCreatorIssueInput,
  parseCreatorJobInput,
  parseCreatorUnregisterInput,
} from "../../src/shared/creator.ts";

const code = (error: unknown): string => (error as { code?: string }).code ?? "";

test("create input normalizes a minimal web-space request", () => {
  const spec = parseCreatorCreateSpec({ name: "builder" });
  assert.equal(spec.name, "builder");
  assert.equal(spec.modelSource, "main");
  assert.equal(spec.startAfterCreate, false);
  assert.deepEqual(spec.plugins, []);
  assert.equal(spec.baseVersion, undefined);
});

test("create input accepts npm exact and github commit plugins", () => {
  const spec = parseCreatorCreateSpec({
    name: "builder",
    displayName: "Builder",
    icon: "hammer",
    baseVersion: "0.2.1-rc.2",
    modelSource: "local",
    startAfterCreate: true,
    plugins: [
      { npm: { packageName: "dsh-plugin-a", version: "1.2.3" } },
      {
        github: {
          owner: "klarkxy",
          repo: "dsh-plugins",
          commit: "a".repeat(40),
          path: "plugins/dsh-b",
          packageName: "@scope/dsh-b",
          approvedBuilds: ["@scope/dsh-b"],
        },
      },
    ],
  });
  assert.equal(spec.modelSource, "local");
  assert.equal(spec.startAfterCreate, true);
  assert.equal(spec.plugins.length, 2);
  const github = spec.plugins[1];
  assert.equal(github.kind, "github");
  if (github.kind === "github") {
    assert.equal(github.path, "plugins/dsh-b");
    assert.deepEqual(github.approvedBuilds, ["@scope/dsh-b"]);
  }
});

test("approved builds accept package names and name@version, never URL keys", () => {
  const spec = parseCreatorCreateSpec({
    name: "builder",
    plugins: [{ github: { owner: "a", repo: "b", commit: "a".repeat(40), packageName: "p", approvedBuilds: ["p", "p@1.2.3", "@scope/q@0.1.0"] } }],
  });
  const github = spec.plugins[0];
  assert.equal(github.kind, "github");
  if (github.kind === "github") assert.deepEqual(github.approvedBuilds, ["p", "p@1.2.3", "@scope/q@0.1.0"]);
});

test("create input rejects anything but exact pins and safe shapes", () => {
  const bad: unknown[] = [
    { name: "builder", plugins: [{ npm: { packageName: "dsh-plugin-a", version: "latest" } }] },
    { name: "builder", plugins: [{ npm: { packageName: "dsh-plugin-a", version: "^1.2.3" } }] },
    { name: "builder", plugins: [{ npm: { packageName: "dsh-plugin-a", version: "1.2.x" } }] },
    { name: "builder", plugins: [{ npm: { packageName: "@deepseek-ai/dsh-web-app", version: "0.2.1-rc.2" } }] },
    { name: "builder", plugins: [{ npm: { packageName: "@dsh-spaces/plugin", version: "0.5.0" } }] },
    { name: "builder", plugins: [{ github: { owner: "a", repo: "b", commit: "a".repeat(40), packageName: "@dsh-spaces/plugin" } }] },
    { name: "builder", plugins: [{ github: { owner: "a", repo: "b", commit: "main", packageName: "p" } }] },
    { name: "builder", plugins: [{ github: { owner: "a", repo: "b", commit: "a".repeat(40), path: "../x", packageName: "p" } }] },
    { name: "builder", plugins: [{ github: { owner: "a", repo: "b", commit: "a".repeat(40), path: "x\\y", packageName: "p" } }] },
    { name: "builder", plugins: [{ github: { owner: "a", repo: "b", commit: "a".repeat(40), path: "x//y", packageName: "p" } }] },
    { name: "builder", plugins: [{ npm: { packageName: "p-a", version: "1.0.0" } }, { npm: { packageName: "P-A", version: "2.0.0" } }] },
    { name: "builder", plugins: [{ npm: { packageName: "p", version: "1.0.0", approvedBuilds: ["*"] } }] },
    { name: "builder", plugins: [{ npm: { packageName: "p", version: "1.0.0", approvedBuilds: ["dep@git+https://example.com/org/dep.git#abc"] } }] },
    { name: "builder", plugins: [{ npm: { packageName: "p", version: "1.0.0", approvedBuilds: ["not a name"] } }] },
    { name: "bad name" },
    { name: "builder", unknown: true },
    { name: "builder", plugins: [{ npm: { packageName: "p", version: "1.0.0" }, github: {} }] },
    { name: "builder", modelSource: "inherit" },
    { name: "builder", startAfterCreate: "yes" },
    { name: "builder", baseVersion: "latest" },
  ];
  for (const input of bad) {
    assert.throws(
      () => parseCreatorCreateSpec(input),
      (error: unknown) => error instanceof CreatorPublicError && code(error) === "creator/invalid-input",
      JSON.stringify(input),
    );
  }
});

test("issue input requires clean loopback origin, 64-hex bearer, home and web|desktop profile", () => {
  const ok = parseCreatorIssueInput({
    origin: "http://127.0.0.1:4321", bearer: "b".repeat(64), home: "H:\\Code\\home", profile: "desktop",
  });
  assert.equal(ok.origin, "http://127.0.0.1:4321");
  for (const input of [
    { origin: "http://localhost:1", bearer: "b".repeat(64), home: "h", profile: "web" },
    { origin: "http://127.0.0.1:1/path", bearer: "b".repeat(64), home: "h", profile: "web" },
    { origin: "http://127.0.0.1:1/?x=1", bearer: "b".repeat(64), home: "h", profile: "web" },
    { origin: "https://127.0.0.1:1", bearer: "b".repeat(64), home: "h", profile: "web" },
    { origin: "http://127.0.0.1:1", bearer: "short", home: "h", profile: "web" },
    { origin: "http://127.0.0.1:1", bearer: "b".repeat(64), home: "h", profile: "space-child" },
    { origin: "http://127.0.0.1:1", bearer: "b".repeat(64), home: "h", profile: "hub" },
    { origin: "http://127.0.0.1:1", bearer: "b".repeat(64), home: "h" },
  ]) {
    assert.throws(
      () => parseCreatorIssueInput(input),
      (error: unknown) => error instanceof CreatorPublicError && code(error) === "creator/invalid-input",
      JSON.stringify(input),
    );
  }
});

test("execute/job/unregister inputs are strict", () => {
  assert.deepEqual(parseCreatorExecuteInput({ planId: "p-1", requestId: "r-1" }), { planId: "p-1", requestId: "r-1" });
  assert.deepEqual(parseCreatorJobInput({ jobId: "j-1" }), { jobId: "j-1" });
  assert.deepEqual(parseCreatorUnregisterInput({ registrationId: "reg-1" }), { registrationId: "reg-1" });
  for (const input of [
    { planId: "p", requestId: "r", extra: 1 },
    { planId: "../p", requestId: "r" },
    {},
    { jobId: "a/b" },
    { registrationId: "a b" },
  ]) {
    assert.throws(
      () => {
        if ("planId" in input || !Object.keys(input).length) parseCreatorExecuteInput(input);
        else if ("jobId" in input) parseCreatorJobInput(input);
        else parseCreatorUnregisterInput(input);
      },
      (error: unknown) => error instanceof CreatorPublicError && code(error) === "creator/invalid-input",
      JSON.stringify(input),
    );
  }
});
