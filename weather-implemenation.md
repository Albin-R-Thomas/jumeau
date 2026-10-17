# CityWeather+ implementation plan

Historical baseline plan. Its three-route/no-bulk scope is superseded by `job-implementation.md` and the 2026-10-15 bulk implementation. Keep this file as design history; use README.md for current behavior and commands.

This plan follows Task.md and the confirmed Q&A, with the user-approved cache update on 2026-10-15: 15-minute freshness and stale fallback when the provider is unavailable or quota is reached. No `.env` or secret values are inspected during repository work.

## Scope and existing setup

The repository initially contains only `Task.md`: no application, package manifest, Docker setup, Prisma schema, test suite, or Git repository.

Use Node.js 24 LTS, npm with a committed lockfile, strict TypeScript, Express, Prisma, PostgreSQL, Redis, and Jest. Run the application and dependencies through production-style Docker Compose, with persistent PostgreSQL storage and no hot reload.

Implement only:

- `GET /weather`
- `GET /history`
- `DELETE /history`

Protect all three endpoints using an environment-configured API key. Record every successful weather request, including cache hits and repeats, using the provider's resolved city name. Retain history until deletion.

Differences from Task.md:

- Express, Prisma, and Jest are fixed choices rather than alternatives.
- Docker Compose is required.
- Exclude CSV processing, bulk imports, BullMQ, workers, bulk-job APIs, `City` and `BulkJob` models, and associated tests/documentation.
- Bulk idempotency and larger-data evaluation criteria are outside scope.
- Delivery is local only. Exclude cloud deployment, remote repository creation, collaborator invitations, pushes, and emails.
- Include README, lockfile, migrations, and redacted `prompts/` notes.

## OpenWeather verification

Verified against official documentation on 2026-10-14:

- Select **Current Weather API `/data/2.5/weather`**, using `units=metric`. Built-in city-name lookup remains available but is deprecated; use OpenWeather Direct Geocoding followed by latitude/longitude weather lookup. [Current Weather documentation](https://openweathermap.org/api/current), [Geocoding documentation](https://openweathermap.org/api/geocoding-api)
- Free access includes **60 calls/minute and 1,000,000 calls/month**. Limits apply across the account, including other keys and products. These are separate from One Call's daily allowance. [Pricing](https://openweathermap.org/price), [Account-limit documentation](https://openweathermap.org/appid)
- The detailed pricing table lists **two-hour weather updates for Free**. General guidance mentions model updates no faster than ten minutes; that is not a Free-plan freshness guarantee. [Detailed pricing](https://samples.openweathermap.org/full-price), [API guidance](https://openweathermap.org/appid)
- The updated fresh cache TTL is **15 minutes = 900 seconds**. After expiry, attempt a provider refresh. A separate backup may be served on provider failures/timeouts or local/provider quota exhaustion, retaining the original observation timestamp. Implementation decision: retain backups for 24 hours from the last successful fetch, without renewing retention on fallback. TTL does not synchronize with provider updates or bound observation age. Never serve an expired backup.

## Ordered implementation plan

### 1. Establish the minimal architecture

Separate routes/authentication, weather orchestration, provider client, cache/quota handling, and history repository. Expose exactly three routes. Exclude bulk models, imports, queues, workers, and remote delivery.

### 2. Configure Docker Compose and startup

Provide `api`, `postgres`, `redis`, and a one-shot `migrate` service. PostgreSQL and Redis health checks gate migrations/startup; run `prisma migrate deploy`, then start the API only after successful migration.

Use a multi-stage build, non-root runtime, no hot reload, persistent PostgreSQL storage, and Redis AOF storage for quota continuity. Publish only the API port, bound locally. Add a separate Docker test profile with isolated PostgreSQL/Redis.

### 3. Define and validate configuration

Configuration names:

- `NODE_ENV`
- `PORT`
- `API_KEY`
- `OPENWEATHER_API_KEY`
- `DATABASE_URL`
- `REDIS_URL`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `WEATHER_CACHE_TTL_SECONDS`
- `PROVIDER_TIMEOUT_MS`
- `PROVIDER_MAX_RETRIES`
- `PROVIDER_CALLS_PER_MINUTE`
- `PROVIDER_CALLS_PER_MONTH`

Defaults: port `3000`, fresh TTL `900` (Compose pins this value even if private env files retain the old setting), timeout `5000`, two retries, and conservative application budgets of `55/minute` and `900000/month`.

Require credentials at startup. Ignore `.env` in Git and Docker build context; supply placeholder-only `.env.example`. Application runtime consumes injected configuration; tooling and logs must never expose secrets, authentication headers, or provider URLs containing `appid`. Never read or print `.env` or secret values during repository work.

### 4. Create the Prisma schema and migration

Only `SearchHistory`:

- Generated UUID `id`.
- `city_name`.
- Required `source` enum: `cache` or `provider`, identifying whether the weather response came from Redis or a successful OpenWeather fetch.
- Database-default UTC `timestamp`, using PostgreSQL `timestamptz(3)`.

Add a composite descending index on `(timestamp, id)` for deterministic keyset pagination. Repeats remain separate records. Retain records until deletion.

### 5. Implement authentication and API contracts

| Endpoint | Explicit behavior |
|---|---|
| All three | Require `X-API-Key` matching `API_KEY`; missing/invalid credentials return `401`. Authenticate before accessing dependencies. |
| `GET /weather?city=` | Accept one trimmed city string, 1–100 characters, without control characters. Support `city`, `city,CC`, and `city,STATE,US`; reject malformed/repeated parameters with `400`. Geocode with `limit=1`; use the first provider match and document country/state qualification for ambiguity. No match returns `404`. |
| `GET /history?limit=&cursor=` | `limit` is an integer from 1–100, default 20. Return `{ items: [{ id, city_name, timestamp, source }], next_cursor }`, ordered by timestamp then ID descending. `source` is `cache` or `provider`. Use a versioned base64url timestamp/ID cursor, validate it strictly, and return `400` for malformed input. Return `null` when there is no next page. |
| `DELETE /history` | Delete all shared history atomically; return `204` even when empty. Preserve cache and quota counters. Searches committed after deletion may appear subsequently. |

Recommended minimal weather response:

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

This is an illustrative response, not live weather. Map fields to `name`, `sys.country`, `main.temp`, `weather[0].description`, `main.humidity`, and `dt`; convert `dt` to UTC ISO 8601. Validate provider payloads before use. [Documented weather fields](https://openweathermap.org/api/current)

Use `{ "detail": "...", "code": "..." }` for errors. Persist one history record before every successful weather response, including cache hits and repeats, using the resolved weather city name. Set `source=cache` when serving Redis weather and `source=provider` when serving newly fetched OpenWeather weather. A geocoding cache hit alone does not make the weather source `cache`; requests sharing a newly fetched provider result use `provider`.

### 6. Implement cache, quota enforcement, and provider resilience

Cache successful normalized responses by trimmed, case-insensitive city query. Do not extend TTL on hits. After 900 seconds, refresh; only on eligible provider/quota errors serve a valid separate backup, retained for 24 hours from the successful fetch. Use versioned keys to ignore legacy 122-minute entries on rollout. Cache successful geocoding separately for 30 days. Coalesce simultaneous identical misses within the single API instance.

Before **every outbound attempt**, including geocoding and retries, atomically reserve quota in Redis: a rolling 60-second limit and a conservative rolling 31-day call budget. Count attempted calls without refunds; cache hits consume none. Local counters cannot account for unrelated account usage, so document exclusive account use or reduced budgets.

Return `429 LOCAL_QUOTA_EXCEEDED` when locally blocked. Map provider `429` to `429 PROVIDER_QUOTA_EXCEEDED`, without guessing which allowance was exhausted. Honor `Retry-After`; otherwise apply a ten-minute shared cooldown and return that retry interval. Valid cache hits remain usable. OpenWeather recommends waiting ten minutes after limit errors. [Provider guidance](https://openweathermap.org/appid)

Use a five-second timeout per attempt. Retry only network failures, timeouts, and transient `500/502/503/504`, at most twice per provider operation, with exponential backoff and jitter. Never retry provider authentication failures, not-found responses, quota errors, or invalid payloads.

Return `504 PROVIDER_TIMEOUT`, `502 PROVIDER_FAILURE`, or `502 PROVIDER_AUTH_ERROR` as appropriate. Distinguish these provider failures from quota exhaustion.

**Redis outage decision:** return `503` for weather because quota enforcement cannot operate safely. PostgreSQL failure also returns `503`; do not report weather success without history persistence. Stale fallback applies only to provider failures/timeouts and local/provider quota errors; it does not hide Redis/PostgreSQL outages, provider authentication failures, or not-found responses. Successful stale responses must persist history as `source=cache`.

### 7. Add Docker-executed tests

Jest/Supertest with mocked dependencies covers:

- Authentication and input validation.
- Response mapping and geocoding.
- Cache hits, misses, and expiry.
- History recording, including repeats and cache hits, with correct `cache`/`provider` source values in storage and history responses.
- Cursor ties and pagination boundaries.
- Deletion, including empty history.
- Retry limits and quota reservation per attempt.
- Provider error distinctions and dependency outages.

A small real PostgreSQL/Redis suite verifies migrations, pagination, deletion, cache expiry, and concurrent quota reservations. Automated tests make no live OpenWeather calls. Run tests in Docker.

### 8. Document and verify local delivery

Deliver README, lockfile, migrations, Docker files, placeholder configuration, `.gitignore`, and redacted `prompts/` notes.

Document architecture/trade-offs, provider attribution, scope exclusions, startup/migrations, API examples, errors, quota assumptions, TTL versus update frequency, and test commands.

Acceptance checks:

- Clean Compose startup succeeds, including migrations.
- Strict TypeScript build and Docker tests pass.
- All three routes require authentication.
- Repeated and cache-hit searches create history records with the correct source.
- Pagination and deletion work correctly.
- Expired fresh entries trigger refresh; valid retained backups are used only on eligible failures, without extending TTL. Expired backups are never served.
- Quota limits include retries and geocoding attempts.
- PostgreSQL data survives restart.
- Secrets remain absent from tracked artifacts and logs.
