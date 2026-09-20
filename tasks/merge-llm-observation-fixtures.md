# LLM applyPlan observation fixture cutover

Tests only. No production, Git, credentials, or real Home.

`parseObservations` requires `serviceEpoch` (64 lowercase hex). Fixture records and applyPlan observation arrays in `tests/llm-api-auth.test.ts` now use fixed `a`.repeat(64). Busy / unknown / partial A-then-B-fail-C-unexecuted assertions are unchanged.

Added `applyPlan rejects missing or stale serviceEpoch before any restart`: missing field → `LLM_CONFIG_INVALID`, old epoch → `LLM_APPLY_FAILED`, `ran` stays empty.

Owned `test:llm` / `test:llm:integration` files besides `llm-api-auth.test.ts` had no live applyPlan observation arrays missing epoch (`llm-secret-leaks` still injects `apiKey` to prove jobs reject secrets). `tests/llm-ui.test.tsx` already used 64-hex epoch.

Outside this suite: leftover apply observations without epoch, if any, were not edited.
