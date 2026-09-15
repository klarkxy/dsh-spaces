# Q coverage E01–E18 (2026-09-15)

Disposable Homes only. Official DSH CLI was not present in this run.

Covered on shipped entry points: E01, E06, E08, E10, E11, E12, E13, E14, E15, E16, plus unit-level E02/E03/E05/E09/E18.

Unverified against a real DSH CLI/browser: E04; live process-kill E06; Playwright E07; packed manager crash E09; `validate:isolation` E17; `build:spaces` E18 pack.

See `tests/q-let-it-crash.test.ts` and the focused `tsx --test` files listed in the implementer scratch `q-coverage.md`.
