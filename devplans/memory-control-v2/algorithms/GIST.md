# Assistant gist

Gist is an optional presentation cache for older assistant replies in the main
chat recent window. It never supplies Memory Proposer inputs or advances Memory
cursors.

## Memory v2 context

Memory chooses the window and computes `needsMemory`, GapBridge and coverage from
raw messages first. Chat then replaces older assistant replies with a valid,
shorter gist. The last `CHAT_RECENT_WINDOW_ASSISTANT_RAW_LAST_N` assistant
replies stay raw (see `.env.example` for the existing context switches). User
messages and GapBridge stay raw. A missing, stale or unreadable cache falls back
to raw content; missing entries are queued for generation. Compression does not
expand the selected window or change its coverage boundary. Raw `selectedChars`
and post-render `renderedChars` are reported separately.

The cache version covers the assistant text plus the adjacent user message ID
and text. Legacy entries without `source_hash` are treated as misses and replaced
on demand. A cached gist is also checked against the raw message snapshot used
by this request, so an edit cannot attach a new gist to an old assistant snapshot.

## Durable worker

`chat_gist_tasks` stores one task per message, without prompt/response text.
Messages already in `retry_wait` or `failed` are not reset by ordinary backfill.
A changed input version starts fresh work; an explicit manual retry resets a
failed task. A live claim is never reset by manual retries.

Workers claim due tasks using `FOR UPDATE SKIP LOCKED` and a UUID claim token.
The lease lasts `CHAT_GIST_WORKER_TIMEOUT_MS + CHAT_GIST_LEASE_GRACE_MS` ms. A restart recovers queued
and due work immediately, and abandoned running work after its lease expires.
Claims consume the durable attempt budget, including abandoned claims. An old
claim cannot commit after replacement, source changes, deletion or privacy purge.
Source validation, cache write and successful completion commit in one transaction.

The example environment allows one initial attempt plus five transient retries, delayed by
30, 60, 120, 120 and 120 seconds. HTTP `Retry-After` can defer a retry further.
Timeouts, connection failures, 408/425/429 and 5xx retry; authentication, invalid
request and unknown errors stop. Empty output stops too. Waiting tasks do not
occupy worker slots. The poller uses `CHAT_GIST_POLL_INTERVAL_MS` and the configured gist
concurrency, and aborts/drains in-flight work before database shutdown.

## Migration and operation

Apply the additive migration against the intended database **before starting the
updated application**. This command loads that environment's database settings:

```sh
npm run migrate:chat-gists
```

The existing `chat_message_gists` table is a prerequisite. The migration adds
`source_hash` and the task table/indexes; it does not regenerate historical data.
Scheduling and recovery settings are validated in `config/gistRuntime.js`,
loaded by `config/index.js`, and injected into Chat. All six fields are required
in the environment: missing, blank or invalid values fail application composition.
There are no configuration-layer or worker fallback values. Example values:

```dotenv
CHAT_GIST_POLL_INTERVAL_MS=1000
CHAT_GIST_LEASE_GRACE_MS=60000
CHAT_GIST_BACKFILL_MAX_PER_REQUEST=10
CHAT_GIST_RETRY_MAX=5
CHAT_GIST_RETRY_BACKOFF_BASE_MS=30000
CHAT_GIST_RETRY_BACKOFF_MAX_MS=120000
```

`CHAT_GIST_BACKFILL_MAX_PER_REQUEST` bounds on-demand backfill independently of
worker concurrency (10 in the example environment).
Provider/model, generation timeout, output length and generation parameters
are also loaded by `chatGistConfig` in `config/index.js`; recent-window rendering
switches belong to `chatContextConfig` in that same configuration file.

Gist stays inside the Chat module. Generation/backfill, worker lifecycle/recovery,
retry classification, source fingerprinting, context rendering and PostgreSQL
persistence are separate components with injected dependencies. A separate
top-level `modules/gist` is unnecessary because Gist consumes Chat-owned messages
and exists to render Chat context. Protocol constants (HTTP statuses, hash
algorithm, milliseconds per second) are implementation rules, not deployment
configuration defaults.

Inspect task status with a scoped SELECT on `chat_gist_tasks`. Explicitly retry
failed tasks for one preset, optionally one message:

```sh
npm run retry:chat-gists -- --userId 1 --presetId Lina-Weil --messageId 8505
```

The command reports actual durable status after the immediate attempt. If a task
is still queued/running/retrying, the application worker continues it. The older
`regenerate-gists` command also reports pending tasks separately from successes.
Neither command changes Memory state or resets Memory retry budgets.

## Validation

`npm test` runs offline coverage for rendering, retry classification, restart
budgets, stale writes and shutdown. The PostgreSQL integration test requires an
explicit, disposable test connection; it never falls back to `DATABASE_URL`:

```sh
GIST_TEST_DATABASE_URL=postgresql://... node --test test/chat/gist-postgres.test.js
```

It creates/removes its own schema and checks migration idempotence, concurrent
claims, stale leases, source edits, privacy purge, deletion and manual retry.
