# Lifecycle verifier (A3 / A9)

Script: `scripts/verify-lifecycle.mjs`
Commands:

```text
node scripts/verify-lifecycle.mjs --syntax
node scripts/verify-lifecycle.mjs
node scripts/verify-lifecycle.mjs --home <sandbox-dsh-home>
```

Env: `DSH_TEST_BIN` or `DSH_TEST_CLI_BIN` (preserved; explicit path must exist). Default CLI discovery is still AppData global `lib/bin.js`, then `npm root -g`.

## Why

The old gate POSTed unauthenticated legacy `/api/session.list` bodies. Official CLI requires exchanging the announced launch token for a `dsh-auth-*` session cookie and the typed transport used by `scripts/validate-isolation.mjs`.

## What this leaf changed

- Import-safe reuse of `waitForApi(port, logPath, timeout)` and `rpc(port, method, payload, cookie)` from `scripts/validate-isolation.mjs` (read-only; this leaf did not edit isolation, including any `_request` → `request` typed-arg follow-up).
- Each owned child stdout/stderr is appended to `$DSH_HOME/testlogs/<profile>.log`. Announced token URLs and cookies are never printed (`redact`).
- Cookies are stored **per port**. Restarting coding deletes port 3221’s cookie, waits for that port to close, respawns, then `waitForApi` exchanges a new cookie. Web (3220) and writing (3222) cookies stay.
- A3: web + coding + writing APIs in parallel on **3220 / 3221 / 3222**. A9: restart coding only; web and writing `session.list` JSON must be unchanged; coding answers again.
- Cleanup kills **this run’s PIDs** (`taskkill /T /F` on Windows, `SIGTERM` elsewhere), then requires those three test ports to close. It does not kill whatever happens to occupy the port.
- Before any write: refuse Home when `resolve` / `realpath` / symlink-or-junction target is the real `~/.dsh` or nested under it.
- Before spawn: fail if 3220/3221/3222 are already open so an external listener cannot count as this gate.

`--syntax` is static: `node --check`, export presence, Home-guard probes. No official CLI, no bound lifecycle ports, no live profiles.

## This leaf did not run the live gate

Primary’s isolation slot is running. This leaf ran **`--syntax` only**. Primary should run `node scripts/verify-lifecycle.mjs` (with `DSH_TEST_BIN` / `DSH_TEST_CLI_BIN` as already set) after that slot is free. Isolation uses 3120–3122; this gate keeps 3220–3222.

Not edited: `validate-isolation.mjs`, app/UI source, other scripts, Git, config, credentials, `package.json`, builds.

## `--syntax` result

```text
PASS  node --check passed
PASS  reuses isolation waitForApi(port, logPath, timeout) and rpc(port, method, payload, cookie)
PASS  HOME realpath, nested path, and junction into ~/.dsh are refused

LIFECYCLE GATE SYNTAX: PASS
```

The junction probe created a temporary directory junction in `os.tmpdir()` pointing at the path of `~/.dsh`, asserted refuse, then deleted the temp tree. It did not write inside `~/.dsh`. Live A3/A9 evidence is not claimed here.
