# CityWeather+

For cloud deployment, see [the Render setup and manual steps](RENDER.md). The root `render.yaml` runs the API, worker, PostgreSQL and Redis in one Docker container with a persistent disk. Local Compose still uses separate containers.

CityWeather+ serves current weather, shared search history, and streamed bulk CSV imports through six authenticated routes. `job-implementation.md` defines the bulk contract; its recommended immutable `entries` plus canonical `outcomes` interpretation is implemented. Local URL: `http://localhost:3000`. Repository: https://github.com/Albin-R-Thomas/jumeau. A deployed URL has not yet been supplied or verified. See [the submission audit](SUBMISSION.md) for requirement coverage and remaining delivery items.

## Approach

Node.js 24, strict TypeScript, Express 5, PostgreSQL 17, Prisma 6, Redis 7, and Jest. Routes authenticate and validate input before dependencies are accessed. `WeatherService` handles cache and coalescing; `Provider` validates OpenWeather payloads and controls retries; `RedisStore` reserves provider quota atomically; `PrismaHistory` records searches and implements deterministic keyset pagination.

One runtime coalesces simultaneous equivalent fetches. Every successful HTTP weather request persists its own history row before returning, including repeats and cache hits. Bulk processing never writes search history. PostgreSQL is authoritative for job membership, snapshots, counters, verification and recovery; BullMQ supplies durable delivery. Workers share the API's atomic Redis quota and canonical weather cache. Fresh weather lasts 900 seconds and backup usability ends 86,400 seconds after fetch. HTTP may fall back to eligible backup on provider failures/timeouts/quotas; bulk keeps that backup provisional and stays pending until fresh weather is available. Reads never renew freshness or retention. Provider authentication and not-found errors are not hidden by HTTP fallback. History routes remain usable during Redis outages.

The rolling month counter stores one Redis sorted-set entry per outbound attempt, retained for 31 days. This trades memory for exact rolling accounting (up to 900,000 entries at the default monthly budget); provision Redis accordingly. Redis AOF uses `appendfsync always` for quota durability and `noeviction` to prevent memory pressure from silently discarding quota. PostgreSQL and Redis use named volumes. Do not delete Redis storage to reset limits: that loses attempted-call accounting. Persistent data is local to this Compose project.

## Setup and startup

Install Docker Desktop with Linux containers / Docker Compose. The image supplies Node.js 24; a host Node installation is optional.

1. Copy `.env.example` to `.env` and replace credential placeholders locally. Do not commit or share `.env`.
2. Set `API_KEY` for clients, your `OPENWEATHER_API_KEY`, and matching PostgreSQL values. `DATABASE_URL` must reference `postgres:5432`; percent-encode special characters in URL credentials. `REDIS_URL` defaults to `redis://redis:6379`.
3. Run:

```sh
docker compose up --build -d
```

Only `127.0.0.1:3000` is published by default. `PORT` changes the host port; the container listens on 3000. Database and Redis ports are private. Health checks gate the one-shot `migrate` service (`prisma migrate deploy`), then API and worker start after migration succeeds. Both use the same non-root image. The API has a private 128 MiB upload tmpfs. The worker hosts processing, outbox dispatch, lease recovery and terminal cleanup; worker replicas are supported without multiplying account quotas.

If `.env` already holds your OpenWeather key and you need generated local application/database credentials, run `node scripts/setup-local.cjs`. It creates the ignored `.env.runtime` without reading or overwriting existing configuration or printing credentials. Then use the following prefix for all production Compose commands:

```sh
docker compose --env-file .env --env-file .env.runtime up --build -d
```

The second file supplies generated application/database credentials and local defaults; `OPENWEATHER_API_KEY` comes from your existing `.env`. Keep `.env.runtime` with the database volume so subsequent starts retain the same database credentials. Client authentication uses the `API_KEY` stored in `.env.runtime`.

```sh
docker compose ps
docker compose restart api
docker compose down
```

`down` preserves named volumes. Never add `-v` unless you intend to destroy data. To explicitly apply migrations against an existing running database:

```sh
docker compose run --rm migrate
```

The application reads injected environment variables only; it has no dotenv loader. Compose loads `.env` at runtime. `.env` is ignored by Git and Docker. Logs contain generic errors without upstream URLs, keys, headers, or dependency connection strings. Avoid `docker compose config` or inspection commands that display environment values when using real credentials.

| Variable                                            | Default / requirement                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                                          | `production`; also accepts `development`, `test`                                                       |
| `PORT`                                              | 3000                                                                                                   |
| `API_KEY`, `OPENWEATHER_API_KEY`                    | Required nonempty credentials                                                                          |
| `DATABASE_URL`, `REDIS_URL`                         | Required valid PostgreSQL / Redis URLs in application                                                  |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Required by Compose                                                                                    |
| `WEATHER_CACHE_TTL_SECONDS`                         | 900 (15 minutes); Compose explicitly pins 900 so legacy private env files cannot retain the old policy |
| `PROVIDER_TIMEOUT_MS`                               | 5000 per attempt, up to 60000                                                                          |
| `PROVIDER_MAX_RETRIES`                              | 2; accepts 0–2                                                                                         |
| `PROVIDER_CALLS_PER_MINUTE`                         | 55; accepts 1–60                                                                                       |
| `PROVIDER_CALLS_PER_MONTH`                          | 900000; accepts 1–1000000                                                                              |

## API

For a complete PowerShell/curl walkthrough, see [sample-curl.md](sample-curl.md). It includes startup, all six endpoints, the mixed CSV fixture, pagination and common error requests.

Every route requires `X-API-Key`. Examples below reference an already configured shell variable; never paste real keys into documentation or transcripts.

```sh
curl -H "X-API-Key: $API_KEY" 'http://localhost:3000/weather?city=London,GB'
curl -H "X-API-Key: $API_KEY" 'http://localhost:3000/history?limit=20'
curl -X DELETE -H "X-API-Key: $API_KEY" 'http://localhost:3000/history'
```

For PowerShell use `curl.exe` and `$env:API_KEY`. These commands assume the variable is populated; editing `.env` alone does not export it into your shell.

`GET /weather?city=` accepts one trimmed query of 1–100 JavaScript code units without control characters. Accepted forms are `city`, `city,CC`, or `city,STATE,US` (two-letter codes). Ambiguous names resolve to the first OpenWeather geocoding match (`limit=1`); qualify country/state where necessary. Repeated, malformed, or unknown parameters return 400. Versioned normalization uses NFKC, Unicode lowercase, collapsed whitespace and trimmed comma separators. Verified aliases can reuse the same canonical weather; differently qualified locations remain distinct. HTTP first-match verification never certifies bulk uniqueness.

Illustrative weather response:

```json
{
  "city": "London",
  "country": "GB",
  "temperature_celsius": 18.5,
  "condition": "scattered clouds",
  "humidity_percent": 72,
  "observed_at": "2026-10-14T08:00:00.000Z"
}
```

`GET /history?limit=&cursor=` defaults to 20, accepts integer limits 1–100, and returns:

```json
{
  "items": [
    {
      "id": "12345678-1234-4234-8234-123456789abc",
      "city_name": "London",
      "timestamp": "2026-10-14T08:00:00.000Z",
      "source": "provider"
    }
  ],
  "next_cursor": null
}
```

Rows are ordered by database UTC timestamp then UUID, both descending, with a matching index. Pass the opaque `next_cursor` unchanged to retrieve the next page. Cursors are strictly validated versioned base64url timestamp/UUID objects. They remain usable if the boundary row is deleted. Newly inserted rows above a cursor do not appear in later pages; start again to see new history.

`DELETE /history` atomically deletes all shared history and returns 204, including when empty. It does not clear cache or quota. Searches committed after the deletion may appear later. History has no retention expiry and is shared among clients using the configured API key.

Errors have `{ "detail": "...", "code": "..." }`:

| Status | Code                                               |
| ------ | -------------------------------------------------- |
| 400    | `INVALID_INPUT`                                    |
| 401    | `UNAUTHORIZED`                                     |
| 404    | `CITY_NOT_FOUND` / `NOT_FOUND`                     |
| 429    | `LOCAL_QUOTA_EXCEEDED` / `PROVIDER_QUOTA_EXCEEDED` |
| 502    | `PROVIDER_FAILURE` / `PROVIDER_AUTH_ERROR`         |
| 503    | `DEPENDENCY_UNAVAILABLE`                           |
| 504    | `PROVIDER_TIMEOUT`                                 |
| 500    | `INTERNAL_ERROR`                                   |

429 responses include `Retry-After` in seconds. Missing geocoding matches return 404. Provider 401/403 becomes 502 (the client application's API key is independent of the provider key).

## OpenWeather assumptions and attribution

Weather data is supplied by [OpenWeather](https://openweathermap.org/). Official docs checked on 2026-10-14:

- [Direct Geocoding](https://openweathermap.org/api/geocoding-api) supports city, US state, country, and `limit`. Verified coordinates and policy-specific aliases persist in PostgreSQL and nonexpiring Redis geo keys. Verification becomes due after 30 days; it does not delete coordinates.
- [Current Weather](https://openweathermap.org/api/current) accepts latitude/longitude and `units=metric`; built-in city lookup is deprecated. Returned fields map from `name`, `sys.country`, `main.temp`, `weather[0].description`, `main.humidity`, and UTC epoch `dt`.
- [Free pricing](https://openweathermap.org/price) lists 60 calls/minute and 1,000,000/month. This application does not use One Call or its separate daily allowance.
- [Account guidance](https://openweathermap.org/appid) says usage is accumulated across keys/products and recommends waiting ten minutes after limit errors. This app honors valid `Retry-After` seconds or HTTP dates, otherwise sets a shared ten-minute cooldown. Valid weather cache hits still work during cooldown. A provider 429 does not identify which allowance was exhausted.
- [Detailed pricing](https://samples.openweathermap.org/full-price) lists two-hour Free weather updates. The updated weather freshness TTL is **15 minutes (900 seconds)**, measured after a successful fetch; hits never extend it. After that, the API attempts a refresh and may use a separately retained **24-hour backup** for provider failures (including invalid provider payloads), timeouts, local quota exhaustion, or provider quota/cooldown errors. Backup retention is measured from the last successful fetch, not from the last fallback. Once that backup expires, the upstream error is returned. The 24-hour bound is an implementation choice for the newly approved stale-data behavior. This is neither an observation-age bound nor synchronization with provider updates. General ten-minute model guidance does not guarantee Free-tier freshness.

Every outbound attempt, including geocoding and retries, atomically reserves a rolling 60-second and rolling 31-day budget using Redis server time; attempted calls receive no refunds. Default budgets are conservatively 55/minute and 900000/31 days. Use an exclusive OpenWeather account or reduce budgets to allow for other usage; local counters cannot observe other clients. A rolling 31-day window is intentionally more conservative than calendar-month accounting.

Only network failures, timeouts, and 500/502/503/504 are retried, at most twice per operation, with exponential backoff and jitter. Invalid payloads, authentication failures, not-found, and quota responses are not retried. Automated tests never call live OpenWeather.

## Tests

Tests use a separate Compose file/profile, private database/Redis, placeholder credentials, and no published ports. The command explicitly selects `.env.example` so tests do not load local secret configuration.

```sh
docker compose --env-file .env.example -p cityweather-tests -f compose.test.yml --profile test up --build --abort-on-container-exit --exit-code-from tests
docker compose --env-file .env.example -p cityweather-tests -f compose.test.yml --profile test down
```

The test image compiles strict TypeScript, deploys the committed migration, then runs Jest unit and real PostgreSQL/Redis integration tests. Supertest exercises the complete authenticated provider → cache → history pagination → deletion flow with the provider HTTP transport mocked. Integration checks cover fresh-cache expiry, stale fallback/expiry and recovery, quota/cooldown fallback, cursor timestamp ties, deletion, atomic concurrent quota, rolling windows, cooldown, and dependency outages.

Optional host development (Node 24): `npm ci`, `npm run generate`, `npm run build`, `npm run test:unit`. Host integration tests require injected `NODE_ENV=test`, `DATABASE_URL`, and `REDIS_URL` pointing to disposable test services; integration tests clear their database history and Redis database. Do not use production dependencies for tests.

Redacted implementation session notes are in `prompts/`. They are manually curated notes, not a complete exported chat transcript. Verification results are recorded in `VERIFICATION.md`.

Existing v2 15-minute fresh/24-hour backup weather keys remain readable for their remaining lifetimes. New v3 canonical envelopes carry absolute fetch/fresh/backup deadlines and verification versions. Older 122-minute weather entries remain ignored. No rollout or rebuild clears quota keys.

## Bulk uploads and results

All bulk routes use the same `X-API-Key`. Each upload is independent, including identical files and repeated `Idempotency-Key` values. There is no replay deduplication.

```powershell
curl.exe -i -H 'X-API-Key: replace-with-application-key' -F 'file=@data/cities-valid.csv;type=text/csv' http://localhost:3000/bulk/import
curl.exe -H 'X-API-Key: replace-with-application-key' 'http://localhost:3000/bulk/jobs/JOB_UUID'
curl.exe -H 'X-API-Key: replace-with-application-key' 'http://localhost:3000/bulk/jobs/JOB_UUID/results?limit=20'
curl.exe -H 'X-API-Key: replace-with-application-key' 'http://localhost:3000/bulk/jobs/JOB_UUID/results?view=rejections&limit=20'
```

`POST /bulk/import` accepts exactly one multipart file named `file`, a `.csv` filename, and `text/csv`, `application/csv`, or `application/octet-stream`. UTF-8 only, optional BOM, LF/CRLF, no header, one city per record (the first record is a city). Quote comma-qualified values. No other parts or query parameters are accepted. At most 10,485,760 **file bytes**, 100,000 nonblank data records and 200 Unicode code points per trimmed city value. Existing `/weather` length validation remains separate.

For a city-name-only example, upload `data/cities-names.csv`:

```csv
London
Paris
Tokyo
Bengaluru
Mumbai
```

The multipart file is spooled privately, then decoded fatally and parsed as a stream. Database batches contain at most 500 records; the full dataset is never buffered in JavaScript. Admission only checks structure/value size, never provider existence, syntax, country qualification or ambiguity. Extra-column and oversized records are retained as structured row rejections while admissible rows proceed. Empty single-field records are ignored and counted as blanks. Logical record numbers start at the first city and include blank records; physical starting/end lines account for quoted newlines. Malformed quoting, invalid UTF-8, byte/row ceiling violations, or no admissible values reject the whole upload. Raw files are deleted on success/rejection; only entries and bounded row diagnostics persist.

Successful admission returns exactly `202 {"job_id":"UUID"}` and a status `Location`. It occurs only after complete staged membership, successful bootstrap queue acknowledgement, and a committed ready gate. Preparing jobs are hidden and nonexecutable. An enqueue timeout can leave a harmless message; it cannot open the gate. Abandoned staging is automatically removed after ten minutes. When storage is unavailable, cleanup is eventual after recovery. A crash after activation but before the client receives 202 may leave an accepted job unknown to that client.

The status endpoint exposes upload counts, processing totals, provisional/resolved total basis, timestamps, retries/conditions, top five successes/failures and grouped blocking reasons. These equations always apply:

```text
input_rows = rejected_rows + admission_duplicate_rows + admitted_entries
duplicate_rows = admission_duplicate_rows + alias_duplicate_rows
input_rows = rejected_rows + duplicate_rows + total
processed = succeeded + failed
total = processed + pending + in_flight
```

Case/whitespace/NFKC equivalents deduplicate at admission with an occurrence count. Accents and punctuation are preserved; lowercase is not full linguistic equivalence. Distinct inputs may later resolve to one canonical City; their immutable entry IDs/ordinals stay present and point to a single stored outcome. Each proven merge decreases `total`, increments `alias_duplicate_rows` and `counters_version`. `total_basis` remains provisional while unresolved unfinished entries exist. Structural rejections never count as worker failures.

Results default to `{job_id, view:"entries", entries:[...], outcomes:{RESULT_UUID:{...}}, next_cursor, rejections:{count,url}}`. Entries hold original display input, first record/line, occurrence count and canonical result reference. Outcomes carry pending reasons, attempts (claim cycles), original fetch time, successful weather snapshot or separately labelled provisional backup. A successful snapshot remains unchanged when the global cache refreshes or expires. Provisional backup disappears at its original deadline and never increases succeeded. Snapshots are historical results, not a promise of current freshness at read time.

Pagination defaults to 20, maximum 100. Strict versioned base64url cursors bind job, admission generation, view and last immutable ordinal. Entry membership remains stable through live merges; the same outcome can be referenced on different pages. Each page uses a repeatable-read database snapshot, without holding a transaction between requests. `view=rejections` pages all row diagnostics by record number. Unknown/expired/hidden job UUIDs return `404 BULK_JOB_NOT_FOUND`; malformed UUIDs/cursors/limits and unknown/repeated parameters return 400.

Additional upload errors include 400 `INVALID_MULTIPART`, `MALFORMED_CSV`, `NO_ADMISSIBLE_CITIES`; 413 `UPLOAD_TOO_LARGE`, `TOO_MANY_ROWS`; 415 `UNSUPPORTED_MEDIA_TYPE`, `UNSUPPORTED_CSV_ENCODING`; 408 `UPLOAD_TIMEOUT`; 503 `BULK_ENQUEUE_FAILED` or `DEPENDENCY_UNAVAILABLE`. Fatal diagnostics are bounded to 100; accepted-job rejection pages expose every rejected record.

## Identity, worker recovery and retention

Workers validate actual ISO country codes (pinned `i18n-iso-countries`) and a local US state/territory table, then geocode with up to five candidates. Zero matches, multiple acceptable matches, invalid grammar or unverifiable qualifiers are permanent per-city failures. HTTP still selects its first match. Bulk strict verification is separate from HTTP first-match metadata; country/state filters never silently choose the first ambiguous result. Full provider state names are normalized to codes. Provider-dependent aliases in sample CSVs are illustrative, not guaranteed matches.

City UUIDs are internal weather-location identities. Exact provider country/state/coordinate signatures upsert idempotently; same-name places can coexist. OpenWeather's capped candidate list does not prove global uniqueness, and different provider centroids can miss real-world equivalence. There is no fuzzy municipal matching. Compatible verified coordinate changes preserve the UUID and invalidate reusable weather through a version change. Conflicts wait for explicit local mapping repair.

Due strict aliases may reuse fresh canonical weather while independently scheduling revalidation; a cache miss waits for successful revalidation. Geo Redis keys have no TTL and rebuild from versioned PostgreSQL records. Neither weather expiry nor job retention deletes shared places, aliases, history or quotas.

One `bulk-weather` BullMQ queue uses `cityweather:bull` and ID/generation payloads. PostgreSQL leases and conditional completion fence stale workers. Outbox acknowledgement follows enqueue acknowledgement; absent deliveries are reconstructed, completed message IDs receive renewed generations where work remains. Every five seconds, the reconciler scans at most 500 due candidates, observes shared quota capacity to bound potential misses, and lets certified cache hits proceed. It does not reserve an entire import or add another rate limiter. Each actual geocode/weather/retry attempt still reserves atomically immediately before transport.

`queued` means never claimed; `running` means in-flight or previously started runnable work; `pending` means unfinished work is time/condition blocked; `done` means every live outcome is final, including all-city failures. `failed` is reserved for incompatible/corrupt job-level data, preserving completed snapshots and explicit unfinished work. Transient infrastructure/provider failures do not terminally fail a job. Backups remain provisional. Timeouts/network/5xx retry durably with capped 5–300 second backoff after the provider operation's existing short retries. Invalid payloads use the same backoff but become final per-row failures at the configured attempt limit (see assumptions below). Minute/month depletion waits for Redis's reset deadline. Provider 429 honors Retry-After or a shared ten-minute cooldown.

### Provider payload assumptions and recovery

- Geocoding may return candidates with an empty or omitted country. They remain in ambiguity checks; they are never silently discarded. Multiple distinct unqualified candidates produce `CITY_AMBIGUOUS`. A country-qualified query with any countryless candidate, or a sole selected countryless candidate, produces final `CITY_QUALIFICATION_UNVERIFIABLE`. This conservative policy avoids certifying a location from incomplete evidence. Use a new, better-qualified import after resolving permanent city errors.
- Coordinate weather may omit its display name/country or return a broad regional name. The verified bound `City` supplies the output name and country for coordinate weather fetches. A supplied provider country that conflicts with that identity still fails validation. Temperature, humidity, conditions and observation time remain required and validated; no measurements are invented. Coordinate responses without verified identity still require usable provider location metadata. Existing completed snapshots are unchanged.
- `BULK_INVALID_PAYLOAD_MAX_ATTEMPTS` defaults to **5** (range 1–1000). If an invalid payload occurs on a claim whose total `attempts` is at or above that limit, the row becomes `failed`, retains `PROVIDER_INVALID_PAYLOAD`, and has no next retry. This counts all claim cycles, not consecutive malformed responses; quota waits and other previous attempts can consume the budget. Other transient error codes keep their existing durable retry behavior. This bounds persistently malformed rows, not the overall job duration.
- Existing pending rows need no migration or manual database update. After deployment, they still get a fetch attempt: a valid response can succeed even above the limit, while another invalid response becomes final. With the investigated responses, Ifo and Smolensk should finish as ambiguous failures; Tangará da Serra and Cafunfo can succeed using their existing verified identities. Completion still depends on provider availability and the deployed identities/coordinates being correct; missing metadata does not independently verify a location.
- `PROVIDER_BASE_URL` defaults to `https://api.openweathermap.org`. Override it only for a trusted provider simulation; requests include the configured provider key. Production should keep the default.

To reproduce the reported response shapes locally without real provider calls, run `npm run build`, start `postman simulation run postman/simulations/provider-payloads.sim.yaml --port 4900 --output ndjson --no-history`, then run `node scripts/check-provider-payloads.cjs` in another shell. The mock is a minimal reproduction of the supplied production payloads, not an owner-published OpenWeather mock. The check exercises the real provider, resolver and weather fetcher over HTTP; database/cache persistence and live production completion require separate verification.

Provider auth failures persist the failing nonsecret `PROVIDER_CONFIG_REVISION`; repair injected credentials, increment that revision, then recreate both API and worker. Unchanged credentials are not repeatedly probed after restart. Redis/PostgreSQL recovery, expired leases, stalled/duplicate deliveries and worker crashes resume from durable work automatically. Cache writes before a crash can be reused; successful commits before queue acknowledgement remain final. Cross-process duplicate upstream requests are possible and all reserve quota. There is no distributed city lock, fairness scheduler or exactly-once external-call promise.

A PostgreSQL account guard records dispatch intent before reservation and checks a nonexpiring Redis continuity token. Ordinary AOF restarts retain budgets. Loss of the marker after prior use creates a conservative hold until 31 days after the last durable intent. Rebuilding queues/geo does not recreate a lost quota ledger. Conflicting API/worker budgets fail new dispatch closed. Initial installation adopts the existing quota namespace without deleting counters. Never remove Redis volumes to reset quota.

Terminal jobs expire exactly 30 days after completion and immediately become 404; cleanup deletes children in bounded chunks. Active pending jobs, even older than 30 days, retain their snapshots indefinitely and require storage monitoring. Abandoned uploads use the shorter staging clock. Queue history has a separate 24-hour/count bound. No raw CSV is needed by a worker.

At 55 attempts/minute, 100,000 unknown uncached cities requiring geocoding plus weather need at least 200,000 attempts, about 60.6 hours before retries. Five worker slots increase simultaneous work, not allowed account throughput. All clients should use the same exclusive provider account, or lower budgets to leave external headroom.

## Operations and configuration

```powershell
docker compose --env-file .env --env-file .env.runtime logs --tail 100 worker
docker compose --env-file .env --env-file .env.runtime exec worker node dist/src/ops.js status
docker compose --env-file .env --env-file .env.runtime exec worker node dist/src/ops.js rebuild-geo
docker compose --env-file .env --env-file .env.runtime exec worker node dist/src/ops.js reconcile
docker compose --env-file .env --env-file .env.runtime restart worker
docker compose --env-file .env --env-file .env.runtime exec api node scripts/smoke-bulk.cjs
```

If `.env` alone supplies complete configuration, omit the second `--env-file`. Host development uses injected environment variables, `npm run start:worker`, and `npm run ops -- status`. Operations report queue counts, live worker heartbeats, pending age/reasons, outbox backlog/age, expired leases, cleanup backlog and quota/hold state. Logs contain safe stages/codes/IDs and do not print credentials, CSVs or upstream transport URLs.

`ops repair-alias ALIAS_UUID` explicitly invalidates that alias, increments its version and releases its identity-review pending items for full provider verification. It does not rewrite completed job snapshots or delete shared cities. Inspect the mapping and confirm the intended location before running this repair. Use a corrected new import for permanent city failures. Queue repair and geo rebuild never flush Redis.

| Setting                                               | Default and bound                                 |
| ----------------------------------------------------- | ------------------------------------------------- |
| `BULK_UPLOAD_MAX_BYTES` / `BULK_UPLOAD_MAX_ROWS`      | 10485760 / 100000; may only lower agreed ceilings |
| `BULK_CITY_MAX_CODEPOINTS`                            | 200, may only lower                               |
| `BULK_UPLOAD_TIMEOUT_MS`                              | 120000                                            |
| `BULK_STAGING_DIR`                                    | `/tmp/cityweather-uploads` in Compose             |
| `BULK_DB_BATCH_SIZE` / `BULK_DISPATCH_BATCH_SIZE`     | 500 / 500, maximum 500                            |
| `BULK_WORKER_CONCURRENCY`                             | 5 per process                                     |
| `BULK_RECONCILE_INTERVAL_MS`                          | 5000                                              |
| `BULK_LEASE_SECONDS` / `BULK_LEASE_HEARTBEAT_SECONDS` | 90 / 15; lease must exceed twice heartbeat        |
| `BULK_PENDING_BACKOFF_MAX_SECONDS`                    | 300                                               |
| `BULK_RETENTION_DAYS` / `GEO_REVERIFY_DAYS`           | 30 / 30                                           |
| `PROVIDER_CONFIG_REVISION` / `BULK_CURSOR_VERSION`    | `initial` / 1                                     |

For unquoted comma errors, quote the full city value. Row rejections describe structure; `CITY_AMBIGUOUS` and other city failures come later from workers. Pending quotas expose retry times, while auth/identity repairs expose conditions. A stopped worker leaves durable entries queryable; restart it or run reconciliation after dependency repair. Redis `noeviction` memory errors pause dispatch: provision capacity without deleting the ledger. A failed migration prevents both runtime services from starting. Preserve all named volumes with `docker compose down` (never `-v` on application data).

## Extended verification and handoff

```powershell
docker compose --env-file .env.example -p cityweather-tests -f compose.test.yml --profile test up -d postgres-test redis-test
docker compose --env-file .env.example -p cityweather-tests -f compose.test.yml --profile test build tests
docker compose --env-file .env.example -p cityweather-tests -f compose.test.yml --profile test run --rm tests
docker compose --env-file .env.example -p cityweather-tests -f compose.test.yml --profile test run --rm tests npm run test:recovery
docker compose --env-file .env.example -p cityweather-tests -f compose.test.yml --profile test run --rm tests npm run test:large
docker compose --env-file .env.example -p cityweather-tests -f compose.test.yml --profile test down
```

Tests use isolated disposable dependencies only. All automated provider transport is mocked; crash tests SIGKILL a real child BullMQ worker at explicit persistence barriers. The standalone large test streams 100,000 and 100,001-row files, checks admission/no-provider-call behavior and batch size, and records baseline/peak RSS with a 256 MiB target. `npm run fixture -- 100000` generates an ignored sample large file. See `VERIFICATION.md` for checks actually executed and remaining limits.

Compose sets a 128 MiB V8 old-space budget for API/worker; the large test uses the same budget. This bounds heap growth between garbage collections, while database batching and stream backpressure bound retained dataset size. RSS also includes native Prisma, buffers and runtime code, so it exceeds V8 heap size.

Git history and an origin at `Albin-R-Thomas/jumeau` are present. Repository privacy, reviewer access and cloud deployment still require verification. `prompts/manifest.md` records genuine transcript gaps. Submission needs a working cloud URL, reviewer access, redacted conversation exports and the Task.md evaluation email; do not fabricate past daily updates or publish local credentials.

`HANDOFF.md` provides the remaining external-delivery checklist and unsent communication templates. Current measured verification is in `VERIFICATION.md`: 148 Docker tests pass, including 36 bulk integration/recovery tests; the final 100,000-row API measurement peaked at 243.3 MiB.
