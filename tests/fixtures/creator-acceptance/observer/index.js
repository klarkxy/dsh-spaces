/**
 * Creator acceptance observer fixture (test-only, read-only).
 *
 * Injects only `loader` + `profileContext` so it activates even when `tools`
 * or other services are absent. `tools` is consumed through an inner
 * ctx.inject(['tools']) — never via bare ctx.tools, which fails without an
 * injection boundary in Cordis. toolsInjected in the evidence file says
 * whether the tools witness actually ran; it is never assumed.
 *
 * On a bounded interval it writes one JSON evidence file per profile to
 * $DSH_CREATOR_OBSERVER_OUT/<profile>.json:
 *   - toolsInjected / tools / toolsError
 *   - services: boolean presence of sessions/sessionStore/llm/fs/attachments/tools
 *   - loaderEntries: {id, name, disabled, fiberState, error} per loader entry —
 *     the error is the entry fiber's own startup rejection, read via await()
 *     with a bounded race, never fabricated
 *   - observerErrors: this fixture's own failures, recorded not swallowed
 * It never registers, restricts, guards or executes a tool; never reads
 * config values, credentials, or session content.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const name = "dsh-creator-tools-observer";
export const inject = ["loader", "profileContext"];

const SERVICES = ["sessions", "sessionStore", "llm", "fs", "attachments", "tools"];
const SAMPLE_MS = 2_000;
const AWAIT_RACE_MS = 2_000;
const ERROR_CAP = 16;

function evidencePath(profileName) {
  const root = process.env.DSH_CREATOR_OBSERVER_OUT;
  if (!root) return null;
  return join(root, `${String(profileName || "unknown")}.json`);
}

function sanitize(text) {
  return String(text)
    .replace(/[?&]token=[^&\s"']+/gi, "[redacted]")
    .replace(/Bearer [a-f0-9]{16,}/gi, "Bearer [redacted]")
    .replace(/dsh-auth-[^=]+=[^;\s"']+/gi, "[redacted]");
}

async function entryError(fiber) {
  if (!fiber || typeof fiber.await !== "function") return null;
  try {
    return await Promise.race([
      fiber.await().then(() => null),
      new Promise((resolve) => setTimeout(() => resolve("await-timeout"), AWAIT_RACE_MS)),
    ]);
  } catch (error) {
    return sanitize(error?.message ?? error).slice(0, 400);
  }
}

export function apply(ctx) {
  const profileName = ctx.profileContext?.name ?? "unknown";
  const path = evidencePath(profileName);
  if (!path) return;
  const observerErrors = [];
  let writing = false;
  let toolsService = null;
  const note = (prefix, error) => {
    if (observerErrors.length < ERROR_CAP) {
      observerErrors.push(sanitize(`${prefix}: ${error?.message ?? error}`).slice(0, 400));
    }
  };

  const snapshot = async () => {
    if (writing) return;
    writing = true;
    const record = { profile: profileName, at: new Date().toISOString() };
    try {
      record.toolsInjected = toolsService !== null;
      try {
        record.tools = toolsService
          ? toolsService.definitions()
              .map((def) => def?.name)
              .filter((value) => typeof value === "string")
              .sort()
          : null;
        if (toolsService) delete record.toolsError;
        else record.toolsError = "tools service not injected in this profile";
      } catch (error) {
        record.tools = null;
        record.toolsError = sanitize(error?.message ?? error).slice(0, 200);
      }
      // Services presence only — no config, no contents.
      record.services = {};
      for (const svc of SERVICES) {
        try {
          record.services[svc] = ctx.get(svc, false) !== undefined;
        } catch (error) {
          record.services[svc] = `error: ${sanitize(error?.message ?? error).slice(0, 120)}`;
        }
      }
      try {
        const entries = [];
        for (const entry of ctx.loader.entries()) {
          const fiber = entry.fiber;
          entries.push({
            id: entry.options?.id ?? entry.id,
            name: entry.options?.name,
            disabled: Boolean(entry.disabled),
            fiberState: fiber?.state ?? null,
            error: fiber?.state === 2 ? null : await entryError(fiber).catch((e) => `observer: ${sanitize(e?.message ?? e)}`),
          });
        }
        record.loaderEntries = entries;
      } catch (error) {
        record.loaderEntries = null;
        note("loader entries", error);
      }
    } catch (error) {
      note("snapshot", error);
    }
    record.observerErrors = [...observerErrors];
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    } catch (error) {
      try {
        ctx.logger?.error?.("creator-tools-observer evidence write failed:", sanitize(error?.message ?? error));
      } catch {
        /* logger itself unavailable */
      }
    } finally {
      writing = false;
    }
  };

  const fire = () => void snapshot();
  // Inner inject: tools witness only, disposed with the injection. The outer
  // ctx (loader diagnostics, services presence, timer) is never blocked on it.
  try {
    ctx.inject(["tools"], (ready) => {
      toolsService = ready.tools;
      const offChange = ready.on?.("tools/change", fire);
      fire();
      ready.effect(() => () => {
        toolsService = null;
        if (typeof offChange === "function") offChange();
      });
    });
  } catch (error) {
    note("tools inject", error);
  }
  fire();
  const timer = setInterval(fire, SAMPLE_MS);
  if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
  ctx.effect(() => () => {
    clearInterval(timer);
    fire();
  });
}

export default { name, inject, apply };
