# DSH Spaces Core

Shared isolation rules, registry domain operations, and the maintenance locking contract. The desktop adapter and Host plugin consume the same source. Filesystem access, process management and Cordis/React integration belong to adapters.

Fault policy: [docs/let-it-crash.md](../../docs/let-it-crash.md). This package does not define a recovery core. Historical recovery state machines in the source (`recovery-required`, restore ports) are a runtime gap for R1–R2, not current domain requirements.

Build from the repository root with `npm run build:spaces`. This package does not install or start DSH.
