import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PatchWriter, assertDumpPatched } from "../src/main/patch-writer.ts";
import { ProfileRegistry } from "../src/main/profile-registry.ts";
import { writeSettings } from "../src/main/hub-settings.ts";
import { NODE_VERSION, PNPM_VERSION } from "../src/main/package-source.ts";
import { DEFAULT_HUB_SETTINGS } from "../src/shared/types.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const bin = resolve(
  process.env.DSH_TEST_BIN ??
    "C:/Users/admin/AppData/Local/Temp/spaces-runtime-install-fIEaas/versions/0.1.5-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js",
);
const playwrightModule =
  process.env.DSH_TEST_PLAYWRIGHT_MODULE ??
  "C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
const nodeZip = process.env.DSH_TEST_NODE_ZIP ?? join(tmpdir(), `node-v${NODE_VERSION}-win-x64.zip`);
const userPnpm = join(process.env.APPDATA ?? "", "dsh-spaces", "toolchain", "pnpm");
const evidence = resolve(repo, ".sandbox/spaces-desktop-acceptance");
const realHome = resolve(homedir(), ".dsh");
const packagedExe = process.env.DSH_TEST_PACKAGED_EXE?.trim() || "";
const installerPath = process.env.DSH_TEST_INSTALLER?.trim() || "";
const locale = process.env.DSH_TEST_LOCALE === "zh" ? "zh" : "en";
const prereqOnly = process.argv.includes("--prereq") || process.env.DSH_TEST_DESKTOP_PREREQ === "1";
const productName = pkg.build?.productName || "DSH Spaces";
const expectedUnpackedExe = join(repo, pkg.build?.directories?.output || "release", "win-unpacked", `${productName}.exe`);
const expectedInstaller = join(repo, pkg.build?.directories?.output || "release", `${productName} Setup ${pkg.version}.exe`);
const packCommand = "npx electron-builder --win nsis --publish never";

function samePath(a, b) {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function refuseRealHome(home) {
  const resolved = resolve(home);
  if (samePath(resolved, realHome) || resolved.toLowerCase().startsWith(realHome.toLowerCase() + sep)) {
    throw new Error("refusing real ~/.dsh");
  }
}

function find7z() {
  const candidates = [
    "7z",
    "7za",
    join(process.env["ProgramFiles"] ?? "C:/Program Files", "7-Zip", "7z.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "7-Zip", "7z.exe"),
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--help"], { encoding: "utf8", timeout: 8_000, windowsHide: true });
    if (probe.error) continue;
    if (probe.status === 0 || (probe.stdout || probe.stderr || "").includes("7-Zip")) return candidate;
  }
  return null;
}

function inspectInstaller(path) {
  if (!existsSync(path)) return { path, exists: false };
  const stat = statSync(path);
  const listing = { path, exists: true, bytes: stat.size, listed: false };
  const seven = find7z();
  if (!seven) {
    listing.note = "7z not on PATH; installer was not extracted or executed";
    return listing;
  }
  const listed = spawnSync(seven, ["l", path], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  listing.listed = listed.status === 0;
  listing.tool = seven;
  listing.names = (listed.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /app\.asar|DSH Spaces\.exe|resources\\app/i.test(line))
    .slice(0, 20);
  listing.note = "7z l only; installer was not executed and no files were written";
  return listing;
}

function packagedLayout(exe) {
  const dir = dirname(exe);
  return {
    exe,
    asar: existsSync(join(dir, "resources", "app.asar")),
    unpackedWorker: existsSync(join(dir, "resources", "app.asar.unpacked", "out", "main", "snapshot-worker.mjs")),
  };
}

function collectPrereq() {
  const winTargets = pkg.build?.win?.target ?? [];
  const fixtures = {
    dshBin: existsSync(bin),
    playwright: existsSync(playwrightModule),
    nodeZip: existsSync(nodeZip),
    pnpm: existsSync(join(userPnpm, "node_modules", "pnpm", "bin", "pnpm.cjs")),
    unpackagedMain: existsSync(join(repo, "out", "main", "index.js")),
  };
  const problems = [];
  if (!winTargets.includes("nsis")) problems.push("package.json build.win.target must include nsis");
  if (pkg.build?.directories?.output !== "release") problems.push("package.json build.directories.output is not release");
  if (productName !== "DSH Spaces") problems.push(`unexpected productName ${productName}`);
  if (!fixtures.dshBin) problems.push(`DSH fixture CLI missing: ${bin}`);
  if (!fixtures.playwright) problems.push(`Playwright missing: ${playwrightModule}`);
  if (!fixtures.nodeZip) problems.push(`Node ${NODE_VERSION} zip missing: ${nodeZip}`);
  if (!fixtures.pnpm) problems.push("local pnpm.cjs missing");
  if (packagedExe) {
    if (!existsSync(packagedExe)) {
      problems.push(`DSH_TEST_PACKAGED_EXE missing: ${packagedExe}. Build with: npm run build && ${packCommand}`);
    } else {
      const layout = packagedLayout(packagedExe);
      if (!layout.asar) {
        problems.push(`${packagedExe} has no sibling resources/app.asar; pass the unpacked/installed app exe, not the NSIS Setup installer`);
      }
    }
  } else if (!fixtures.unpackagedMain) {
    problems.push("out/main/index.js is missing; npm run build first (unpackaged mode)");
  }
  if (installerPath && !existsSync(installerPath)) problems.push(`DSH_TEST_INSTALLER missing: ${installerPath}`);
  return {
    status: problems.length ? "fail" : "ready",
    problems,
    packaged: Boolean(packagedExe),
    locale,
    version: pkg.version,
    packCommand: `npm run build && ${packCommand}`,
    exeEntry: packagedExe || expectedUnpackedExe,
    expectedUnpackedExe,
    expectedInstaller,
    onDiskUnpacked: existsSync(expectedUnpackedExe),
    onDiskInstaller: existsSync(expectedInstaller),
    installerInspect: inspectInstaller(installerPath || (existsSync(expectedInstaller) ? expectedInstaller : "")),
    nsis: {
      oneClickDefault: true,
      perUserDefaultDir: `%LOCALAPPDATA%\\Programs\\${productName}`,
      silentInstall: `"${expectedInstaller}" /S /currentuser /D=<temp-dir>`,
      silentUninstall: `"<temp-dir>\\Uninstall ${productName}.exe" /S`,
      dSwitch: "/D must be last, unquoted, even with spaces; honored by electron-builder multiUser.nsh",
      uiClickForbidden: true,
    },
    fixtures,
    evidence,
  };
}

const prereq = collectPrereq();
mkdirSync(evidence, { recursive: true });
writeFileSync(join(evidence, "prereq.json"), `${JSON.stringify(prereq, null, 2)}\n`);
if (prereq.status !== "ready") {
  console.error(prereq.problems.join("\n"));
  process.exit(1);
}
console.log("PASS desktop prereq");
console.log(`DESKTOP_PACK_CMD=${prereq.packCommand}`);
console.log(`DESKTOP_EXE_ENTRY=${prereq.exeEntry}`);
console.log(`DESKTOP_INSTALLER=${expectedInstaller}`);
console.log(`DESKTOP_EVIDENCE=${evidence}`);
if (prereqOnly) {
  console.log("DESKTOP_PREREQ_ONLY=1 (did not launch Electron or run NSIS)");
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "spaces-desktop-"));
const home = join(root, "home");
const userData = join(root, "app");
const toolchain = join(root, "toolchain");
mkdirSync(home);
mkdirSync(join(userData, "runtimes"), { recursive: true });
mkdirSync(join(toolchain, "node"), { recursive: true });
assert.ok(!isAbsolute(relative(tmpdir(), root)) && !relative(tmpdir(), root).startsWith(".."));
refuseRealHome(home);
refuseRealHome(userData);

function cli(...args) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, DSH_HOME: home },
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr ?? "cli failed");
  return result.stdout;
}

const extracted = spawnSync("tar", ["-xf", nodeZip, "-C", join(toolchain, "node")], {
  encoding: "utf8",
  timeout: 60_000,
  windowsHide: true,
});
assert.equal(extracted.status, 0, extracted.stderr || extracted.stdout || "node zip extract failed");
assert.ok(existsSync(join(toolchain, "node", `node-v${NODE_VERSION}-win-x64`, "node.exe")));
symlinkSync(userPnpm, join(toolchain, "pnpm"), process.platform === "win32" ? "junction" : "dir");
writeFileSync(
  join(toolchain, "config.json"),
  `${JSON.stringify({ packageSource: "china", nodeVersion: NODE_VERSION, pnpmVersion: PNPM_VERSION }, null, 2)}\n`,
);

cli("--profile", "web", "--dump-config");
cli("--profile", "coding", "--from-default-profile", "web", "--dump-config");
new PatchWriter(home).ensureWorkbenchPatch("coding");
assertDumpPatched(cli("--profile", "coding", "--dump-config"), "coding");
new ProfileRegistry(home).markOnboarded();
writeSettings(home, {
  ...DEFAULT_HUB_SETTINGS,
  locale,
  theme: "dark",
  portStart: 3810,
  portEnd: 3839,
  packageSource: "china",
});
writeFileSync(
  join(userData, "runtimes", "current.json"),
  `${JSON.stringify({ bin, version: "0.1.5-rc.1", origin: "managed" }, null, 2)}\n`,
);

const require = createRequire(import.meta.url);
const { _electron: electron } = require(playwrightModule);
const env = {
  ...process.env,
  DSH_SPACES_HOME: home,
  DSH_SPACES_USER_DATA: userData,
  DSH_SPACES_TOOLCHAIN: toolchain,
  DSH_SPACES_DISABLE_UPDATES: "1",
  DISABLE_UPDATES: "1",
};
delete env.ELECTRON_RUN_AS_NODE;

const chromeArgs = [
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
];
const app = await electron.launch(
  packagedExe
    ? {
        executablePath: resolve(packagedExe),
        args: chromeArgs,
        cwd: dirname(resolve(packagedExe)),
        env,
        timeout: 120_000,
      }
    : {
        executablePath: require("electron"),
        args: [repo, ...chromeArgs],
        cwd: repo,
        env,
        timeout: 120_000,
      },
);

const ports = [];
async function waitUntil(check, timeout = 90_000, label = "condition") {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await delay(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const checks = [];
let presentedSnippet = "";
function pass(label) {
  checks.push(label);
  console.log(`PASS ${label}`);
}

try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  await page.bringToFront();

  const packagedFlag = await app.evaluate(({ app }) => app.isPackaged);
  assert.equal(packagedFlag, Boolean(packagedExe), `app.isPackaged=${packagedFlag} packagedExe=${Boolean(packagedExe)}`);
  const resolvedHome = await page.evaluate(() => window.dshSpaces.getDshHome());
  assert.equal(resolve(resolvedHome), resolve(home));
  refuseRealHome(resolvedHome);
  pass(packagedFlag ? "packaged app.isPackaged true" : "unpackaged app.isPackaged false");

  const windowState = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    const bounds = win.getBounds();
    return {
      visible: win.isVisible(),
      minimized: win.isMinimized(),
      width: bounds.width,
      height: bounds.height,
      title: win.getTitle(),
    };
  });
  assert.ok(windowState?.visible, "main window is not visible");
  assert.equal(windowState.minimized, false);
  assert.ok(windowState.width >= 800 && windowState.height >= 560, "main window smaller than product minimum");
  pass(`main window visible ${windowState.width}x${windowState.height}`);

  const maintenance = await page.evaluate(() => window.dshSpaces.getMaintenance());
  assert.equal(maintenance.error, undefined, `startup recovery error: ${maintenance.error}`);
  assert.equal(maintenance.operation, undefined);
  pass("startup maintenance has no recovery error");

  await waitUntil(async () => {
    const cli = await page.evaluate(() => window.dshSpaces.getCliStatus());
    if (cli.state === "error") throw new Error(cli.message || "cli error");
    return cli.state === "ready";
  }, 90_000, "cli ready without runtime installer");
  await page.getByRole("button", { name: /^(Settings|设置)$/ }).waitFor();
  await page.getByRole("button", { name: /^(New space|新建工作台)$/ }).waitFor();
  pass("shell chrome labels (Settings/设置, New space/新建工作台)");

  async function dshViewScript(port, source) {
    return app.evaluate(async ({ webContents }, payload) => {
      const view = webContents.getAllWebContents().find((w) => w.getURL().startsWith(`http://127.0.0.1:${payload.port}/`));
      if (!view || view.isLoading()) return null;
      return view.executeJavaScript(payload.source);
    }, { port, source });
  }

  async function waitForAuthView(port, label) {
    await waitUntil(
      () =>
        dshViewScript(
          port,
          `document.body.innerText.length > 100 && !document.body.innerText.includes('dsh web authentication required')`,
        ),
      60_000,
      label,
    );
    return dshViewScript(
      port,
      `fetch('/api/session/list',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'session/list',payload:{args:{_request:{}}}})}).then(async r=>({status:r.status,ok:(await r.json()).result?.ok}))`,
    );
  }

  async function skipDshIntro(port) {
    const step = await waitUntil(async () => {
      const result = await dshViewScript(
        port,
        `(() => {
          const nodes = [...document.querySelectorAll('button, a, [role="button"]')];
          const label = (el) => (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
          const labels = nodes.map(label);
          const click = (re) => {
            const el = nodes.find((node) => re.test(label(node)));
            if (!el) return false;
            el.click();
            return true;
          };
          const ready = labels.some((text) => /^(New Session|新会话)$/i.test(text));
          const defer = labels.some((text) => /稍后配置|set up later|configure later/i.test(text));
          const intro = labels.some((text) => /^(Continue|继续)$/.test(text));
          const keyField = [...document.querySelectorAll("input, textarea")].some((el) =>
            /password|api\\s*key|密钥/i.test(\`\${el.type} \${el.name} \${el.placeholder} \${el.getAttribute("aria-label") || ""}\`),
          );
          if (keyField && !defer && !intro && !ready) return "blocked-key";
          if (ready && !defer && !intro) return "ready";
          if (defer) return click(/稍后配置|set up later|configure later/i) ? "clicked-defer" : false;
          if (intro) return click(/^(Continue|继续)$/) ? "clicked-intro" : false;
          return false;
        })()`,
      );
      if (result === "blocked-key") throw new Error("DSH API key prompt has no defer control; refusing to enter a key");
      if (result === "ready") return result;
      return false;
    }, 90_000, "skip DSH intro without API key");
    assert.equal(step, "ready");
    const snippet = await dshViewScript(port, `document.body.innerText.slice(0, 800)`);
    assert.match(String(snippet), /New Session|新会话/);
    assert.doesNotMatch(String(snippet), /dsh web authentication required/i);
    return snippet;
  }

  async function captureView(port, file) {
    const png = await app.evaluate(async ({ BrowserWindow }, target) => {
      const win = BrowserWindow.getAllWindows()[0];
      const view = win.contentView.children.find((v) => v.webContents?.getURL().startsWith(`http://127.0.0.1:${target}/`));
      if (!view) throw new Error("DSH view missing");
      return (await view.webContents.capturePage()).toPNG().toString("base64");
    }, port);
    writeFileSync(join(evidence, file), Buffer.from(png, "base64"));
  }

  await page.screenshot({ path: join(evidence, "window.png") });
  const codingRail = page.getByRole("button", { name: /^coding$/i });
  await codingRail.waitFor();
  await codingRail.click();
  const started = await waitUntil(async () => {
    const row = (await page.evaluate(() => window.dshSpaces.listProfiles())).find((p) => p.name === "coding");
    if (row?.status === "crashed") throw new Error(row.lastError || "coding crashed");
    return row?.status === "running" && Number.isInteger(row.port) ? row : null;
  }, 90_000, "coding running after rail click");
  ports.push(started.port);
  const rpc = await waitForAuthView(started.port, "authenticated DSH view");
  assert.equal(rpc.status, 200);
  assert.equal(rpc.ok, true);
  presentedSnippet = String(await skipDshIntro(started.port)).slice(0, 240);
  pass(`coding opened from rail and presented on :${started.port}`);
  await captureView(started.port, "coding.png");

  const restarted = await page.evaluate(() => window.dshSpaces.restartProfile("coding"));
  ports.push(restarted.port);
  await waitUntil(async () => {
    const row = (await page.evaluate(() => window.dshSpaces.listProfiles())).find((p) => p.name === "coding");
    if (row?.status === "crashed") throw new Error(row.lastError || "coding crashed after restart");
    return row?.status === "running" && row.port === restarted.port ? row : null;
  }, 90_000, "coding restart process");
  const rpc2 = await waitForAuthView(restarted.port, "coding view after restart");
  assert.equal(rpc2.status, 200);
  assert.equal(rpc2.ok, true);
  await skipDshIntro(restarted.port);
  pass(`coding restart running on :${restarted.port}`);

  const meta = await page.evaluate(() => window.dshSpaces.updateMeta("coding", { displayName: "Coding Desk" }));
  assert.equal(meta.displayName, "Coding Desk");
  const readback = (await page.evaluate(() => window.dshSpaces.listProfiles())).find((p) => p.name === "coding");
  assert.equal(readback.meta.displayName, "Coding Desk");
  assert.equal(existsSync(join(home, ".dsh-spaces-lock")), false);
  pass("updateMeta IPC readback (DesktopHomeControl mutation lock released)");

  await page.evaluate(() => window.dshSpaces.stopProfile("coding"));
  await waitUntil(async () => {
    const row = (await page.evaluate(() => window.dshSpaces.listProfiles())).find((p) => p.name === "coding");
    return row?.status === "stopped";
  }, 30_000, "coding stopped");
  for (const row of await page.evaluate(() => window.dshSpaces.listProfiles())) {
    if (Number.isInteger(row.port)) ports.push(row.port);
  }
  const closed = app.waitForEvent("close", { timeout: 20_000 });
  await page.evaluate(() => window.dshSpaces.quitApp()).catch(() => {});
  await closed;
  pass("stop and quitApp");
} catch (error) {
  const profiles = await app
    .evaluate(async ({ BrowserWindow }) => {
      const page = BrowserWindow.getAllWindows()[0];
      return page?.webContents.executeJavaScript("window.dshSpaces.listProfiles()").catch(() => []);
    })
    .catch(() => []);
  const views = await app
    .evaluate(async ({ webContents }) => {
      const local = webContents.getAllWebContents().filter((w) => w.getURL().startsWith("http://127.0.0.1:"));
      return Promise.all(
        local.map(async (w) => ({
          url: new URL(w.getURL()).origin,
          loading: w.isLoading(),
          text: await w.executeJavaScript("document.body.innerText.slice(0,400)").catch(() => "<unavailable>").then((value) => String(value).replace(/[?&]token=[^&\\s]+/gi, "[redacted-token]")),
        })),
      );
    })
    .catch(() => []);
  writeFileSync(
    join(evidence, "failure.json"),
    `${JSON.stringify({ message: String(error), profiles, views, home, userData }, null, 2)}\n`,
  );
  console.error("FAIL sanitized evidence written to .sandbox/spaces-desktop-acceptance/failure.json");
  throw error;
} finally {
  await app.close().catch(() => {});
}

for (const port of new Set(ports)) {
  await new Promise((resolveClosed, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); reject(new Error(`Owned port ${port} is still open`)); });
    socket.once("error", (error) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolveClosed(); else reject(error);
    });
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error(`Could not confirm shutdown of ${port}`)); });
  });
}
writeFileSync(
  join(evidence, "results.json"),
  `${JSON.stringify({
    status: "pass",
    at: new Date().toISOString(),
    packaged: Boolean(packagedExe),
    locale,
    home,
    userData,
    toolchain,
    exe: packagedExe || require("electron"),
    ports: [...new Set(ports)],
    presented: presentedSnippet.replace(/[?&]token=[^&\s]+/gi, "[redacted-token]"),
    checks,
  }, null, 2)}\n`,
);
console.log("PASS owned ports closed after quit");
console.log(`DESKTOP_SMOKE_ROOT=${root}`);
console.log(`DESKTOP_EVIDENCE=${evidence}`);
console.log(`DESKTOP_PACKAGED=${Boolean(packagedExe)}`);
