import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileManagedRouteId,
  createConnectionId,
  LLM_ERROR,
} from "../src/core/domain/llm-connections.ts";
import { resolveDefaultModel } from "../src/core/domain/llm-resolution.ts";

const connectionId = createConnectionId();
const shared = { provider: compileManagedRouteId(connectionId), model: "demo-large" };
const space = { provider: compileManagedRouteId(connectionId), model: "demo-small" };
const session = { provider: compileManagedRouteId(connectionId), model: "demo-session" };
const local = { provider: "local-openai", model: "demo-large" };

test("session then space then global then composition, and a missing global fails", () => {
  const available = [shared, space, session, local];
  assert.deepEqual(
    resolveDefaultModel({
      session,
      spaceUser: space,
      globalDefault: { connectionId, modelId: "demo-large" },
      composition: local,
      available,
    }),
    { ...session, source: "session" },
  );
  assert.deepEqual(
    resolveDefaultModel({
      spaceUser: space,
      globalDefault: { connectionId, modelId: "demo-large" },
      composition: local,
      available,
    }),
    { ...space, source: "space" },
  );
  assert.deepEqual(
    resolveDefaultModel({
      globalDefault: { connectionId, modelId: "demo-large" },
      composition: local,
      available,
    }),
    { ...shared, source: "global" },
  );
  assert.deepEqual(
    resolveDefaultModel({
      composition: local,
      available,
    }),
    { ...local, source: "composition" },
  );
  assert.throws(
    () =>
      resolveDefaultModel({
        globalDefault: { connectionId, modelId: "demo-large" },
        available: [local],
      }),
    { code: LLM_ERROR.MODEL_NOT_FOUND },
  );
  assert.throws(
    () =>
      resolveDefaultModel({
        session: { provider: compileManagedRouteId(connectionId), model: "missing" },
        available,
      }),
    { code: LLM_ERROR.MODEL_NOT_FOUND },
  );
});
