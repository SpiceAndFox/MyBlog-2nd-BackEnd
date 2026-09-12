# Chat, Memory work and source mutations

## Ownership

The Chat scope coordinator orders sends and source mutations by `userId:presetId`.
It preserves complete-turn ordering across sessions of the same preset.

The Memory work coordinator orders Memory jobs separately by the same scope.
Normal proposers, Librarian, recovery, projection drains and housekeeping share
this lane. Provider computation never holds the Chat lane. Multiple turn-complete
wakeups coalesce into one active scope processor with a dirty flag for another
pass, rather than creating a backlog of redundant scans.

Chat reads committed Memory, recent raw messages and GapBridge. Ordinary appends
do not change the source generation or cancel the current proposer. Memory may
lag. Coverage diagnostics report gaps beyond the configured raw-context budget;
they do not wait for the Memory provider. The separate privacy fence continues to
reject new writes while an incomplete privacy operation exists.

## Source mutation barrier

`workCoordinator.mutate` is the only runtime entry for source mutation execution:

1. Cancel active and queued Memory work in that scope.
2. Immediately reserve the Chat lane and the Memory lane, so neither a later send
   nor a new Memory job can overtake the mutation.
3. Wait for the prior Memory application work, including transaction completion
   and error persistence, to exit.
4. Run the source transaction under the existing source advisory lock and Memory
   row lock. Update source, generation, authority and durable recovery metadata.
5. Release both lanes. Return the committed raw result; finish cleanup and any
   necessary rebuilding on the Memory lane.

Session/edit use cases still cancel active Chat sends before entering this
barrier. The runtime does not depend on Chat implementation details; its only
injected dependency is the source mutation enqueue function.

Corrupt-state recovery also uses this barrier for its short preparation phase,
because restoring authority or initializing recovery can change the generation.
It waits for an active reply to commit and does not cancel that reply. It releases
the Chat lane before draining the recovered generation on the Memory lane.
A Memory worker that discovers corruption schedules this recovery and exits;
awaiting the barrier from inside that worker would deadlock. Recovery requests
coalesce per scope and respect the privacy fence before both phases.

Cancellation is propagated through normal, maintenance and Librarian provider
calls and projection staging. `abortable` is restricted to external computation
without repository writes. It discards late transport results even when a test
adapter ignores AbortSignal. Never race a whole pipeline or database transaction:
that could release the mutation barrier while a late callback still writes.
Generation/revision/cursor checks at commit remain mandatory. Recovery rechecks
the generation after acquiring its lane, since its task scan may predate a purge.

Shutdown cancels Memory work and drains its application continuations before
database shutdown. Provider cancellation does not depend on model completion.
Database transactions and filesystem cleanup are allowed to finish normally.

## Choosing the rebuild extent

`sourceRebuild.initializeGeneration` owns this decision for all callers:

- A missing mutation result does not initialize a new generation or report a raw
  commit. An affected-message callback returning null denotes an empty session;
  its non-privacy mutation needs no Memory generation change.
- When all target cursors precede the first affected message, the current state
  can be kept if every source reference still exists with the same content hash
  and no cursor exceeds the remaining source boundary.
- A permanent deletion may declare `sourceAlreadyExcluded` only when its SQL
  deletes trashed sessions. Those sessions are already excluded by the source
  reader. The same reference/boundary validation still applies.
- Preserving current state avoids model rebuilding unless it had unfinished
  rebuild targets. Ordinary lag continues through normal background processing.
- Otherwise restore the latest safe snapshot from the previous generation and
  refill from its cursors. If no safe snapshot exists, rebuild from empty state.

Librarian completion can be carried to a new generation only when the **current
state** is preserved and the affected source is strictly beyond the checkpoint
(or was already excluded). Its boundary must still exist within the source
range. Never copy a later Librarian checkpoint onto an older restored snapshot.
The old task ID is not retained because privacy cleanup may remove that task.

Privacy cleanup always removes derived history and verifies external stores,
even when model rebuilding is unnecessary. `operation_payload.memoryRebuildRequired`
persists this decision; legacy operations without it retain their previous rebuild
behavior. No schema migration is required. Concurrent unrelated privacy requests
receive 409 and leave their raw source untouched; they cannot reuse another
operation's commit result. The original cleanup is rescheduled.

## Projection boundaries

RAG captures a source boundary before staging. Additional messages in the same
generation do not invalidate a completed prefix: commit that prefix and leave
the new suffix for a later pass. A changed generation or reduced boundary rejects
the staged result. Embeddings run outside transactions; staging promotion and
checkpoint writes remain transactional and are drained by the mutation barrier.
When a failed batch resumes at a larger boundary, `prepareProjectionStage`
retains and retargets the same-generation staged prefix in that transaction.
It discards other generations. Deleting the old boundary's staging while resuming
its checkpoint would silently promote only the suffix, so it is forbidden.

## Consistency and failure boundaries

Each authority commit keeps Memory state, its cursors, event history, snapshot
and task outcome in one database transaction. Source mutations likewise keep raw
changes, replacement authority and durable recovery/cleanup metadata together.
Cancellation waits for these transactions to exit; it never abandons one and
allows deletion to race its eventual writes.

Chat may consume an older committed Memory revision while a newer one is being
computed. Recent raw messages and GapBridge use that captured state's cursors.
This is eventual semantic coverage, not a partially committed Memory object.
Target statuses and diagnostic sidecars can be read at a later instant, so the
assembled context is not a repeatable-read snapshot of every table.

Privacy deletion and external cleanup are a durable multi-step operation, not a
single transaction spanning PostgreSQL, model calls and the filesystem. A raw
commit returns `rawMutationCommitted: true` with a pending operation status;
only successful verification and required draining mark it completed. A crash
after the raw commit leaves the operation available for reconciliation.

## Regression coverage

- `runtime-concurrency.test.js`: real runtime and send/session use cases with a
  suspended proposer, a subsequent chat, deletion, late response, missing state,
  corrupt-state recovery during a reply and its privacy fence.
- `work-coordinator.test.js`: mutation ordering, queued cancellation, scope
  isolation, admission waiters and shutdown.
- `source-rebuild.test.js`: unaffected and empty sessions, checkpoint reuse,
  unfinished rebuilds, safe snapshot fallback and privacy-history cleanup.
- `projection-drain.test.js`: append during staging, generation invalidation,
  cancellation and persisted rebuild progress.
- `test/rag/projection-adapters.test.js`: failed batch, new turns, then resume
  through the production adapter without losing its staged prefix.

These are offline regression and fault-injection tests. They do not substitute
for PostgreSQL process-crash, connection-loss or multiple-process testing.

These coordination guarantees apply to the application's supported single
replica runtime. Administrative commands must still respect source generation
and transaction guards; an in-process coordinator is not a distributed lease.
