import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DesktopController,
  DesktopReadOnlyError,
  DesktopTransferError,
  createDesktopController,
  createDesktopHomeControl,
  guardDesktopWriteIpc,
  isRefreshWrite,
} from "../src/adapters/desktop/index.ts";
import {
  HOME_CONTROL_DIR_NAME,
  HOME_CONTROL_OWNER_FILE,
  HOME_CONTROL_RUN_DIR_NAME,
  HomeController,
  type PidLiveness,
} from "../src/adapters/node/home-controller.ts";
import { ControllerStatus } from "../src/renderer/src/components/ControllerStatus.tsx";
import {
  DESKTOP_WRITE_IPC_CHANNELS,
  desktopSelectAccess,
  isFullSpacesManagerSpec,
  shouldDesktopAutoLaunch,
  type DesktopControllerState,
} from "../src/shared/desktop-controller.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-spaces-desktop-ctl-"));
  temps.push(home);
  mkdirSync(join(home, "profiles"), { recursive: true });
  mkdirSync(join(home, "hub"), { recursive: true });
  return home;
}

function ownerFile(home: string): string {
  return join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_RUN_DIR_NAME, HOME_CONTROL_OWNER_FILE);
}

function fingerprint(home: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(home, full).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        walk(full);
      } else {
        const hash = createHash("sha256").update(readFileSync(full)).digest("hex");
        out.push(`${rel}:${hash}`);
      }
    }
  };
  walk(home);
  return out.sort();
}

function session(
  home: string,
  extra: {
    pidAlive?: (pid: number, startedAt: string) => PidLiveness;
    stopOwned?: () => Promise<void>;
    drainPlugins?: () => Promise<void>;
    clearViews?: () => void;
    profileNames?: () => string[];
  } = {},
): DesktopController {
  return createDesktopController(home, {
    homeControl: createDesktopHomeControl(home),
    pidAlive: extra.pidAlive,
    stopOwned: extra.stopOwned,
    drainPlugins: extra.drainPlugins,
    clearViews: extra.clearViews,
    profileNames: extra.profileNames,
  });
}

test("ROOT: damaged manager identity blocks server-side writes", async () => {
  const home = tempHome();
  const desktop = session(home);
  desktop.acquireOnStart();
  await desktop.hydrateManager();
  writeFileSync(join(home, HOME_CONTROL_DIR_NAME, "manager.json"), "{broken");
  await desktop.hydrateManager();
  assert.equal(desktop.state().recoveryRequired, true);
  let changed = false;
  await assert.rejects(async () => desktop.mutate(() => { changed = true; }));
  assert.equal(changed, false);
  await desktop.release();
});

test("ROOT: pending web jobs are not bypassed by desktop takeover", async () => {
  const home = tempHome();
  const directory = join(home, HOME_CONTROL_DIR_NAME, "jobs");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "interrupted.json"), JSON.stringify({ schemaVersion: 1, status: "running" }));
  const desktop = session(home);
  desktop.acquireExplicit();
  await desktop.hydrateManager();
  await assert.rejects(async () => desktop.mutate(() => undefined));
  await desktop.release();
});

test("two controllers conflict: live web owner makes desktop read-only", () => {
  const home = tempHome();
  const web = new HomeController(home).acquire("web");
  const desktop = session(home);
  const state = desktop.acquireOnStart();
  assert.equal(desktop.writable, false);
  assert.equal(state.ownerKind, "web");
  assert.equal(state.writable, false);
  assert.equal(state.recoveryRequired, false);
  assert.equal(state.transferPending, false);
  assert.match(state.reasons[0] ?? "", /web workbench/i);
  assert.equal(JSON.stringify(state).includes(String(process.pid)), false);
  assert.doesNotMatch(JSON.stringify(state), /nonce|token|\\|\/run\//i);
  web.release();
});

test("read-only start does not write Home, bootstrap, recover, or mutate", async () => {
  const home = tempHome();
  writeFileSync(join(home, "hub", "spaces.json"), `${JSON.stringify({ version: 1, order: [], meta: {} })}\n`);
  const web = new HomeController(home).acquire("web");
  const before = fingerprint(home);
  const desktop = session(home);
  desktop.acquireOnStart();
  assert.equal(desktop.writable, false);
  assert.throws(() => {
    void desktop.mutate(async () => "no");
  }, DesktopReadOnlyError);
  assert.throws(() => {
    void desktop.runMaintenance("startup-recovery", async () => "no");
  }, DesktopReadOnlyError);
  assert.deepEqual(fingerprint(home), before);
  web.release();
});

test("explicit release stops in order and failed stop keeps the lease", async () => {
  const home = tempHome();
  const order: string[] = [];
  const desktop = session(home, {
    drainPlugins: async () => {
      order.push("plugins");
    },
    stopOwned: async () => {
      order.push("stop");
    },
    clearViews: () => {
      order.push("views");
    },
  });
  desktop.acquireOnStart();
  await desktop.hydrateManager();
  assert.equal(desktop.writable, true);
  assert.equal(existsSync(ownerFile(home)), true);

  const mutation = desktop.mutate(async () => {
    order.push("mut-start");
    await delay(30);
    order.push("mut-end");
  });
  const released = desktop.release().then((state) => {
    order.push("released");
    return state;
  });
  await Promise.all([mutation, released]);
  assert.deepEqual(order, ["mut-start", "mut-end", "plugins", "stop", "views", "released"]);
  assert.equal(desktop.writable, false);
  assert.equal(desktop.held, false);
  assert.equal(existsSync(ownerFile(home)), false);

  const failing = session(home, {
    stopOwned: async () => {
      throw new Error("stop failed");
    },
  });
  failing.acquireOnStart();
  await failing.hydrateManager();
  await assert.rejects(() => failing.release(), DesktopTransferError);
  assert.equal(failing.held, true);
  assert.equal(failing.writable, true);
  assert.equal(failing.state().ownerKind, "desktop");
  assert.equal(failing.state().transferPending, false);
  assert.equal(existsSync(ownerFile(home)), true);
});

test("alive, ambiguous, and dead owners are not taken; the ownership record is kept", async () => {
  const home = tempHome();
  let liveness: PidLiveness = "alive";
  const web = new HomeController(home, { pidAlive: () => liveness }).acquire("web");
  const desktop = session(home, { pidAlive: () => liveness });
  desktop.acquireOnStart();
  assert.equal(desktop.writable, false);
  assert.throws(() => desktop.acquireExplicit(), DesktopReadOnlyError);
  assert.equal(existsSync(ownerFile(home)), true);

  liveness = "ambiguous";
  assert.equal(desktop.acquireOnStart().recoveryRequired, true);
  assert.throws(() => desktop.acquireExplicit(), /ambiguous/i);
  assert.equal(desktop.writable, false);
  assert.equal(existsSync(ownerFile(home)), true);

  liveness = "dead";
  const stillReadOnly = desktop.acquireOnStart();
  assert.equal(stillReadOnly.writable, false);
  assert.equal(stillReadOnly.recoveryRequired, true);
  assert.equal(existsSync(ownerFile(home)), true);
  assert.throws(
    () => desktop.acquireExplicit(),
    (error: unknown) => {
      assert.ok(error instanceof DesktopReadOnlyError);
      assert.match(error.message, /dead/i);
      assert.doesNotMatch(error.message, /reclaim|recover|restore/i);
      return true;
    },
  );
  assert.equal(desktop.writable, false);
  assert.equal(desktop.held, false);
  assert.equal(existsSync(ownerFile(home)), true);
  const after = JSON.parse(readFileSync(ownerFile(home), "utf8")) as { kind?: string };
  assert.equal(after.kind, "web");
  void web;
});

test("release waits for maintenance without taking a second maintenance lock", async () => {
  const home = tempHome();
  const order: string[] = [];
  const desktop = session(home, {
    drainPlugins: async () => {
      order.push("plugins");
    },
    stopOwned: async () => {
      order.push("stop");
    },
  });
  desktop.acquireOnStart();
  await desktop.hydrateManager();
  const upgrade = desktop.runMaintenance("upgrade", async () => {
    order.push("up-start");
    await delay(40);
    order.push("up-end");
    return "ok";
  });
  await delay(5);
  const releasing = desktop.release().then(() => {
    order.push("released");
  });
  assert.equal(await upgrade, "ok");
  await releasing;
  assert.deepEqual(order, ["up-start", "up-end", "plugins", "stop", "released"]);
});

test("write IPC channels cannot bypass a read-only controller", () => {
  const home = tempHome();
  new HomeController(home).acquire("web");
  const desktop = session(home);
  desktop.acquireOnStart();
  for (const channel of DESKTOP_WRITE_IPC_CHANNELS) {
    assert.throws(() => guardDesktopWriteIpc(desktop, channel), DesktopReadOnlyError);
  }
  assert.equal(isRefreshWrite("getPluginCatalog", true), true);
  assert.throws(() => desktop.assertWritable("getPluginCatalog"), DesktopReadOnlyError);
  guardDesktopWriteIpc(desktop, "listProfiles");
  const catalog = desktop.readPluginCatalog("https://example.invalid/catalog.json");
  assert.equal(catalog.source === "seed" || catalog.source === "cache", true);
  assert.deepEqual(desktop.readPluginLibrary(), []);
});

test("default auto-launch does not run until a writable owner is known", () => {
  assert.equal(shouldDesktopAutoLaunch(null), false);
  const readonlyState: DesktopControllerState = {
    ownerKind: "web",
    held: false,
    writable: false,
    recoveryRequired: false,
    reasons: ["The web workbench holds this Home."],
    transferPending: false,
  };
  assert.equal(shouldDesktopAutoLaunch(readonlyState), false);
  assert.equal(desktopSelectAccess(false, false), "deny");
  assert.equal(desktopSelectAccess(false, true), "attach");
  assert.equal(desktopSelectAccess(true, false), "start");
  assert.equal(
    shouldDesktopAutoLaunch({
      ownerKind: "desktop",
      held: true,
      writable: true,
      recoveryRequired: false,
      reasons: [],
      transferPending: false,
    }),
    true,
  );
  assert.equal(
    shouldDesktopAutoLaunch({
      ownerKind: "desktop",
      held: true,
      writable: false,
      recoveryRequired: false,
      reasons: [],
      transferPending: true,
    }),
    false,
  );
});

test("manager profile and full Spaces plugin are blocked on the ordinary desktop path", async () => {
  const home = tempHome();
  mkdirSync(join(home, "profiles", "notes"), { recursive: true });
  const desktop = session(home, {
    profileNames: () => ["notes", "spaces-hub"].filter((name) => existsSync(join(home, "profiles", name))),
  });
  desktop.acquireOnStart();
  await desktop.hydrateManager();
  assert.equal(desktop.managerId(), "spaces-hub");
  assert.throws(() => desktop.assertMutableProfile("spaces-hub", "delete"), /manager profile/i);
  assert.throws(() => desktop.assertMutableProfile("spaces-hub", "rename"), /manager profile/i);
  desktop.assertMutableProfile("notes", "delete");
  assert.throws(
    () => desktop.assertDesktopPluginMutation(["notes"], "@dsh-spaces/plugin"),
    /full Spaces manager/i,
  );
  assert.throws(
    () => desktop.assertDesktopPluginMutation(["spaces-hub"], "dsh-theme-bamboo"),
    /supervisor maintenance path/i,
  );
  assert.throws(() => desktop.assertOrdinaryPluginSpec("@dsh-spaces/plugin"), /copied/i);
  assert.equal(isFullSpacesManagerSpec("@dsh-spaces/plugin@0.2.0"), true);
  assert.equal(isFullSpacesManagerSpec("dsh-outline"), false);
});

test("ControllerStatus renders bilingual takeover and hand-off actions", () => {
  const readonly: DesktopControllerState = {
    ownerKind: "web",
    held: false,
    writable: false,
    recoveryRequired: false,
    reasons: ["The web workbench holds this Home."],
    transferPending: false,
  };
  const zh = renderToStaticMarkup(
    React.createElement(ControllerStatus, {
      state: readonly,
      locale: "zh",
      onAcquire() {},
      onRelease() {},
    }),
  );
  assert.match(zh, /只读/);
  assert.match(zh, /接管/);
  const owner: DesktopControllerState = {
    ownerKind: "desktop",
    held: true,
    writable: true,
    recoveryRequired: false,
    reasons: [],
    transferPending: false,
  };
  const en = renderToStaticMarkup(
    React.createElement(ControllerStatus, {
      state: owner,
      locale: "en",
      onAcquire() {},
      onRelease() {},
    }),
  );
  assert.match(en, /Desktop controls this Home/);
  assert.match(en, /Hand off/);
  const heldRecovery: DesktopControllerState = {
    ownerKind: "desktop",
    held: true,
    writable: false,
    recoveryRequired: true,
    reasons: ["Holding Home control. Fault or leftover evidence was reported; writes are blocked."],
    transferPending: false,
  };
  const heldZh = renderToStaticMarkup(
    React.createElement(ControllerStatus, {
      state: heldRecovery,
      locale: "zh",
      onAcquire() {},
      onRelease() {},
    }),
  );
  assert.match(heldZh, /保留控制权/);
  assert.doesNotMatch(heldZh, /未取得运行权/);
  assert.match(heldZh, /移交/);
});

test("leftover instance records and truncated jobs block writes without rewriting jobs", async () => {
  const home = tempHome();
  const jobs = join(home, HOME_CONTROL_DIR_NAME, "jobs");
  mkdirSync(jobs, { recursive: true });
  const jobFile = join(jobs, "cut.json");
  const original = JSON.stringify({ schemaVersion: 1, status: "queued" });
  writeFileSync(jobFile, original);
  const desktop = session(home);
  desktop.acquireOnStart();
  await desktop.hydrateManager();
  assert.equal(desktop.held, true);
  assert.equal(desktop.writable, false);
  await assert.rejects(async () => desktop.runMaintenance("upgrade", async () => "no"));
  assert.equal(readFileSync(jobFile, "utf8"), original);

  const home2 = tempHome();
  mkdirSync(join(home2, HOME_CONTROL_DIR_NAME, "instances"), { recursive: true });
  writeFileSync(
    join(home2, HOME_CONTROL_DIR_NAME, "instances", "notes.json"),
    JSON.stringify({ version: 1, spaceId: "notes", pid: 9, startedAt: "2026-01-01T00:00:00.000Z" }),
  );
  const blocked = session(home2);
  blocked.acquireOnStart();
  await blocked.hydrateManager();
  await assert.rejects(async () => blocked.mutate(() => "no"));
  await blocked.release();
  assert.equal(blocked.held, false);
});

test("library packageName is authoritative and aliases cannot target the manager", async () => {
  const home = tempHome();
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(
    join(home, "hub", "plugin-library.json"),
    `${JSON.stringify({
      plugins: [
        {
          id: "pretty-theme",
          spec: "npm:@dsh-spaces/plugin",
          packageName: "@dsh-spaces/plugin",
          title: "Pretty",
          source: "manual",
          downloadedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    })}\n`,
  );
  const desktop = session(home, { profileNames: () => ["notes", "spaces-hub"] });
  desktop.acquireOnStart();
  await desktop.hydrateManager();
  assert.throws(() => desktop.assertDesktopPluginMutation(["notes"], "pretty-theme"), /full Spaces manager/i);
  assert.throws(() => desktop.assertDesktopPluginMutation(["spaces-hub"], "pretty-theme"), /supervisor maintenance path/i);
  assert.throws(() => desktop.assertOrdinaryPluginSpec("npm:@dsh-spaces/plugin"), /copied|aliases|full Spaces/i);
  assert.throws(() => desktop.resolvePluginIdentity("C:\\\\tmp\\\\theme.tgz"), /library metadata/i);
});

test("recovery still allows release without admitting ordinary writes", async () => {
  const home = tempHome();
  const desktop = session(home);
  desktop.acquireOnStart();
  await desktop.hydrateManager();
  writeFileSync(join(home, HOME_CONTROL_DIR_NAME, "manager.json"), "{broken");
  await desktop.hydrateManager();
  assert.equal(desktop.held, true);
  assert.equal(desktop.writable, false);
  await desktop.release();
  assert.equal(desktop.held, false);
});
