# Migration test retirement gate

This suite is intentionally temporary, but it still protects an active operational path. Do not retire it independently from the migration commands and runtime compatibility checks.

Retire the directory only after all of the following are true:

- two complete rehearsals against an isolated production-history copy have passed and their reports are retained;
- backup restore, interrupted-run recovery, service-stop, and final cutover evidence has passed;
- production no longer contains pre-2.01 Memory state and the migration entry points are no longer needed;
- `migrate:memory-v2`, `migrate:memory-v2-data`, schema inspection, rebuild/resume, and runtime cutover-error references are removed in the same change;
- remaining schema invariants that still matter after cutover have moved to persistence or integration coverage.

The repository does not currently meet this gate: the launch audit is No-Go and records that rehearsal and cutover have not run. Until that evidence exists, `npm run test:memory-v2:migration` remains part of the offline regression suite.
