import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPluginRestorePoint,
  classifyRestorePath,
  parsePluginRestorePoint,
  serializePluginRestorePoint,
  type PluginRestorePointRecord,
} from "../src/main/plugin-restore-point.ts";

/** Representative measured install tree — not a live CLI dump, but the same fields the probe persists. */
const MEASURED: PluginRestorePointRecord = {
  schemaVersion: 1,
  id: "6f1c0a3e-4b2d-4e11-9c7a-2b8d1e0f4a55",
  createdAt: "2026-09-15T12:00:00.000Z",
  spaceId: "alpha",
  packageName: "@dsh-spaces/write-scope-probe",
  requestedSpec: "C:/probe/dsh-spaces-write-scope-probe-1.0.0.tgz",
  resolvedVersion: "1.0.0",
  action: "install",
  boundary: "independent-per-space",
  linkPreservingCopySufficient: true,
  paths: [
    {
      root: "home",
      rel: "profiles/alpha/package.json",
      kind: "file",
      role: "manifest",
      shared: false,
    },
    {
      root: "home",
      rel: "profiles/alpha/pnpm-lock.yaml",
      kind: "file",
      role: "lock",
      shared: false,
    },
    {
      root: "home",
      rel: "profiles/alpha/node_modules/@dsh-spaces/write-scope-probe",
      kind: "dir",
      role: "dependency",
      shared: false,
    },
    {
      root: "home",
      rel: "profiles/node_modules/@deepseek-ai/dsh-base",
      kind: "link",
      role: "link",
      shared: true,
    },
    {
      root: "store",
      rel: "v10/files/ab/cd/probe-1.0.0.tgz",
      kind: "file",
      role: "dependency",
      shared: true,
    },
  ],
  sharedReferencers: ["beta"],
  contentDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  excluded: {
    sessions: true,
    storages: true,
    otherSpaces: true,
    credentials: true,
    runtime: true,
    unmanagedPluginWrites: true,
  },
};

test("parse/serialize round-trips representative recorded write-scope data", () => {
  const text = serializePluginRestorePoint(MEASURED);
  const parsed = parsePluginRestorePoint(text);
  assert.deepEqual(parsed, MEASURED);
  assert.equal(parsed.paths.some((path) => path.role === "lock"), true);
  assert.equal(parsed.paths.some((path) => path.role === "dependency"), true);
  assert.equal(parsed.paths.some((path) => path.kind === "link" && path.shared), true);
  assert.equal(parsed.excluded.sessions, true);
  assert.equal(parsed.excluded.storages, true);
});

test("buildPluginRestorePoint drops chat/storage paths and keeps measured install files", () => {
  const record = buildPluginRestorePoint({
    ...MEASURED,
    paths: [
      ...MEASURED.paths,
      {
        root: "home",
        rel: "hub/alpha/sessions/chat.jsonl",
        kind: "file",
        role: "other",
        shared: false,
      },
      {
        root: "home",
        rel: "hub/beta/storages/data.json",
        kind: "file",
        role: "other",
        shared: false,
      },
    ],
  });
  assert.equal(record.paths.some((path) => path.rel.includes("sessions")), false);
  assert.equal(record.paths.some((path) => path.rel.includes("storages")), false);
  assert.equal(
    record.paths.some((path) => path.rel === "profiles/alpha/pnpm-lock.yaml" && path.role === "lock"),
    true,
  );
  assert.deepEqual(record.sharedReferencers, ["beta"]);
});

test("parse rejects a record that would restore sessions or skip exclusions", () => {
  assert.throws(
    () =>
      parsePluginRestorePoint({
        ...MEASURED,
        paths: [
          {
            root: "home",
            rel: "hub/alpha/sessions/chat.jsonl",
            kind: "file",
            role: "other",
            shared: false,
          },
        ],
      }),
    /sessions, storages, credentials, or machine identity/,
  );
  assert.throws(
    () =>
      parsePluginRestorePoint({
        ...MEASURED,
        excluded: { ...MEASURED.excluded, sessions: false },
      }),
    /exclude sessions/,
  );
});

test("classifyRestorePath marks shared fallback links and per-space locks", () => {
  assert.deepEqual(classifyRestorePath("profiles/alpha/pnpm-lock.yaml", "file"), {
    role: "lock",
    shared: false,
    excluded: false,
  });
  assert.deepEqual(classifyRestorePath("profiles/node_modules/ms", "link"), {
    role: "link",
    shared: true,
    excluded: false,
  });
  assert.deepEqual(classifyRestorePath("hub/beta/sessions/chat.jsonl", "file"), {
    role: "other",
    shared: false,
    excluded: true,
  });
  assert.deepEqual(classifyRestorePath("v10/index/pkg.json", "file", "store"), {
    role: "dependency",
    shared: true,
    excluded: false,
  });
});
