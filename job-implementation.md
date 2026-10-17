# Bulk CSV imports and background processing: local implementation plan

Implementation status (2026-10-15): implemented locally. See README.md for the current API/operations contract and VERIFICATION.md for executed checks, measurements and limitations. The planning narrative below is preserved as the original design record; its future tense is historical.

Prepared 2026-10-15 from the current repository and the user's final requirements. This document is the deliverable for a planning-only task. It describes future changes; it does not claim that bulk functionality, new commands, migrations, or tests already exist.

## 1. Current implementation and gap analysis

The current application uses Node.js 24, strict TypeScript, Express 5, Prisma 6, PostgreSQL 17, Redis 7, Jest, and Supertest. `package.json` and `package-lock.json` exist. The only Prisma model is `SearchHistory`; the only committed migration creates that model and its timestamp/UUID pagination index.

| Area | Repository evidence | Remaining work against Task.md and final requirements |
|---|---|---|
| Existing HTTP APIs | `src/app.ts`: authenticated `GET /weather`, `GET /history`, `DELETE /history`; `{detail, code}` errors | Preserve authentication, response fields, validation, history pagination/deletion, status/error behavior; add three bulk routes |
| Weather orchestration | `src/weather.ts`: query-hash cache, process-local promise coalescing, history writes inside `get` | Extract reusable fetching from HTTP history; add explicit fresh/provisional outcomes, canonical cache reuse, worker policy |
| Provider | `src/provider.ts`: first-match geocoding with `limit=1`, metric coordinate weather, timeout, up to two transient retries | Add candidate lookup with metadata for bulk, strict ambiguity handling, injectable time/randomness, classified worker outcomes |
| Weather cache | Fresh `weather:v2:fresh:<hash>` TTL 900 seconds; backup `weather:v2:stale:<hash>` retained 86,400 seconds at the configured TTL | Preserve legacy cache availability during migration; never renew freshness/backup on a read; retain per-job snapshots |
| Geolocation | Separate `geo:<hash>` currently stores only lat/lon with a 30-day expiry | Durable PostgreSQL places/aliases/verification; nonexpiring Redis index; policy-specific verification; rebuild and revalidation |
| Quotas | `src/store.ts`: Redis TIME + one Lua reservation across rolling 60-second/31-day sorted sets; shared cooldown | Reuse the exact namespace/budgets across API and workers; capacity observations, recovery guard, deterministic boundaries |
| Bulk | No upload parser, BullMQ dependency, queue, workers, City/BulkJob/results models, or bulk routes | Implement complete vertical slice, streaming admission, enqueue consistency, status/results, counters, recovery/retention |
| Tests | Six test files plus helpers cover API, provider, cache, history, Redis quota, PostgreSQL/Redis integration | Add bulk and recovery matrix below; replace `tests/app.test.ts` assertion that bulk returns 404; preserve other regressions |
| Docker | `compose.yml`: postgres, redis, migrate, api; Redis AOF `appendfsync always`, `noeviction`, named volumes; non-root runtime | Worker/reconciler, upload staging, configuration and isolated worker integration tests |
| Samples/docs | README, two old plan/verification documents; no `data/` CSV samples | Update conflicting scope statements, samples, API/ops guidance, local verification and handoff |
| Delivery | `git status --short` reports this directory is not a Git repository | Git history, remote status, collaborator access and pushes cannot be verified here; no repository creation is part of this task |
| AI records | Only `prompts/2026-10-14-codex.md` and `prompts/2026-10-15-codex.md`; both contain summaries | Complete exports for the represented sessions and this planning conversation are missing from the repository |

`VERIFICATION.md` records earlier successful builds and 93 Docker tests. Those are historical claims, not checks rerun for this plan. Current runtime/container health has not been established. No private environment file or secret value was inspected. Old statements that the repository contains only Task.md or that bulk is excluded are historical and must not guide implementation.

## 2. Final requirements, precedence, and explicit assumptions

Precedence: the user's final requirements > this plan's documented implementation decisions > nonconflicting Task.md requirements > older plans/notes. Delivery is local. Do not deploy, create repositories/accounts, invite collaborators, push, or send email. Preserve the three existing APIs and their API-key protection; apply the same `X-API-Key` protection to all new routes.

Agreed application design limits, which Task.md itself does not specify:

| Setting | Decision |
|---|---|
| File size | At most 10 MiB = 10,485,760 uploaded file bytes, before decoding; multipart overhead is excluded |
| Rows | At most 100,000 nonblank data records, including structurally rejected and duplicate records; no header |
| City length | At most 200 Unicode code points after trimming, before normalization; this does not change `/weather`'s existing 100-JavaScript-code-unit validation |
| Input | Exactly one multipart file part named `file`, no additional file/text parts; UTF-8 CSV, optional UTF-8 BOM, no header, one city value per record |
| Pagination | Default 20, maximum 100; immutable admission-entry ordering and separate rejected-row pagination |
| Cache | Freshness 900 seconds; backup usability ends 86,400 seconds after last successful fetch |
| Quotas | 55 reserved dispatch attempts per rolling 60 seconds; 900,000 per rolling 31 days; never per worker/job |
| Worker | One Compose worker service initially, configurable concurrency 5 per process; no BullMQ rate limiter, global concurrency semaphore, fairness scheduler, or distributed fetch lock |
| Scheduling | At most 500 database dispatch candidates per scan; scan every 5 seconds; workers are allowed to be scaled |
| Retention | 30 days after terminal completion, never 30 days after upload for an active job |

Admission checks transport/CSV shape/value size only. It must not call OpenWeather, inspect city syntax, require qualifiers, consult the geolocation index to reject entries, or resolve canonical identity. Empty/oversized/multi-column records are upload-row rejections. Invalid city syntax, ambiguity, and nonexistent places are later worker failures. Every upload is independent, even if file content or an `Idempotency-Key` header repeats; document that no import replay deduplication is supported.

Two requirements cannot both be interpreted as a single flat result array: expose every admitted distinct input immediately with immutable membership, and later return only one row per canonical place discovered by workers. Adopt a two-layer contract: stable admission entries reference canonical processing outcomes. Explicit details and the remaining interpretation choice are in sections 6 and 13. This enables an actionable plan without pretending canonical identities are known at admission.

## 3. Architecture and component responsibilities

Extend the existing modules rather than replacing Express/Prisma/Redis or introducing another service framework.

| Planned component | Responsibilities |
|---|---|
| `src/cities/normalization.ts` | Versioned pure query normalization shared by API cache lookup and bulk deduplication; retain the original display input |
| `src/cities/repository.ts`, `resolver.ts` | Place/alias upserts, verification policy, candidate filtering, canonical binding, PostgreSQL-to-Redis rebuild |
| `src/weather-fetch.ts` | Shared cache/provider orchestration; explicit `fresh` or `deferred` result with optional provisional weather; no history writes |
| `src/weather.ts` | Keep `WeatherService.get(city)` as the HTTP facade: existing first-match behavior, eligible stale fallback, record every successful HTTP request before response |
| `src/provider.ts`, `src/store.ts` | Shared provider transport and atomic quota mechanism; each transport attempt reserves immediately before fetch |
| `src/bulk/admission.ts`, `csv.ts`, `routes.ts` | Multipart streaming, fatal UTF-8 decoding, CSV validation, normalization/dedup, staged records, error mapping |
| `src/bulk/repository.ts` | Transactional item claims, canonical merges, snapshots, counters, job summaries, keyset pages, state transitions |
| `src/bulk/queue.ts`, `worker.ts` | BullMQ work delivery and worker entrypoint; payloads contain IDs/generation only, not whole CSVs or weather |
| `src/bulk/reconcile.ts`, `retention.ts` | Outbox dispatch, missing/stalled work recovery, admission cleanup, terminal-job retention, index repair |
| `src/runtime.ts` | Shared dependency composition used by API/worker; injectable provider transport, clock, sleep, randomness, ID factory |

Keep `redis` for the existing store. Add BullMQ and its supported ioredis connection configuration for queues; both client implementations point to the same Redis deployment. API enqueue connections fail promptly on outages; worker connections reconnect using BullMQ-compatible settings. Verify the selected pinned BullMQ version's delayed/stalled/connection APIs against its official documentation during implementation; do not assume deprecated QueueScheduler setup is required.

PostgreSQL is authoritative for admitted membership, outcomes, recovery scheduling and verification. BullMQ is durable delivery, not the API's source of counters. Redis stores weather, geolocation acceleration, quota state, and queue data in distinct namespaces. A missing Redis queue item can be reconstructed from PostgreSQL; completed outcomes must never depend on BullMQ's retained job records.

## 4. Data models, constraints, indexes, and migrations

Use UUID primary keys, UTC `timestamptz(3)` timestamps, explicit enum values, bounded error fields, and JSONB for validated weather/verification snapshots. Add models through a new additive migration; never edit the applied initial migration or reset local data.

### Durable city records

- **City**: `id`, display `name` (not globally unique), normalized provider country/state metadata, decimal `lat`/`lon`, `verified_at`, `verification_version`, `last_refreshed_at`, `last_status`, `last_error`, created/updated timestamps. Index `last_refreshed_at`. Unlike Task.md's suggested unique name, same-name cities in different locations must coexist.
- **PlaceIdentityKey**: unique `(provider, signature_version, signature)` -> `city_id`. Initial signature uses normalized country/state and the provider-returned coordinate pair, encoded as canonical decimal values without fuzzy rounding. It is an application identity key, not a documented OpenWeather stable place ID. Multiple historical signatures can map to one internal UUID after verified revalidation.
- **CityAlias**: unique `(normalization_version, normalized_query, resolution_policy)` -> nullable `city_id`; display query, `verified_at`, `verification_status`, selection metadata/candidate digest, `last_error`, `revalidate_after`, version. Policies `http_first_match` and `bulk_unambiguous` are separate. An HTTP first-match record does not certify bulk uniqueness. Index revalidation due time and `city_id`.
- **QuotaSafetyGuard**: singleton account scope, Redis continuity token/initialization state, latest dispatch-intent timestamp, optional recovery hold. This is a conservative data-loss guard, not a second rate limiter or a full provider billing ledger.

Do not create City rows for unverified admission strings. Persist verified aliases and place upserts atomically; on uniqueness races retry the lookup/upsert transaction. Do not infer aliases merely by equal display names. Alias remapping on revalidation increments its version; previously stored job snapshots and completed outcomes remain immutable.

### Import and processing records

| Model | Key fields and constraints |
|---|---|
| **BulkJob** | `job_id`, private `admission_phase` (`preparing`, `ready`, `aborting`), public status, upload counters below, processing counters, `counters_version`, `created_at`, `admitted_at`, `started_at`, `last_progress_at`, `finished_at`, `expires_at`, job error. Nonnegative checks; `processed=succeeded+failed`; public APIs only expose ready jobs |
| **BulkEntry** | Immutable `(job_id, ordinal)` unique; UUID, `first_record_number`, `first_line`, display city, normalized key/version, `occurrences`, current `result_id`. Unique `(job_id, normalized_key, normalization_version)`; one entry per admission-distinct value |
| **BulkRejectedRow** | `(job_id, record_number)` unique; `row_number` (physical starting line), optional end line, structural rejection code/detail, bounded safe preview (never the entire oversized value). Index `(job_id, record_number)` |
| **BulkResult** | UUID, `job_id`, nullable `city_id`, `status` (`pending`, `in_flight`, `succeeded`, `failed`, internal `merged`), optional `merged_into_id`, initial entry ordinal, last error/reason, `resume_at`, `recovery_condition`, attempts, schedule generation, DB lease token/expiry, success snapshot/source/fetched/observed/completed times, provisional snapshot/expiry |
| **BulkDispatch** | Durable outbox: unique `(result_id, generation)` for city deliveries, `(job_id, bootstrap_generation)` for bootstrap, or `(alias_id, verification_generation)` for independent alias revalidation; kind, due time, delivery status, last enqueue error, attempts, enqueue timestamp. Exactly one owner type per row; alias-owned dispatches have no job FK and survive job retention |

Use a PostgreSQL partial unique index on `(job_id, city_id)` where `city_id IS NOT NULL AND status <> 'merged'` to enforce one live outcome per canonical city per job. Add it in migration SQL if Prisma cannot express it. Unresolved permanent errors have no verified city and retain one outcome per admitted key. Merged records are internal audit/redirects, excluded from processing totals and outcome responses.

Indexes: BulkJob `(admission_phase, created_at)`, `(status, expires_at)`; BulkEntry `(job_id, ordinal)`; BulkResult `(job_id, status)`, `(status, resume_at)`, `(status, lease_expires_at)`, `(job_id, completed_at DESC, id)`; BulkDispatch `(delivery_status, due_at)`; CityAlias indexes above. Use cascading deletion only from BulkJob into its private entries/results/rejections/dispatches. City, aliases, identity keys, and SearchHistory have independent lifecycles.

Counters and result transitions are one PostgreSQL transaction under a per-job row lock. Worker leases use tokens and conditional writes to fence stale owners. Read each job summary/page in one repeatable-read transaction so counters, referenced outcomes, reasons, and aggregates describe one database snapshot. Normalize UUID/enum/date serialization explicitly instead of returning raw Prisma rows.

### Compatibility and rollout

1. Stop new bulk admission during migration; initial rollout has no bulk data. Apply additive migrations via existing `migrate` service, generate Prisma client, build API/worker from the same image revision.
2. Existing SearchHistory schema and HTTP request/response formats remain unchanged. Preserve `/weather`'s existing input validator; do not reuse it at admission or lower the bulk value limit to 100.
3. Preserve `cityweather:minute`, `cityweather:month`, and `cityweather:cooldown` exactly. Changing prefix or clearing Redis would reset budgets. Do not run old/new normalizers concurrently indefinitely; deploy API and worker together after migrations.
4. Read existing weather keys on exact legacy queries through their remaining Redis TTL; migrate only with remaining lifetimes, never assign a new 900-second lifetime to an old read. Legacy coordinates without verified metadata cannot be promoted to bulk-unambiguous verification. They may support the existing HTTP path until replaced.
5. Rolling back binaries can preserve the original three routes because migrations are additive. After bulk activation, drain/pause admission and workers before rollback; do not drop new tables or quota state.

## 5. Upload/admission workflow and enqueue consistency

### Stream and count before dispatch

Use a streaming multipart parser (Busboy) and streaming CSV parser (`csv-parse`) with pinned dependencies and backpressure. Spool the file into a uniquely named private request directory under `/tmp/cityweather-uploads`, mode restricted to the API user. After the multipart envelope completes and exactly one correct file part is confirmed, read the file as a stream through a fatal UTF-8 decoder and CSV parser. This validates before enqueue without loading the file buffer into memory and satisfies Task.md's streaming intent. Raw file size is bounded; stream batches of at most 500 staged rows to PostgreSQL. Do not buffer a 100,000-row array or hold a transaction open while receiving the upload.

Allow CSV quoting/escaped quotes and LF/CRLF. There is no header. The first logical record, after a possible BOM, is the first city value. A comma-qualified value must be quoted, for example `"Portland,OR,US"`. Any data record with too many fields, including the first, is a recoverable row rejection. Use the parser's relaxed column-count mode only to inspect/count those records, not to silently discard fields. Unclosed/malformed quoting is an unrecoverable whole-upload 400.

Accept `.csv` files with MIME `text/csv`, `application/csv`, or `application/octet-stream`; validate the bytes rather than trusting the filename/MIME. Reject compressed archives, XLS/XLSX, a declared non-UTF-8 charset, or fatal UTF-8 decode failure with 415. A UTF-8 file whose CSV grammar is malformed gets 400. Do not require a city-like lexical pattern at this stage. Parser record buffering is bounded by the 10 MiB file ceiling; an oversized single value is skipped as a row, not incorrectly classified as a fatal parser-size error.

Counting rules:

| Field/concept | Precise meaning |
|---|---|
| `record_number` | 1-based logical CSV record number, starting with the first city and including blank records; embedded quoted newlines do not create another record |
| `row_number` | 1-based physical line on which that record starts; report `end_line` for multi-line records; CRLF counts as one line break |
| Blank | A parsed record with exactly one field whose trimmed value is empty, including a bare empty line, whitespace-only line or `""`; ignore it, count in `blank_rows`, preserve numbering |
| `input_rows` | All nonblank records, before rejection/deduplication. Extra-column records count here, even when all fields are empty. The 100,001st such record rejects the upload with 413 |
| `rejected_rows` | Nonblank records with not exactly one value or a trimmed value longer than 200 code points; record reason and continue. Trim precedes the length check; normalization follows it |
| `admission_duplicate_rows` | Structurally admissible records whose normalized key was already admitted in this job; increment the first entry's occurrences and retain its original ordinal |
| `admitted_entries` | Immutable count of distinct normalized values after structural row rejection; every entry gets an ordinal in first-occurrence order |
| `alias_duplicate_rows` | Additional admitted entries later proved to share a canonical outcome; each eliminated processing unit contributes one, not its already-counted occurrences |
| `duplicate_rows` | `admission_duplicate_rows + alias_duplicate_rows`; expose both subcounts to explain changes |

Admission invariant: `input_rows = rejected_rows + admission_duplicate_rows + admitted_entries`. Processing invariant after canonical merging: `input_rows = rejected_rows + duplicate_rows + total`. Blank rows are excluded from both equations. If a record violates several structural rules, count one rejected row and include multiple reason codes; oversized values are checked before deduplication. Invalid syntax such as `London,XYZ` is admitted as text and later fails in the worker. A blank-only/empty file or all-rejected file returns 400 `NO_ADMISSIBLE_CITIES`; duplicates of one admissible value still admit one city.

### Gate processing across PostgreSQL and Redis

PostgreSQL and BullMQ cannot commit atomically. Use a private admission phase plus a durable bootstrap/outbox, not a claim that an outbox alone proves successful enqueue.

1. Authenticate before reading/spooling data. Enforce exactly one file part, byte count, an upload timeout (120 seconds configurable), and abort/disconnect cleanup. No provider calls or processing jobs occur while validating.
2. Create a hidden `preparing` job only when staging begins. Stream batch-insert entries/rejections and update staged counters. A fatal error deletes the private graph; removal is repeatable. Nothing is returned by GET routes yet.
3. After EOF, full multipart validation, row limits and nonempty admission succeed, transactionally finalize staged counts, create pending outcomes and pointers for every entry, and a bootstrap dispatch intent. Use database-side INSERT/SELECT or bounded batches rather than materializing all entries in JavaScript. Job remains hidden and nonexecutable.
4. Add one BullMQ bootstrap job with deterministic ID `bulk-<uuid>-bootstrap-1` and admission generation. Await successful acknowledgement. Queue payload is only job ID/generation. A bootstrap worker seeing `preparing` must defer without claims, fan-out, or provider calls; it must not mark the bootstrap completed prematurely.
5. Commit `admission_phase=ready`, `admitted_at`, and public `status=queued`. Now return exactly HTTP 202 `{ "job_id": "<uuid>" }`, with Location pointing to the status endpoint. All admitted entries already exist and are queryable. The bootstrap/outbox reconciler begins city deliveries only after this gate opens.
6. On validation/enqueue/activation failure, keep the gate closed, mark aborting, remove the bootstrap where possible, delete staged DB records and request files, and return an appropriate error (dependency/enqueue errors 503). A timeout may mean Redis accepted an enqueue; any leftover message must find no ready generation and be a harmless no-op. Persist cleanup intent if Redis/DB prevents immediate cleanup, retry automatically after recovery, and expose cleanup backlog operationally. Never claim instantaneous cross-store deletion during an outage.
7. On a crash, a database admission lease/heartbeat distinguishes an active upload from abandoned staging. Expired non-ready admissions are aborted and removed (10-minute stale threshold); never auto-publish a rejected/unacknowledged admission. An acknowledged bootstrap whose ready activation committed is redispatched/reconciled if necessary. A crash/disconnect after ready commit but before HTTP delivery can leave a real job the client never received; no transport-level exactly-once promise is possible. The next upload is a new independent job.

Always remove the raw request directory in `finally`, including extra-part discovery after file upload. Startup and periodic cleanup delete only verified, stale, task-owned request directories, never arbitrary client filenames. No worker needs the raw CSV. If PostgreSQL cleanup is temporarily unavailable, retained hidden artifacts are not processing results and are retried for deletion after recovery.

## 6. City identity, canonicalization, and geolocation lifecycle

### Verified provider facts and application decisions

Official OpenWeather pages were checked for this plan on 2026-10-15. Direct geocoding takes a location query with optional country and US state, returns at most five candidates, and documents name/local names, coordinates, country, and optional state. Its documented response does not supply a stable global place identifier or exhaustive uniqueness guarantee. Consequently, our UUIDs, alias policy, verification age and identity keys are application decisions. [OpenWeather Geocoding API](https://openweathermap.org/api/geocoding-api)

Weather requests use latitude/longitude and metric units. The built-in city-name/city-ID geocoder is deprecated; retain the separate geocoding workflow rather than adopting it to simplify bulk identity. [Current Weather API](https://openweathermap.org/api/current)

Pure normalization v1: Unicode NFKC; trim and collapse Unicode whitespace to one ASCII space; remove whitespace immediately around commas; use locale-independent Unicode lowercase; retain accents, punctuation, country/state tokens and their order. It is normalization, not fuzzy/transliterated identity matching. Store its version and original trimmed display query. Example: `  PORTLAND , OR , US  ` and `portland,or,us` share an admission key; `Portland,ME,US` does not. Document Unicode lowercase limitations rather than claiming full linguistic equivalence.

### Worker resolution and qualification

1. Run a worker-only city grammar check (1–200 code points, no control characters, one city token with optional ISO two-letter country or US state/country qualifiers). Validate actual country/state codes using a pinned local code table, not a provider request. Other malformed qualifiers are permanent `INVALID_CITY_SYNTAX` outcomes.
2. A reusable bulk-unambiguous alias verified less than 30 days ago can resolve without upstream calls. First-match HTTP records alone are insufficient. Read Redis first, then PostgreSQL and repopulate Redis on a miss. A fresh weather entry does not override unresolved bulk ambiguity.
3. Otherwise request `geocodeCandidates(query, limit=5)` through the shared quota mechanism. Filter by supplied country and US state, normalizing provider full state names against the local code table. Deduplicate truly identical coordinate/administrative candidates. Zero candidates -> `CITY_NOT_FOUND`; more than one acceptable candidate -> `CITY_AMBIGUOUS`, with up to five safe qualification suggestions. One acceptable candidate -> verified under the application's observed-candidate rule. Never select candidate one for bulk merely because the name is unqualified.
4. The provider caps results, so observing one candidate does not prove global uniqueness. Do not manufacture a guarantee from `limit=5`. Document this detection limit and recommend fully qualified CSV entries. If provider metadata cannot substantiate the supplied qualification, fail that city as `CITY_QUALIFICATION_UNVERIFIABLE` rather than guessing. The resolver cannot prove a returned area/district is a legal municipality; this is a weather-location identity, not an official municipal registry.
5. Atomically upsert the City, identity signature and verified query alias. Only seed additional local-name aliases when the exact same query/qualifier combination has been independently verified; a `local_names` field is a suggestion, not proof that a bare name is unambiguous.

The existing HTTP path continues to accept its current forms and select the first provider candidate. Store `http_first_match` metadata separately; do not overwrite a strict bulk alias with an HTTP selection. Shared normalization/cache access must never reinterpret a bare query as a verified alias merely because a qualified place exists.

### Identity changes and Redis lifecycle

An internal City UUID survives a revalidation of an already-known alias when the provider's place name/administrative identity remains compatible; record changed coordinates as another verified signature for that UUID, invalidate its old reusable-weather mapping if the location changed, and bump verification version. If a signature already belongs to a different UUID or identity change is incompatible, do not fuzzy-merge: leave the item pending with `IDENTITY_REVIEW_REQUIRED` and an operational repair condition. Equivalent newly encountered signatures upsert the same City atomically. Exact-coordinate signatures can miss real-world equivalences when the provider uses different centroids; explicitly accept this limitation rather than collapsing nearby cities.

Redis index keys have no EX/PEXPIRE: `cityweather:geo:v2:alias:<policy>:<normalization-version>:<query-hash>` and `cityweather:geo:v2:place:<uuid>`. Include `verified_at`, `revalidate_after`, coordinates, selected metadata, policy and DB version. Write PostgreSQL first and Redis after commit; a failed Redis write is repaired from DB. Rebuilding uses batched keyset reads and version-checked writes, so an old rebuild cannot overwrite a newer verification. Malformed/outdated Redis entries are rebuilt from PostgreSQL, never trusted over a newer DB version. Do not use global `FLUSHDB` or delete weather/quota/queue namespaces during rebuilding.

After 30 days the entry remains stored but verification is due. Schedule quota-controlled revalidation; no unused-place background sweep is required. Bulk can complete from a fresh weather hit using a previously strict-verified alias while scheduling its due revalidation separately; a pending revalidation never extends `verified_at`. If weather must be fetched after verification becomes due, strict bulk processing waits for successful revalidation; transient revalidation failure keeps the item pending, permanent lookup failure fails it. HTTP fresh hits continue working and retain existing stale-fallback semantics; HTTP misses revalidate due coordinates through its first-match policy. An alias whose prior verification was invalidated cannot use the bulk fresh-hit shortcut.

Weather expiry/refresh deletes or updates only weather keys. Coordinates, aliases, verification timestamps and their PostgreSQL backing remain. Expiring a job never expires a City or alias.

### Canonical merging without changing page membership

At admission create one provisional result per BulkEntry, with no claimed canonical identity. On binding a verified City, lock the job/result, find or create the unique live `(job_id, city_id)` result, and merge any competing provisional outcome into that result before weather processing. Redirect every affected entry's `result_id`; mark the superseded outcome internal `merged`; decrement `total`, increment `alias_duplicate_rows`, bump `counters_version` in the same transaction. Keep entry UUIDs/ordinals and display values unchanged. Do not count a merge as processing success/failure.

The merge transaction also removes the losing provisional unit from its current pending/in-flight bucket, invalidates its lease and cancels its future dispatch generation. Keep the surviving outcome's bucket/final counters unchanged; if the current worker takes ownership of a pending survivor, perform that ordinary pending-to-in-flight transition explicitly. A City-bound final outcome cannot be a losing provisional unit. These rules preserve `total=processed+pending+in_flight` throughout concurrent binding and make stale completion callbacks harmless.

Only an outcome with verified canonical binding can complete with weather. Concurrent aliases therefore cannot independently finalize two successful results for the same City: the unique constraint/transaction arbitrates binding. A duplicate delivery uses the current root result. If the canonical outcome is already complete, attach the new alias and stop without incrementing processed or fetching weather. Preserve the first successful snapshot; later cache refreshes cannot rewrite it. A lease owner invalidated by a merge cannot finalize its old result.

Example: admission contains `London,GB`, ` london , gb `, and a separately verified alias of the same location. Initially `input_rows=3`, `admission_duplicate_rows=1`, `admitted_entries=2`, `total=2`. After alias discovery `alias_duplicate_rows=1`, `duplicate_rows=2`, `total=1`; both immutable entries reference one outcome. On success `processed=succeeded=1`. Pagination still visits both entry slots exactly once. `total_basis=provisional` while nonterminal identities remain unresolved, then `resolved` once every entry is bound or has a permanent resolution failure; clients must not assume total is monotonic or equal to page-slot count. Failed unresolvable strings remain distinct failed units because there is no proven common canonical city to merge.

The recommended response explicitly calls page rows `entries`, not canonical processing results; `outcomes` contains distinct referenced live outcomes keyed by result ID. The same outcome may be referenced on multiple pages, but there is only one stored processing result. If consumers require a flat array of canonical-only rows, stable admission membership cannot also hold; section 13 records that alternative as an unresolved contract interpretation, not a hidden exception.

## 7. Worker processing, quotas, retries, state transitions, and recovery

### Queue and work lifecycle

Use one BullMQ queue, `bulk-weather`, with names `bootstrap`, `process-city`, and `revalidate-alias`. Add alias revalidation dispatches to the same outbox model with unique `(alias_id, verification_generation)`; job-owned city dispatches remain unique by result/generation. IDs use hyphens, not BullMQ-reserved colons. Queue Redis keys use `cityweather:bull:*`; the existing quota namespace stays unchanged.

The bootstrap marks admission-dispatch readiness; it does not load or enqueue all 100,000 cities in one handler. An outbox dispatcher in the worker service scans PostgreSQL in bounded pages. Use `FOR UPDATE SKIP LOCKED` for dispatch claims and generation-specific deterministic BullMQ IDs. Mark delivery acknowledged only after `queue.add` succeeds. Unknown enqueue outcomes are retried using the same ID. Reconcile acknowledged but missing queue deliveries from database state, with a new generation when an old completed queue ID would otherwise suppress dispatch. Queue retention/deduplication is an optimization; DB fences enforce correctness.

Per city delivery:

1. Confirm the parent is ready and nonterminal; follow any canonical redirect. Conditional claim changes a due pending result to in-flight with an ownership token and DB lease. Completed/merged/already-owned deliveries are no-ops. Update `started_at` only once.
2. Apply syntax/alias resolution policy, bind/merge canonical identity transactionally, and recheck the live result/lease after binding. Before a newly required provider operation, recheck reusable weather and verification so another worker's completed work can save calls.
3. Use the shared fetcher with bulk policy. Fresh cache hits, including existing compatible query cache entries, finish without provider weather calls. On a miss, geocode only if necessary, then fetch current weather by coordinates. For cross-query reuse, verified aliases map to canonical weather keys; do not copy an unverified HTTP first-match cache to a strict bulk identity.
4. On fresh weather, persist a validated per-job snapshot with `source`, `fetched_at`, `fresh_until`, `observed_at`, and `completed_at`; increment succeeded/processed exactly once using a conditional nonterminal-to-success transition. A result was fresh when obtained; it remains successful if its snapshot later ages during a long job. A fresh hit's `last_refreshed_at` is its original fetch time, not the time the cache was read.
5. On permanent city error, finalize failed once with a typed actionable error; continue other cities. On recoverable deferral, save a provisional backup only if it is still within its original 24-hour lifetime, set pending metadata, release the DB lease, and transactionally create the next dispatch intent. Do not keep a worker slot sleeping until next month.

Cache envelopes for canonical weather keys contain the same Weather response plus fetch/fresh/backup deadlines. Proposed keys: `cityweather:weather:v3:fresh:place:<id>` (900-second TTL) and `cityweather:weather:v3:backup:place:<id>` (86,400-second TTL). Policy-specific query-to-place mapping is the nonexpiring geo index, not a weather TTL. Resolve fresh/stale source explicitly; `source=cache` alone cannot distinguish those states. Absolute deadlines and conditional/newer-fetch writes prevent a delayed writer from replacing newer cache weather or renewing an older value's lifetime. Legacy keys are read with their remaining TTL and converted only when provenance is safe.

There is no new global concurrency limiter, per-place distributed fetch lock, or fairness mechanism. Process-local coalescing remains useful within each runtime, but each job persists its own outcome. Two jobs/workers can both miss and dispatch upstream calls. Idempotent City records and queue job IDs do not promise one provider request per city. Scaling concurrency increases simultaneous sockets, DB contention and denied reservations, not allowed provider throughput.

### Atomic account budget and bounded dispatch

OpenWeather's Free pricing currently lists 60 calls/minute and 1,000,000/month, and its account guidance combines usage across keys and products. Our existing lower budgets are conservative application decisions; the rolling 31-day window is not a claim about the provider's reset algorithm. Assume an exclusive account. Lower `PROVIDER_CALLS_PER_MINUTE`/`PROVIDER_CALLS_PER_MONTH` if other clients require headroom; local Redis cannot discover their usage. [Pricing](https://openweathermap.org/price), [account guidance](https://openweathermap.org/appid)

Retain one Redis Lua reservation for both rolling windows and the provider cooldown, using Redis server time. Every HTTP geocoding attempt, weather attempt, and retry, regardless of caller, uses it immediately before dispatch. No cache read reserves quota. Reusing coordinates avoids geocoding but does not make an uncached weather fetch free. Never reserve an entire import's future calls or refund a dispatched/timeout attempt. There is an unavoidable crash boundary between a successful reservation and socket dispatch: conservatively retain that reservation if the process dies. Therefore counters can overcount undispatched intents in crash cases; they must never undercount actual dispatches.

Expose an atomic read-only/pruning quota inspection method with available capacity, reason/window and Redis-time reset deadline. The dispatcher separates known fresh-hit candidates from likely provider misses: dispatch up to 500 cached candidates per scan, and a bounded miss batch no larger than observed remaining minute/month capacity. Unknown-resolution items count as potential misses. Inspect cache/metadata in bounded Redis/database pipelines. No capacity means defer known misses to the reported reset/cooldown, while fresh-hit candidates continue. These are scheduling observations, not reservations or a second limiter. API calls, retries, other dispatchers, and the geocode-then-weather sequence can consume capacity between inspection and dispatch; each actual provider attempt still atomically reserves and may return to pending.

A newly resolved city normally needs two requests, and retries need additional reservations. Do not promise one request per city or an exact finish time. At 55 attempts/minute, 100,000 entirely uncached cities needing geocoding and weather require at least 200,000 attempts, approximately 60.6 hours even without failures; this is compatible with indefinite pending/recovery. Monthly exhaustion may postpone work for days.

The selected Current Weather API documents a single coordinate location per request. OpenWeather bulk downloading is a separately documented periodically updated file product, not a free arbitrary-city request batch. Use application-level dispatch batches of individual operations; do not claim an N-city batch consumes one call. [Current Weather API](https://openweathermap.org/api/current), [Bulk Download](https://openweathermap.org/api/bulk)

### Failure classification and automatic resumption

| Condition | Item behavior | Resume policy |
|---|---|---|
| Local minute/month unavailable | Pending `LOCAL_QUOTA_EXCEEDED`, window and `resume_at`; backup only provisional | Next capacity reset from Redis, then atomically reserve again |
| Provider 429 | Pending `PROVIDER_QUOTA_EXCEEDED`; account cooldown, never guess minute vs month | Honor valid Retry-After seconds/date; otherwise 600 seconds; cooldown only extends |
| Network/timeout/500/502/503/504 | Existing provider operation performs at most two retries, all quota-counted; then item pending | Durable exponential backoff from 5 seconds to 5 minutes, capped jitter; retry indefinitely across delivery cycles |
| Invalid JSON/provider payload | Pending `PROVIDER_INVALID_PAYLOAD`, not a permanent bad-city verdict | Capped durable backoff; preserve existing HTTP error/fallback mapping |
| Provider 401/403 | Pending `PROVIDER_AUTH_ERROR`, account blocked for bulk refresh | Explicit `provider_configuration_repaired` condition; change `PROVIDER_CONFIG_REVISION` and restart API/worker after injecting repaired credentials; recovery reconciler probes pending work under quota |
| Redis outage/memory error | No upstream attempt without reservation; retain DB pending/lease state | Reconnect + successful Redis health/continuity check; due reconciliation after recovery |
| PostgreSQL outage | No claims/finalization; do not claim a successful job result in memory | DB recovery and lease expiry; last persisted state is exposed with staleness metadata once DB responds |
| Bad city grammar/no provider match/ambiguity/unverifiable qualifier | Permanent per-city failed outcome with suggestions where possible | No automatic retry of that final item; submit a corrected new import |
| Identity conflict | Pending `IDENTITY_REVIEW_REQUIRED` | Repair mapping through documented local operational command; version change triggers automatic retry |
| Unexpected worker exception | Persist pending `WORKER_ERROR`, alert/log sanitized code | Bounded retry; no age-based abandonment; deterministic corrupt job data may require unrecoverable job failure |

The provider recommends retrying after ten minutes when limits are reached; a provider 429 may reflect account suspension and does not identify the depleted allowance. The application's Retry-After parsing and durable pending policy are application choices. [OpenWeather account/API care guidance](https://openweathermap.org/appid)

Use 100ms exponential transient-operation backoff plus at most 99ms jitter as today; inject sleep/randomness. Across deliveries use `min(300s, 5s * 2^min(cycle, 6))` plus bounded 0–1 second jitter, with an explicit final cap of 300 seconds. A known quota deadline is never shortened by jitter. Do not set a finite BullMQ attempts count that permanently drops recoverable business work: the database next-dispatch record is authoritative, and retry cycles are renewable. Recovery probes use real pending operations through the shared budget rather than a hidden unmetered health endpoint. Do not probe broken credentials repeatedly until the configuration revision changes. Persist blocked account reason and failing configuration revision in the account guard so a restart with unchanged broken credentials does not repeatedly probe; a revision change permits automatic recovery attempts, with subsequent success clearing the block. Configuration values/secrets are never logged.

`attempts` in an item response counts successful DB claim cycles, not HTTP requests and not BullMQ delivery notifications. Expose `provider_attempts` separately where useful, derived from transport attempt instrumentation for that outcome; shared/coalesced operations cannot be used as an exact billing ledger per job. Account-wide Redis reservations are the quota authority. Retry/attempt metadata may increase, but final city counters change once only.

### Job states and counters

Public states apply only after ready admission. Status is derived/updated transactionally with these priorities:

| State | Exact meaning and transitions |
|---|---|
| `queued` | Ready but no city has ever been claimed; remains queued during initial dispatch delay. First claim -> running; known pre-start blocking condition -> pending |
| `running` | At least one valid in-flight lease, OR previously started work remains immediately runnable; blocked pending items may coexist. `blocking_reasons` still reports their reasons/counts |
| `pending` | Unfinished work exists, no valid in-flight lease and nothing immediately runnable because all unfinished outcomes have time/condition blocks. Due work -> running on claim (or runnable evaluation after prior start) |
| `done` | Every live outcome is final; may include permanent item failures. Set `finished_at`, start retention; no success/failure changes on duplicate delivery |
| `failed` | Unrecoverable job-level corruption/incompatibility prevents completing the import. Freeze dispatch, preserve all snapshots/counters, set explicit job error and finished/expiry times. Remaining unprocessed outcomes are pending with `JOB_FAILED`, condition `none`; do not invent permanent city failures |

For a job-level failed job, expose `unfinished` and the terminal job error even though no automatic work resumes. Manual repair creates an independent new import; do not silently reopen terminal jobs. Transient DB/Redis/provider errors never make a job-level failed state. If all cities are permanently invalid the job is `done`, with `failed=total`.

Counter definitions: `total` is current distinct live processing units after proven canonical merges, provisional while unresolved identities remain; `processed=succeeded+failed`; `pending` counts pending live outcomes (including immediately runnable ones), `in_flight` counts owned unexpired claims. Always enforce `total=processed+pending+in_flight`. Expose `ready_count` as a subset of pending and `blocked_count=pending-ready_count`. Internal merged outcomes never contribute. `provisional_count` is a subset of unfinished outcomes and does not increase succeeded. Lease expiry is reconciled into pending before returning a summary, or projected consistently from DB server time in the read transaction; do not show expired leases as active indefinitely.

`resume_at` at job level is the earliest time-based pending retry, possibly null; `recovery_conditions` lists condition-only blockers with counts. A non-null earliest retry is not a promise the whole job can resume/finish then. Expose started/finished/created/admitted/updated/last-progress times and counters version. Maintain top 5 recent successes (`completed_at DESC`, deterministic ID tie-breaker), top 5 most recent permanent failures, and grouped blocked reasons from per-job outcomes, never mutable City state. Aggregates count outcomes, not alias entries.

### Crashes, stalled work, and infrastructure outages

- BullMQ lock renewal and a PostgreSQL result lease are separate. Start with BullMQ lock duration 60 seconds and DB lease 90 seconds; heartbeat every 15 seconds. A worker checks its ownership again before each provider operation and before committing. No network operation is performed inside a long DB transaction.
- A reconciler runs on startup and every 5 seconds, using short database leases/`SKIP LOCKED` to allow multiple worker processes. Expired claims become pending with `WORKER_RESTARTED` and a new generation; stalled BullMQ deliveries and database redispatch may both occur, but only the current DB owner can finalize.
- Crash before cache write -> another attempt may refetch. Crash after cache write but before DB result commit -> recovery reuses unexpired cache and commits once. Crash after commit before BullMQ acknowledgement -> duplicate delivery observes final state and does nothing. Expired cache after such a crash can require another upstream call; exactly-once upstream effects are not promised.
- A DB outage can prevent recording a deferral. Keep the last durable in-flight state; readiness fails, automatic claims stop, and after DB recovery lease expiry drives retry. When status queries cannot access DB return 503; never fabricate current counters. Log sanitized infrastructure events rather than promising unavailable storage contains an outage reason.
- Redis outage does not erase PostgreSQL work. Resume when Redis recovers; reconstruct missing deliveries and geolocation index. Do not clear quota keys as a queue repair technique. Queue-event listeners are operational signals, not authoritative completion transitions.
- Ordinary Redis restarts recover AOF and budgets. Total Redis/AOF loss cannot safely reconstruct a rolling provider budget from an empty database. Record a PostgreSQL dispatch-intent high-water mark before each reservation and a nonexpiring Redis continuity marker associated with the DB guard. A missing marker after prior use triggers fail-closed recovery hold through 31 days after the last durable dispatch intent, unless a verified backup restores the complete quota ledger. The hold automatically expires; fresh weather hits still use available restored cache. This conservative guard can over-wait and adds a small PG write per dispatch, but prevents treating loss as a budget reset. Initial rollout with existing quota keys adopts them under a controlled initialization; never initialize empty state over unknown prior usage.
- Worker shutdown stops claims/dispatch, attempts a bounded drain, closes BullMQ/provider clients, and releases or lets leases expire. SIGKILL tests must verify the same correctness without graceful hooks.
- Operational visibility includes queue depth/delayed/stalled counts, oldest pending age, reason counts, outbox lag, expired leases, cleanup backlog, quota capacity/reset, recovery holds, and last successful progress. Structured logs contain IDs, stages and safe codes, never API keys, raw provider URLs, private CSV contents, or transport exceptions containing credentials.

## 8. API request/response contracts and pagination

Use existing authentication/error middleware; extend typed ApiError details for bulk row diagnostics without changing legacy bodies. Unknown/rejected/preparing/expired job IDs return 404 `BULK_JOB_NOT_FOUND`; malformed UUIDs/limits/cursors return 400 `INVALID_INPUT`. Infrastructure-unavailable reads return 503. Express's current non-strict trailing-slash behavior may accept both forms, while documentation uses the requested routes without trailing slashes.

### POST /bulk/import

Request: multipart/form-data, exactly one `file` CSV. Successful validation + bootstrap enqueue acknowledgement + ready DB activation returns:

```http
HTTP/1.1 202 Accepted
Location: /bulk/jobs/12345678-1234-4234-8234-123456789abc
Content-Type: application/json

{"job_id":"12345678-1234-4234-8234-123456789abc"}
```

| Status | Codes/examples |
|---|---|
| 400 | `INVALID_MULTIPART`, `MALFORMED_CSV`, `NO_ADMISSIBLE_CITIES`; missing/extra parts, malformed multipart envelope, unrecoverable CSV grammar |
| 413 | `UPLOAD_TOO_LARGE`, `TOO_MANY_ROWS` |
| 415 | `UNSUPPORTED_MEDIA_TYPE`, `UNSUPPORTED_CSV_ENCODING` |
| 401 | Existing `UNAUTHORIZED` |
| 503 | `DEPENDENCY_UNAVAILABLE`, `BULK_ENQUEUE_FAILED`; no ready job or executable work is published |
| 408 | `UPLOAD_TIMEOUT`; same staging cleanup as other rejection paths |

Fatal upload error body adds bounded `errors` (first 100, ordered by record/code), `error_count`, and relevant limits when available. Example: `{ "detail": "CSV contains no admissible city values.", "code": "NO_ADMISSIBLE_CITIES", "errors": [{"record_number":2,"row_number":2,"code":"CITY_VALUE_TOO_LONG","detail":"Trimmed city exceeds 200 Unicode code points."}], "error_count":1 }`. Successful admission stores every row-rejection detail for paginated access; truncating fatal-error presentation is not truncating stored accepted-job diagnostics. Input length limits and row rejections are never represented as worker `failed` cities.

### GET /bulk/jobs/{job_id}

Illustrative mixed-progress response (timestamps and counts are examples, not live values):

```json
{
  "job_id": "12345678-1234-4234-8234-123456789abc",
  "status": "running",
  "input_rows": 10,
  "blank_rows": 1,
  "admitted_entries": 7,
  "admission_duplicate_rows": 1,
  "alias_duplicate_rows": 1,
  "duplicate_rows": 2,
  "rejected_rows": 2,
  "total": 6,
  "total_basis": "provisional",
  "processed": 3,
  "succeeded": 2,
  "failed": 1,
  "pending": 2,
  "in_flight": 1,
  "ready_count": 0,
  "blocked_count": 2,
  "provisional_count": 1,
  "counters_version": 12,
  "created_at": "2026-10-15T10:00:00.000Z",
  "admitted_at": "2026-10-15T10:00:01.000Z",
  "started_at": "2026-10-15T10:00:02.000Z",
  "last_progress_at": "2026-10-15T10:00:05.000Z",
  "updated_at": "2026-10-15T10:00:05.000Z",
  "finished_at": null,
  "expires_at": null,
  "resume_at": "2026-10-15T10:01:02.000Z",
  "blocking_reasons": [{"code":"LOCAL_QUOTA_EXCEEDED","count":2}],
  "recovery_conditions": [],
  "job_error": null,
  "recent_refreshes": [{"result_id":"<result-uuid>","city":"London","completed_at":"2026-10-15T10:00:05.000Z"}],
  "recent_failures": [{"result_id":"<other-result-uuid>","code":"CITY_AMBIGUOUS","city":"Springfield"}],
  "rejected_rows_url": "/bulk/jobs/12345678-1234-4234-8234-123456789abc/results?view=rejections"
}
```

`updated_at`/`counters_version` indicate the persisted progress snapshot, not provider observation freshness. `in_flight>0` keeps status running even while other outcomes are blocked. Add `unfinished=pending+in_flight` and an explicit `state_evaluated_at` to production responses for recovery visibility.

### GET /bulk/jobs/{job_id}/results?limit=&cursor=

Default view returns immutable admitted-entry slots. Strictly validate `limit` as integer 1–100, reject repeated/unknown query parameters, and use a versioned opaque base64url cursor containing job ID, view, admission generation, and last ordinal. Bind and validate all fields; do not reuse history cursors. Encode schema, not arbitrary SQL values. Keyset query is `job_id = J AND ordinal > last ORDER BY ordinal ASC LIMIT limit+1`; no sorting/filtering by mutable status or refresh time. Cursor version and job binding prevent cross-job/view reuse. Return null `next_cursor` at the end.

```json
{
  "job_id": "12345678-1234-4234-8234-123456789abc",
  "view": "entries",
  "counters_version": 12,
  "admitted_entries": 7,
  "total": 6,
  "rejected_rows": 2,
  "entries": [
    {"entry_id":"<uuid>","ordinal":1,"record_number":2,"row_number":2,"city":"London,GB","occurrences":1,"result_id":"<result-uuid>","canonical_city_id":"<city-uuid>"},
    {"entry_id":"<other-uuid>","ordinal":2,"record_number":3,"row_number":3,"city":"<verified alias>","occurrences":1,"result_id":"<result-uuid>","canonical_city_id":"<city-uuid>"}
  ],
  "outcomes": {
    "<result-uuid>": {
      "city": "London",
      "status": "pending",
      "last_refreshed_at": "2026-10-15T09:30:00.000Z",
      "last_error": {"code":"LOCAL_QUOTA_EXCEEDED","detail":"Minute budget unavailable."},
      "resume_at": "2026-10-15T10:01:02.000Z",
      "recovery_condition": null,
      "attempts": 1,
      "completed_at": null,
      "weather": null,
      "provisional_weather": {"city":"London","country":"GB","temperature_celsius":18.5,"condition":"clouds","humidity_percent":72,"observed_at":"2026-10-15T09:20:00.000Z"},
      "provisional_expires_at": "2026-10-16T09:30:00.000Z"
    }
  },
  "next_cursor": "<opaque-token>",
  "rejections": {"count":2,"url":"/bulk/jobs/12345678-1234-4234-8234-123456789abc/results?view=rejections"}
}
```

`outcomes` contains each referenced current live result once per response. A successful outcome includes `weather` snapshot, source (`cache`/`provider`), fetched/fresh/observed/completed timestamps, and no pending reason. A permanent failure has no successful weather; include its sanitized code/detail and qualification suggestions. Provisional weather is never returned in `weather`, never counted successful, and becomes null once its original backup lifetime expires, even if an old JSON snapshot remains in storage. Terminal successful historical snapshots remain visible for job retention despite their later age.

Add the optional query `view=rejections` to this same endpoint, with the same limit rules and its own job-bound cursor over `record_number`. Return `{job_id, view:"rejections", rejected_rows, errors:[{record_number,row_number,end_line,codes,detail,value_preview}], next_cursor}`. This exposes all rejected rows without a fourth endpoint or an unbounded array attached to every result page. The default view links to it and includes rejection count. Do not mix rejections into processing totals/order.

Each page is internally consistent, but statuses, canonical references and total may change across pages. Membership and ordinals never change; clients deduplicate outcome objects by result ID rather than assuming each entry is a different City. A page token survives canonical merging. No snapshot transaction is held open across HTTP requests. Admission is complete before the first page, so no new entries are appended. A repeated upload always gets a new job and a new independent membership graph.

## 9. Retention and cleanup

Set `finished_at` once on `done` or unrecoverable job `failed`, and `expires_at=finished_at+30 days`. Active queued/running/pending jobs have null `finished_at`/`expires_at`; they and their completed snapshots/rejection details are not deleted merely because upload age exceeds 30 days. Indefinitely pending work therefore has potentially indefinite storage. Expose its age/backlog and provision disk; do not quietly abandon work to meet a retention target.

Hourly cleanup claims expired terminal jobs in bounded batches (e.g. 100 jobs then chunked child deletes), fences against new dispatch, removes their queue deliveries/dispatch records, then deletes the private DB graph. Mark expiry logically before physical cleanup so GET returns 404 at the deadline even if deletion lags. Retrying cleanup after a crash is safe. Deferred BullMQ messages for deleted/expired parents are no-ops. Do not delete shared City/alias/identity records, history, quota windows, or weather just because the last referencing job expired.

Queue success/failure message history may be retained for 24 hours with a bounded count; logical results remain in PostgreSQL for 30 terminal days. Pending DB work is redispatched with new generations regardless of BullMQ housekeeping. Abandoned hidden admissions use the shorter admission lease cleanup, not the terminal retention clock. Raw CSVs are removed immediately after admission or rejection; retain structured rejections and first-input metadata, not uploaded files.

## 10. Ordered implementation steps with dependencies and acceptance criteria

| Step | Changes and dependencies | Acceptance gate |
|---|---|---|
| 1. Lock baseline contracts | Record existing routes/config/errors; add preserved API characterization assertions; settle the two-layer results contract before coding its handlers | Existing HTTP responses/auth/history semantics captured; no change to `/weather` validation or first-match behavior |
| 2. Foundation | Add pinned BullMQ/ioredis/Busboy/csv-parse dependencies and lockfile changes; runtime/clock/sleep/random/ID injection; pure normalization | Strict build; normalization fixtures and dispatch retry classifications deterministic |
| 3. Additive storage | New Prisma models/migration/partial constraints/indexes; repo methods and counter invariants | Empty-DB and existing-history migration pass; alias/place upsert races and rollback verified |
| 4. Shared weather service | Extract core fetching from HTTP facade; envelopes and legacy key compatibility; preserve existing quota Lua/key names; add capacity/continuity support | All existing weather/provider/history tests pass except intentional bulk-404 removal; HTTP success always records history; direct core calls never do |
| 5. City resolver/index | Bulk candidates, syntax/qualification checks, alias policies, DB-backed nonexpiring Redis index, versioned rebuild/revalidation | Ambiguous bulk failures leave HTTP first-match unchanged; TTL=-1 on geo keys; weather expiry never removes geo |
| 6. Admission | Stream multipart/file/CSV; staged batched rows, normalization dedup, row diagnostics, counters; no provider or queue side effects before full validation | 10 MiB/100,000/200 boundaries; fatal late CSV error publishes nothing; memory does not scale with an in-memory row array |
| 7. Enqueue gate | Bootstrap/outbox, private readiness phases, compensating cleanup and abandoned-admission leases | 202 only after acknowledged enqueue and ready commit; enqueue timeout/DB commit failure never executes hidden work |
| 8. Worker vertical slice | Conditional claims, canonical merge, fresh cache success, snapshots, permanent item failures, per-job totals | One final result per verified City/job; stable entry pagination through merges; counter equations always hold |
| 9. Scheduling/recovery | Capacity-aware bounded dispatch, durable pending reasons/backoff, config-repair conditions, lease heartbeat/stall repair, outbox reconciliation | Provider/quota/Redis/DB outage recovery and SIGKILL scenarios preserve finals and automatically resume unfinished work |
| 10. Bulk query APIs | Status, aggregates, default entries/outcome map and rejections view; strict job-bound keyset cursors | Immediate visibility after 202; all pages return each entry once in order despite live updates/merges; bounded rejection access |
| 11. Retention/ops | Terminal retention sweeper, raw/staging cleanup, index rebuild/repair/status commands, sanitized operational metrics | 30-day terminal boundary; >30-day pending job retained; cleanup does not delete shared records or reset quotas |
| 12. Docker/docs/samples | Worker startup, isolated integration profile, README/old scope corrections, sample CSVs, local smoke scripts/handoff | Clean Compose startup/migrations; worker restart recovery; documented commands reproducible with injected configuration |
| 13. Final local verification | Run build/unit/integration/end-to-end/recovery matrix and record actual evidence in VERIFICATION.md | All gates below pass; no cloud/account/email/Git publication action performed |

Feature acceptance criteria:

- Every accepted job has complete staged membership and recorded structural row rejections before processing begins. Admission makes exactly zero provider calls.
- Each whole-upload rejection leaves no ready job; any unavoidable outage-delayed cleanup is nonexecutable and automatically drained after recovery. No temporary upload file remains after normal success/failure.
- A 100,000-row, <=10 MiB fixture is admitted without loading the file/whole result set into memory. Target API container RSS below 256 MiB for one such admission in the documented test environment; record baseline/peak rather than asserting a universal machine-independent latency target. DB row batches <=500; raw buffers <=file ceiling, normal stream high-water marks approximately 64 KiB.
- At most the configured 55/900,000 reservations are admitted in each rolling window across concurrent API/worker calls; tests use lower limits for exact counts. Retries/geocoding are included; no cache hit consumes a reservation.
- Fresh-at-processing success is counted once; permanent errors count once; row rejection never increments worker failed. Fresh snapshots remain unchanged after later global weather refreshes.
- After quotas reset or dependencies recover, due work is redispatched within the 5-second reconciliation interval plus bounded backoff/queue latency in a healthy local environment. Config-repair waits are explicit and do not require a new upload.
- Final outcomes survive worker/process/dependency restarts. Duplicate delivery cannot change finals or inflate counters. Concurrent jobs may dispatch duplicate upstream calls, all counted.
- Default pagination visits exactly `admitted_entries` immutable slots, with no omission/duplication across status updates/canonical merges. All rejected rows can independently be paginated. Outcome uniqueness and both counter equations hold after every merge/finalization.

## 11. Deterministic test matrix

Use Jest/Supertest for API and core tests; real isolated PostgreSQL/Redis/BullMQ for integration/concurrency/recovery. All provider transport is mocked or served by a local scripted fake-provider service. No automated test uses live OpenWeather or production Redis/DB. Current integration tests call `flushDb` and clear history, so keep them strictly isolated; extend table cleanup for new models.

Inject a Clock (`now`, scheduler/timer abstraction), Sleep, Random and IDs into core components/provider. Production quota/lease time comes from Redis/DB server time, not host clocks. For deterministic Lua quota-boundary integration tests, use a test-only script adapter passing a controlled timestamp into the same reservation logic; production always calls Redis TIME and exposes no HTTP/env time override. Also retain one real-server-time smoke of the production Lua path. For real BullMQ scheduling tests, use short bounded polling or controlled delayed-job promotion and barriers, not multi-minute sleeps or fake global timers around live Redis sockets.

| Area | Required scenarios and assertions |
|---|---|
| Existing API regression | Auth before dependencies; unchanged 100-character weather input grammar/response/error shape; first match; fresh hit/miss, 24h fallback/expiry without renewal; every successful HTTP request persists history including shared fetches; delete/cursor behavior unchanged |
| Multipart/format | Missing file, wrong field, second file, extra text part, unsupported extension/MIME/charset, XLS/zip bytes, invalid UTF-8, BOM, LF/CRLF, malformed multipart, upload disconnect/timeout, file-byte limit exact/+1 |
| CSV shape/counting | Headerless city lists, preservation of the first city, first-record column errors, quoted commas/escaped quotes, embedded newline line numbers, blank/whitespace/quoted-empty records, extra/empty columns, malformed quotes late in file |
| Structural admission | Exactly 200 vs 201 code points; emoji vs JS code units; trim before count; oversize before dedup; NFKC/case/space dedup; invalid syntax accepted for worker; no provider/index/existence check; zero admitted 400; exactly 100,000 vs 100,001 nonblank records |
| Partial rejection | Valid+oversize+extra-column rows -> 202; correct rejection counts/reasons/line numbers and rejection pages; worker failed remains zero until actual city error |
| Fatal atomicity | Last-row parser error/oversize file/row count -> no ready records/dispatch; queue.add rejection/ambiguous timeout; ready-commit failure after enqueue; temporary-file cleanup and delayed compensation under dependency outages |
| Identity | Same-name different countries/states; candidate zero/one/multiple/capped five; returned state full-name matching; unsubstantiated qualifier; HTTP alias not sufficient for bulk; exact signature upsert race; revalidation coordinate drift/conflict |
| Canonical merge | Normalized duplicates and separately verified aliases; merge before weather success, after another alias succeeds, concurrent bind, obsolete lease/delivery; stable entry IDs/order; total/duplicate version changes; one final stored canonical outcome |
| Geolocation persistence | Geo Redis TTL=-1, DB rebuild after index-only deletion, old rebuild vs new version race, cache expiry independent, 30-day due boundary, quota-blocked revalidation, HTTP/bulk policy isolation |
| Weather reuse | Shared API/worker fresh hit zero provider attempts; known geo/weather miss one attempt; unknown query geo+weather two; backup only provisional; backup expires in pending response; later global refresh cannot mutate job snapshot |
| Quota/concurrency | Many API+worker geocode/weather attempts at minute/month boundaries; no refunds on timeout/429; retry budget; available-capacity race; cooldown extends only; exhausted misses pending while cached items succeed; two workers may fetch same city |
| Pending/state | Mixed in-flight+blocked -> running; all blocked -> pending; due claim -> running; all permanent failures -> done; invalid payload transient; auth repair revision; job-level corrupt-data failure preserves completed snapshots |
| Retry behavior | Exact transient-operation attempts; no immediate retries on syntax/not-found/ambiguity/auth/quota; capped deterministic durable backoff, attempts updated on existing result; fake month advancement resumes without real waiting |
| Crash recovery | Kill before/after cache write and DB commit/queue ack; kill while bootstrap preparing; stalled BullMQ delivery; expired DB lease; final-state replay; new dispatch generation after queue history cleanup |
| Infrastructure | Redis unavailable during reserve/cache/enqueue; PostgreSQL fails before claim/during result commit; recover and reconcile; AOF restart persistence; total Redis loss triggers continuity hold; fresh weather remains usable where restored |
| Pagination/summary | Default/max limits, repeated/unknown args, bad/noncanonical base64, cross-job/view tokens, tied errors/order, last/empty pages, live merge between pages, per-page repeatable-read consistency, outcome-based aggregates |
| Retention | 30 terminal days exact boundary; >30-day pending active job; failed job unfinished items; stale provisional hidden after its own deadline; chunk cleanup crash/resume; shared city/geo/history/quota survives job deletion |
| Resource/observability | Large streaming fixture memory/row batches, no raw file in queue, sanitized logs/provider failures; admission/outbox/lease/cleanup backlog diagnostics; no new global limiter or fairness promise |

Use crash barriers/latches in tests, not timing guesses, to position failure between persistence operations. For concurrency, start operations together with barriers and inspect database invariants and actual mocked dispatch counts; do not assert exactly one upstream call across processes.

## 12. Docker startup, configuration, and end-to-end verification commands

### Compose changes to implement

Keep current postgres/redis/migrate/api services, persistent named volumes, Redis AOF `always`/`noeviction`, and localhost-only API port. Add `worker` from the same non-root runtime image, command `node dist/src/bulk/worker.js`, `init: true`, `restart: unless-stopped`, depending on successful migrate and healthy dependencies. API and worker each compose dependencies through the shared runtime factory. The worker hosts processor + outbox/reconciliation/retention loops with DB coordination so multiple replicas are safe. Queue loss/connection health must not prevent existing history routes from serving when their PostgreSQL dependency is healthy.

Add private API upload tmpfs or container-local staging with an explicit budget (e.g. 128 MiB), request disconnect cleanup and safe stale-directory sweep. It need not be shared with workers. Disk/tmpfs exhaustion returns safe 503 with cleanup and no processing gate. Add worker heartbeat/readiness diagnostics through a local operational command rather than a public unauthenticated endpoint. Migration failures must prevent API/worker startup; reconnect loops handle dependencies that fail after startup.

Proposed new configuration, placeholders/defaults documented in `.env.example` without reading private files:

| Name | Default/purpose |
|---|---|
| `BULK_UPLOAD_MAX_BYTES` | 10485760; agreed contract ceiling, do not silently increase |
| `BULK_UPLOAD_MAX_ROWS` | 100000 nonblank records |
| `BULK_CITY_MAX_CODEPOINTS` | 200; existing HTTP validator unchanged |
| `BULK_UPLOAD_TIMEOUT_MS` | 120000 |
| `BULK_STAGING_DIR` | `/tmp/cityweather-uploads` |
| `BULK_DB_BATCH_SIZE` / `BULK_DISPATCH_BATCH_SIZE` | 500 each |
| `BULK_WORKER_CONCURRENCY` | 5 per process; resource parallelism, no extra rate limiter |
| `BULK_RECONCILE_INTERVAL_MS` | 5000 |
| `BULK_LEASE_SECONDS` / `BULK_LEASE_HEARTBEAT_SECONDS` | 90 / 15 |
| `BULK_PENDING_BACKOFF_MAX_SECONDS` | 300 |
| `BULK_RETENTION_DAYS` | 30 terminal days |
| `GEO_REVERIFY_DAYS` | 30 |
| `PROVIDER_CONFIG_REVISION` | Opaque nonsecret deployment revision, changed after provider configuration repair |
| `BULK_CURSOR_VERSION` | 1; schema-versioned job/view-bound encoding, not an authentication secret |

Validate all values at startup. Preserve existing required credentials, 900-second Compose weather freshness setting, provider timeout/retry configuration, and quota values. API and worker must share the same account namespace and budget configuration; detect conflicting budget settings through the account guard and fail new provider dispatch rather than silently using different caps. No secret values or private `.env` contents appear in docs/logs. Do not run `docker compose config` in a way that prints expanded credentials.

### Commands for the future implementation

These are instructions to execute after implementation, not actions performed while writing this plan. Commands marked planned must be supplied by the implementation. Run in PowerShell from this repository. `docker compose` reads runtime configuration without displaying it; provide required secrets through runtime injection/the user's existing local setup. Do not print or copy private env contents. A placeholder-only `.env.example` may be used explicitly for isolated tests.

```powershell
# Planned implementation exposes start:worker and local operations/scripts.
# Existing scripts already include generate, build, test:unit, migrate.
npm ci
npm run generate
npm run build
npm run test:unit

# Uses the user's configured runtime environment; no credential output.
docker compose config --quiet
docker compose up --build -d
docker compose ps
docker compose logs --tail 100 worker

# Isolated tests only; never target the application's real DB/Redis.
docker compose --env-file .env.example -p cityweather-tests -f compose.test.yml --profile test up --build --abort-on-container-exit --exit-code-from tests
docker compose --env-file .env.example -p cityweather-tests -f compose.test.yml --profile test down
```

Extend `compose.test.yml` to start scripted fake provider transport and real isolated worker connections in the test runner; add a separate test worker service only where cross-process crash tests require it. Dockerfile currently copies only `src`, tests and build config, so explicitly copy future `data/` and required test/operations scripts to the appropriate test/runtime stages. Never copy `.env` into an image.

Provide `data/cities-valid.csv`, `cities-mixed.csv`, `cities-ambiguous.csv`, `cities-aliases.csv`, `cities-malformed.csv`, and a deterministic large-fixture generator. Provider-dependent alias expectations belong in mocked fixtures; real provider matching is not a deterministic sample promise. Example valid file:

```csv
city
"London,GB"
"Portland,OR,US"
"Tokyo,JP"
```

Example usage with a deliberately public placeholder credential, replaced locally by injected client configuration:

```powershell
curl.exe -i -H 'X-API-Key: replace-with-application-key' -F 'file=@data/cities-valid.csv;type=text/csv' http://localhost:3000/bulk/import
curl.exe -H 'X-API-Key: replace-with-application-key' 'http://localhost:3000/bulk/jobs/12345678-1234-4234-8234-123456789abc'
curl.exe -H 'X-API-Key: replace-with-application-key' 'http://localhost:3000/bulk/jobs/12345678-1234-4234-8234-123456789abc/results?limit=20'
curl.exe -H 'X-API-Key: replace-with-application-key' 'http://localhost:3000/bulk/jobs/12345678-1234-4234-8234-123456789abc/results?view=rejections&limit=20'
```

Provide a planned `src/ops.ts` compiled entrypoint (`status`, `rebuild-geo-index`, `repair-alias`, `reconcile`, `verify-local-bulk`) using injected runtime credentials without printing them. `verify-local-bulk` checks preexisting history counts, uploads the sample via HTTP, polls/paginates all entries and rejections, verifies one repeat upload gets another job, checks cache/quota counts, and verifies bulk did not append history; explicit HTTP weather smoke requests do append history. It preserves unrelated production data and makes live provider calls only when the operator explicitly chooses the live mode.

```powershell
# Planned commands, using runtime dependencies inside the existing image.
docker compose exec worker node dist/src/ops.js status
docker compose exec worker node dist/src/ops.js rebuild-geo-index
docker compose exec worker node dist/src/ops.js reconcile
docker compose exec api node dist/src/ops.js verify-local-bulk --live

# Repeat only in the isolated recovery-test project to exercise pending work.
# The preceding test command removed this stack; start dependencies explicitly.
docker compose --env-file .env.example -p cityweather-tests -f compose.test.yml --profile test up -d postgres-test redis-test
docker compose --env-file .env.example -p cityweather-tests -f compose.test.yml --profile test run --rm tests npm run test:recovery
docker compose --env-file .env.example -p cityweather-tests -f compose.test.yml --profile test down

# Ordinary local service restart keeps PostgreSQL/Redis named volumes.
docker compose restart worker
docker compose restart redis
docker compose exec worker node dist/src/ops.js status
```

Add the planned `test:recovery` package script; it must deploy migrations before recovery tests, as the one-shot `run` command overrides the current test-service command. Include any future cross-process worker/fake-provider service in the explicit dependency startup list, or manage those child processes inside the test harness. No command should rely on a previously stopped test stack. Record real build/test/startup/smoke evidence and limitations in VERIFICATION.md after execution; do not present these commands as proof they passed.

## 13. Documentation, transcript gaps, local-delivery checklist, and remaining contradictions

### README and repository deliverables

- Rewrite README's top-level three-route/no-bulk exclusion while preserving existing endpoint examples and deployment boundaries. Add architecture/trade-offs, stream validation vs worker existence checks, limits/counting, normalization/ambiguity limitations, two-layer result contract, quota accounting, snapshots and pending/retention behavior.
- Mark `weather-implemenation.md` as historical for bulk scope; link to this plan. Update VERIFICATION.md with actual new evidence only, keeping prior results dated. Add all sample CSVs and commands, worker/migration/configuration steps, new error examples, pagination/rejection examples, no-history bulk behavior and authenticated usage.
- Troubleshooting must cover malformed/unquoted comma CSVs, row-vs-city failures, quota reset vs 429 cooldown, credential/config-revision repair, worker stopped/stalled, Redis noeviction memory pressure, DB migrations, missing queue deliveries, rebuilding only the geo index, identity-review repair, indefinitely pending disk growth and safe volume preservation.
- Keep lockfile, strict TypeScript, migrations, Docker files and ignore rules. Exclude staging/tmp/fixture output from version control and image context as appropriate. Do not add secrets, API keys, private CSVs, or private env contents to transcripts or logs.

### Transcript and Git inventory

Observed: `prompts/2026-10-14-codex.md` explicitly says it summarizes the session rather than being exhaustive; `prompts/2026-10-15-codex.md` is also a short request/decision/verification summary. No complete `.jsonl`/exported chat files, Claude hooks/settings directory, or `prompts/notes.md` are present in the inspected repository file inventory. This does not establish whether full exports exist elsewhere; no private user-profile transcript directories were searched.

Missing complete repository exports include the 2026-10-14 initial implementation/setup/recovery conversation(s), the 2026-10-15 cache-policy conversation, the earlier ten-question bulk review, and this final-requirements/planning conversation. The exact number of source sessions requires the user's export inventory; do not invent transcripts from summaries. Preserve notes and add redacted complete exports when supplied/exported, including dead ends, with dates/tool names and a manifest explaining genuine gaps. This planning task creates only this plan and does not claim to satisfy the export requirement.

Observed: `git status --short` fails with “not a git repository.” Therefore there is no locally verifiable commit history, branch/remotes, push status or collaborator record here. `package-lock.json` exists on disk; its committed status cannot be established. Do not initialize Git or create a remote as part of planning.

### Task.md deployment/submission handoff (unexecuted)

The local feature can satisfy Task.md's functional/database/queue/testing/documentation requirements. Cloud deployment, a README deployed URL/demo credential policy, private repository history, collaborator access, pushes, complete transcript exports and evaluation/progress email remain external handoff work. After separate authorization, an operator should select hosting with persistent PostgreSQL/Redis and an always-on worker, configure runtime secrets, run migrations before API/worker rollout, test the three old plus three new routes, then document the real URL. Do not invent a deployed URL or publish the application's actual API key in this local plan.

Task.md requests a private repository (no fork), collaborator `tech@jumeaucapital.com`, meaningful incremental commits, complete redacted prompts/exports and an evaluation email with subject `Node Data and Backend Engineer Exercise evaluation: [your full name]`. It requests daily done/next/blocked updates and a separate query subject for questions. Prepare a handoff checklist/template; execution of invitations, pushes or messages is outside this task. If the historical development was not committed daily, document that limitation rather than fabricating history.

### Local-delivery checklist for the future implementation

- [ ] Preserve existing API behavior and pass its regression suite.
- [ ] Add migration, constraints/indexes, shared fetch service, durable geo index and atomic shared quota integration.
- [ ] Complete streamed partial-row admission, fatal-rejection cleanup and acknowledged-enqueue readiness gate.
- [ ] Complete worker processing, canonical merges, snapshots, pending/resume, crash recovery and terminal retention.
- [ ] Deliver authenticated status/results/rejections views with exact counters and stable admission-entry pagination.
- [ ] Deliver Docker worker, placeholder configuration, operational/rebuild commands and sample CSVs.
- [ ] Run deterministic unit/integration/concurrency/outage/restart tests and the documented local end-to-end flow; record measured memory, timings and any limitations.
- [ ] Update README, historical scope pointers, VERIFICATION and transcript-gap manifest; distinguish summaries from complete exports.
- [ ] Hand off cloud/submission/Git/export gaps explicitly, with no unauthorized remote action or invented verification.

### Remaining contradictions and recommended resolutions

| Issue | Resolution and exact limitation |
|---|---|
| Stable immediate membership vs canonical-only flat results | Use immutable admission `entries` plus unique referenced `outcomes`. This is the recommended interpretation used throughout this plan. If a flat canonical-only array is mandatory, either allow membership changes/redirect tombstones or postpone canonical paging until resolution completes; neither can satisfy the literal combination. Confirm this contract interpretation before implementing its API, without blocking independent foundation/schema work |
| `total` distinct cities before workers may verify identity | Initially total is admission-distinct processing units and is explicitly provisional; decrease it on proven alias merges, exposing alias duplicates and counters version. An exact immutable canonical total at 202 is impossible without forbidden admission-time resolution. If immutable total is mandatory, it must instead mean input keys; that would change the stated canonical counting semantics |
| Global real-world canonical identity and ambiguity proof | OpenWeather candidate/metadata limitations prevent a perfect municipal identity/uniqueness guarantee. Use internal UUIDs, verified exact signatures, qualified-query candidate policy and explicit conflict review; do not promise fuzzy equivalence or complete ambiguity detection |
| 30-day retention vs indefinite pending | Retention begins at terminal completion. Active job data can exceed 30 days and requires operational storage monitoring; it is never silently expired |
| Cleanup during unavailable Redis/PostgreSQL | Keep admission nonexecutable and compensate automatically after recovery. No cross-store protocol can guarantee immediate physical cleanup while a store is unreachable; tests prove the gate, eventual removal, and no provider dispatch |
| Dispatched-attempt accounting vs crash before socket send | Redis reservation immediately precedes dispatch; no refunds and conservative overcount on a crash are intentional. Exact external call counting cannot be made atomic with a remote HTTP server |
| 30-day geolocation verification vs always reuse fresh weather | Reuse known strict alias + fresh weather without provider calls, schedule due verification separately; require revalidation before a subsequent cache-miss fetch. An invalidated mapping is not reusable. Treat 30 days as due age, not coordinate deletion or a command to bypass a fresh weather hit |
| Redis data loss vs safe quota recovery | Ordinary persisted restarts resume immediately; unknown lost quota history requires a verified ledger restore or the conservative automatic rolling-window hold. Rebuilding coordinates/queues alone does not reconstruct request history |

There is no remaining blocker to producing this plan. The entries/outcomes interpretation and provisional total are explicit recommended resolutions to genuine requirements tensions, not claims that a canonical-only stable flat list is possible. No application implementation, cloud operation, repository mutation, invitation, push, or email is authorized by this document itself.
