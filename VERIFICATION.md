# Submission review — 2026-10-18

Rebuilt the current source using the Docker test target: strict TypeScript compilation passed, all three migrations applied to a fresh isolated PostgreSQL database, and **150 tests passed across 8 suites** (exit 0, 25.475 seconds). The suite uses real PostgreSQL/Redis with mocked provider transport; this does not verify a cloud deployment or live OpenWeather behavior. The large resource test was not repeated; its earlier measurements below remain historical.

Restored the stopped local PostgreSQL/Redis containers, resolving the API/worker dependency restart loop. Git history and origin now exist; earlier no-Git statements below describe the earlier session. See SUBMISSION.md for remaining external delivery requirements.

Host test attempts could not run because dependencies were not installed locally; Docker supplied the locked dependencies and completed the checks above.

# Local bulk implementation verification — 2026-10-15

Current application: **http://localhost:3000**, authenticated with the existing injected local API key. API, worker, PostgreSQL and Redis are running. No private environment values were printed or changed. No repository initialization, cloud operation, invitation, push or email was performed.

| Check actually executed | Result |
|---|---|
| Locked dependency installation / Prisma client generation | Passed (`npm ci`, `npm run generate`) |
| Strict TypeScript build | Passed on host and in Docker |
| Host unit tests, final run | **103 passed**, 6 suites |
| Full isolated Docker suite | **148 passed**, 8 suites, exit 0 |
| Standalone `test:recovery` command | **36 passed**, exit 0; command deploys migrations itself |
| `test:large`, final API-isolated run | 100,000 rows accepted; 100,001 rejected with 413; zero provider attempts; maximum batch 500 |
| Large admission resource measurement | Baseline API RSS **134.9 MiB**, peak **243.3 MiB**; both requests took **18.12 seconds** in this Docker Desktop environment |
| Exact file-byte boundary | 10,485,760-byte CSV accepted; one extra byte rejected, multipart overhead excluded |
| Additive migrations | All three migrations applied to isolated DB; bulk and result-link index migrations applied to existing local DB without reset |
| Local runtime build/startup | API and worker use the same non-root runtime source; localhost-only API binding; migration exit 0 |
| Existing API live smoke | Unauthorized history 401; authenticated history/weather 200; repeated weather cache hit, pagination/history recording passed |
| Bulk live smoke | Two separate 202 uploads completed; status/results 200; each total 3, succeeded 1, permanent failures 2, pending 0 |
| Existing history preservation | 4 rows before migration; still 4 after bulk-only smoke; 6 after the deliberate two-request HTTP weather smoke |
| Worker + Redis restart | Both smoke job summaries survived; one live worker, zero queue/pending/outbox/expired-lease/cleanup backlog; continuity hold null |
| Local geo rebuild | Rebuilt 2 verified aliases without touching quota or weather namespaces |
| Production dependency audit | Zero reported vulnerabilities (`npm audit --omit=dev` and runtime prune) |

The live successes were Portland,OR,US. London,GB and Tokyo,JP produced `CITY_AMBIGUOUS` because the provider returned multiple acceptable weather locations (including City of London and Tokyo-area locations). This is the intentional strict bulk policy, not a transport/job failure. HTTP retains first-match behavior. Sample files promise valid CSV structure, not deterministic provider uniqueness.

The final large test measures the API in a separate child process with a 128 MiB V8 old-space budget, matching Compose. Its streamed upload client runs outside the measured process. It creates real PostgreSQL entries/outcomes and an acknowledged BullMQ bootstrap, without a running bulk processor or provider transport. The 100,001-row request stages bounded batches then rejects/cleans up; the accepted job is removed from the disposable test DB afterward. These are machine-specific measurements, not universal latency/RSS guarantees. An earlier combined API/client measurement exceeded 256 MiB. Removing redundant raw CSV copies, using a 16 KiB CSV read buffer, and isolating the API measurement produced passing API peaks of 249.4 and then 243.3 MiB.

The large run also exposed slow deletion from an unindexed referencing FK. `20261015010000_result_links` adds the BulkEntry.result_id index; cleanup then completed normally. The initial long test-only delete was cancelled and its disposable runner stopped before rerunning. Application data was not cleared.

Coverage includes admission atomicity/enqueue ambiguity/activation failure, partial rejections, fatal UTF-8/late quoting, extra parts/charset/slow-upload timeout, structural limits, canonical upsert races and merge counters, stable cross-merge pagination, immutable snapshots, legacy-compatible fresh cache lifetimes, HTTP/bulk cache sharing, due verification/index rebuild/version races, coordinate drift/conflict review, strict ambiguity/qualification, typed invalid payload deferral, quota capacity/concurrency/exact Lua minute/month boundaries, auth-revision recovery, expired leases, missing queue reconstruction, Redis disconnection, database staging/commit interruptions, terminal retention and failed-job unfinished work.

Crash tests fork a real BullMQ worker with fake provider transport, wait at explicit barriers **before cache write**, **after cache write**, and **after final DB commit**, then issue SIGKILL. Recovery verifies fencing and one final outcome; cache-written work resumes without a new provider request. Tests accelerate expired database leases after the kill rather than waiting 90 wall-clock seconds. Controlled quota time exists only in a test adapter around the same Lua text; production always uses Redis TIME. Automated tests never use live OpenWeather or the application DB/Redis. The separately identified runtime smoke checks do use the configured live provider.

Practical limits: this is local single-machine verification, not a multi-host load/chaos certification. Marker loss tests cover the quota recovery hold; no real application AOF files were destroyed. Monthly time is simulated, not observed over 31 days. Infrastructure disconnections/commit failures and process kills cover selected crash boundaries, not every power-failure interleaving. The development dependency tree still reports 20 moderate advisories; production dependencies report zero. Task.md cloud delivery, Git history/collaborator/submission actions and complete historical transcript exports remain outside this local run; see HANDOFF.md and prompts/manifest.md.

## Historical verification record (before bulk implementation)

# Verification — 2026-10-14

The application is running locally at `http://localhost:3000`, with PostgreSQL and Redis healthy. The earlier disk/Docker blocker is resolved.

## Cache policy update

Implemented the user-approved 15-minute fresh cache with a separate backup retained for 24 hours from the last successful fetch. Provider failures/timeouts and local/provider quota exhaustion can use that backup. Stale success records cache history and preserves the observation timestamp; reads never renew either TTL. Authentication/not-found errors and dependency outages keep their existing behavior. The 24-hour retention limit is an implementation decision for the unspecified maximum stale age. Compose pins the fresh TTL to 900 seconds without inspecting or modifying private environment files.

New coverage verifies provider/quota/cooldown fallback, missing/corrupt/expired backups, no retention extension, recovery after provider restoration, history persistence, and concurrent coalescing. Runtime checks confirmed a 900-second configured TTL, 899 seconds remaining on the fresh entry and 86399 seconds on its backup immediately after a live fetch.

## Checks actually run

| Check | Result |
|---|---|
| Clean locked npm installation | Passed |
| Prisma client generation | Passed, Prisma 6.19.3 |
| Strict TypeScript build | Passed on host and in Docker |
| Host Jest unit tests | Passed: 5 suites, 84 tests |
| Docker Jest unit/integration tests | Passed: 6 suites, 93 tests, exit code 0 |
| Production Docker builds | Passed for API and migration images; Node.js 24 runtime |
| Isolated test database migrations | Successfully applied committed migration |
| Production migrations | Successfully deployed, exit code 0; also rerun idempotently during restart verification |
| Both Compose configurations | Validated |
| Production startup | Passed; API bound to 127.0.0.1:3000; only API port published |
| Host HTTP access | /history without credentials returns 401 |
| Live authenticated weather | OpenWeather request returned 200 |
| Repeated weather/cache hit | Returned 200; history records the cache source |
| Authenticated history/pagination | Passed live smoke check |
| Deletion, cursor ties, fresh/backup expiry, stale fallback/recovery, concurrent quota, rolling windows, cooldown, outages | Passed in real PostgreSQL/Redis integration suite with mocked provider transport |
| PostgreSQL/Redis restart persistence | Prior 2026-10-14 check: history count remained 2 and rolling monthly attempted-call count remained 2 after restarting both containers |
| Production dependency audit | Zero reported vulnerabilities |
| Full dependency audit | 20 moderate development-only findings in Jest's sprintf-js dependency chain remain |

The updated Docker test suite and production rebuild/migrations completed successfully on 2026-10-15. Automated tests never call live OpenWeather. A separate runtime smoke check made one live geocoding and weather fetch, then verified a repeated cache hit. It preserved production history. The isolated Docker test stack was stopped and removed after testing; the production server remains running.

## Runtime configuration and startup

The existing `.env` was preserved without reading or printing it. `node scripts/setup-local.cjs` generated a separate ignored `.env.runtime` containing a random application API key, matching random PostgreSQL credentials, and the approved local defaults. OpenWeather credentials come from the existing `.env` through Compose's runtime loading. No credential values were printed.

Use the same two environment files for subsequent commands:

```sh
docker compose --env-file .env --env-file .env.runtime up --build -d
docker compose --env-file .env --env-file .env.runtime ps
docker compose --env-file .env --env-file .env.runtime down
```

Keep `.env.runtime` with the persistent database volume. `down` preserves volumes; do not use `-v` unless deleting data is intended. Clients authenticate with the `API_KEY` in `.env.runtime` using `X-API-Key`.

## Recovery and dependency notes

Earlier host verification used an explicit D: copy when C: had no free space. After disk space was cleared, Docker became available. Registry layer downloads initially failed with EOF/connection resets. Official Docker image manifests and blobs were downloaded through the host, each blob's SHA-256 digest was verified, and the images were loaded locally. Docker's official ECR mirror was also used for download recovery. Recovery helpers and downloads are confined to the D: verification directory; no remote deployment or image push occurred.

Prisma remains on 6.x. The deepmerge-ts 8.0.2 override removes the reported stack-exhaustion advisory; Prisma generation, schema validation, and actual migration deployment all succeeded with it.

No `.env` contents or secret values were read or printed. Runtime processes consume injected credentials without displaying them. `.env` patterns are ignored by Git and Docker. No remote deployment, push, or email was performed. No functional startup blocker remains.
