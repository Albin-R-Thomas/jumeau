# CityWeather+ sample curl commands

Run from **PowerShell** in `C:\Code\jumeau`. Use `curl.exe` so Windows PowerShell does not substitute its `curl` alias. The API listens at `http://localhost:3000` by default. Every endpoint requires the application's `X-API-Key`, except the deliberately unauthorized test below.

Only `POST /bulk/import` accepts a CSV. Weather requests use a city query, and job requests use the UUID returned by an import. Bulk imports do not add search history.

## Start all services

```powershell
Set-Location C:\Code\jumeau
docker desktop start --detach
docker compose --env-file .env --env-file .env.runtime up --build -d
docker compose --env-file .env --env-file .env.runtime ps
```

Docker Desktop must finish starting before Compose can connect. The existing `.env` and `.env.runtime` provide local credentials. PostgreSQL/Redis health checks gate migrations; API and worker start after migrations succeed. The migration container exiting with code 0 is expected.

Load the running API's application key into this terminal without printing it. This does not put the key in the Markdown file:

```powershell
$base = 'http://localhost:3000'
$env:API_KEY = (docker compose --env-file .env --env-file .env.runtime exec -T api printenv API_KEY).Trim()
if (-not $env:API_KEY) { throw 'The API key could not be loaded. Check that the API container is running.' }
```

If you use another HTTP client, use the same local application key in `X-API-Key`. The OpenWeather provider key is a different credential. If you configured a different host `PORT`, update `$base` accordingly.

## 1. GET /weather

Fetch weather using a country/state-qualified city:

```powershell
curl.exe -i --get "$base/weather" -H "X-API-Key: $env:API_KEY" --data-urlencode 'city=Portland,OR,US'
```

Repeat to exercise a fresh cache hit:

```powershell
curl.exe -i --get "$base/weather" -H "X-API-Key: $env:API_KEY" --data-urlencode 'city=Portland,OR,US'
```

Fetch another city to add another history entry:

```powershell
curl.exe -i --get "$base/weather" -H "X-API-Key: $env:API_KEY" --data-urlencode 'city=London,GB'
```

Expected: 200 and weather fields (`city`, `country`, `temperature_celsius`, `condition`, `humidity_percent`, `observed_at`) when the provider/configuration/quota permits. A first request can already be cached. Every successful HTTP weather request adds a history row; the weather response itself does not include a cache-source field.

## 2. GET /history

Default page:

```powershell
curl.exe -i "$base/history" -H "X-API-Key: $env:API_KEY"
```

Get one row, capture its cursor, then request the next page:

```powershell
$historyJson = curl.exe --silent --show-error --get "$base/history" -H "X-API-Key: $env:API_KEY" --data-urlencode 'limit=1'
$history = $historyJson | ConvertFrom-Json
$history | ConvertTo-Json -Depth 10
if ($history.next_cursor) {
    curl.exe -i --get "$base/history" -H "X-API-Key: $env:API_KEY" --data-urlencode 'limit=1' --data-urlencode "cursor=$($history.next_cursor)"
}
```

Expected: 200, `items`, and `next_cursor` when more rows exist. After repeating a cached weather request, its history row should have `source=cache`. Limits are 1–100. Preserve returned cursors unchanged.

## 3. POST /bulk/import

Upload the sample and capture its job ID. Omit `-i` here so the response can be parsed as JSON:

```powershell
$uploadJson = curl.exe --silent --show-error -H "X-API-Key: $env:API_KEY" -F 'file=@data/api-test-cities.csv;type=text/csv' "$base/bulk/import"
$upload = $uploadJson | ConvertFrom-Json
if (-not $upload.job_id) { throw "Upload failed: $uploadJson" }
$jobId = $upload.job_id
$jobId
```

Expected: HTTP 202, `{"job_id":"UUID"}`, and a `Location` header pointing to `/bulk/jobs/UUID`. The sample deliberately includes duplicates, worker validation errors and structural row rejections, while keeping the whole upload admissible.

| Admission field | Expected |
|---|---:|
| `input_rows` | 13 |
| `blank_rows` | 2 |
| `admitted_entries` | 10 |
| `admission_duplicate_rows` | 1 |
| `rejected_rows` | 2 |

The original Portland spelling and its spaced uppercase duplicate share one entry with `occurrences=2`. Two records are structural rejections: an unquoted comma-qualified value and a 201-character value. `London,XYZ` and `Portland,XX,US` are admitted and later fail worker syntax validation. Live provider responses determine other city outcomes, including ambiguity/not-found. `total` starts provisional and can decrease after proven canonical alias merges.

To view HTTP headers on a separate upload:

```powershell
curl.exe -i -H "X-API-Key: $env:API_KEY" -F 'file=@data/cities-valid.csv;type=text/csv' "$base/bulk/import"
```

Every upload creates an independent job, including identical uploads. This last example does not replace `$jobId`; copy its returned ID into `$jobId` if you want to inspect that separate job. Let curl set the multipart Content-Type/boundary automatically.

## 4. GET /bulk/jobs/{job_id}

Use the job ID captured above:

```powershell
curl.exe -i "$base/bulk/jobs/$jobId" -H "X-API-Key: $env:API_KEY"
```

Optional bounded polling (up to about 40 seconds):

```powershell
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $statusJson = curl.exe --silent --show-error "$base/bulk/jobs/$jobId" -H "X-API-Key: $env:API_KEY"
    $status = $statusJson | ConvertFrom-Json
    $status | Select-Object job_id,status,total,processed,succeeded,failed,pending,in_flight,resume_at
    if ($status.status -in @('done','failed','pending')) {
        $status | ConvertTo-Json -Depth 10
        break
    }
    Start-Sleep -Seconds 2
}
```

Expected: 200 with counters and timestamps. `queued`/`running` progress toward `done`. A `done` job can contain permanent city failures. A `pending` job waits for quota, retry time or configuration/identity repair; inspect `blocking_reasons`, `resume_at`, and `recovery_conditions`. A stopped worker leaves membership readable but processing cannot progress.

## 5. GET /bulk/jobs/{job_id}/results

Default entry/outcome view:

```powershell
curl.exe -i "$base/bulk/jobs/$jobId/results" -H "X-API-Key: $env:API_KEY"
```

Fetch two entries and then the next page:

```powershell
$resultsJson = curl.exe --silent --show-error --get "$base/bulk/jobs/$jobId/results" -H "X-API-Key: $env:API_KEY" --data-urlencode 'limit=2'
$results = $resultsJson | ConvertFrom-Json
$results | ConvertTo-Json -Depth 15
if ($results.next_cursor) {
    curl.exe -i --get "$base/bulk/jobs/$jobId/results" -H "X-API-Key: $env:API_KEY" --data-urlencode 'limit=2' --data-urlencode "cursor=$($results.next_cursor)"
}
```

Expected: 200 with immutable `entries`, their referenced `outcomes`, and `next_cursor`. Successful outcomes include a weather snapshot. Failed outcomes include `last_error`; pending outcomes can include separately labelled `provisional_weather`. Multiple entries can reference one canonical outcome. Limits are 1–100.

### Rejected rows and their next page

The same endpoint exposes the sample's two structural rejections:

```powershell
$rejectedJson = curl.exe --silent --show-error --get "$base/bulk/jobs/$jobId/results" -H "X-API-Key: $env:API_KEY" --data-urlencode 'view=rejections' --data-urlencode 'limit=1'
$rejected = $rejectedJson | ConvertFrom-Json
$rejected | ConvertTo-Json -Depth 10
if ($rejected.next_cursor) {
    curl.exe -i --get "$base/bulk/jobs/$jobId/results" -H "X-API-Key: $env:API_KEY" --data-urlencode 'view=rejections' --data-urlencode 'limit=1' --data-urlencode "cursor=$($rejected.next_cursor)"
}
```

Expected codes: `INVALID_COLUMN_COUNT` at record 11 and `CITY_VALUE_TOO_LONG` at record 12. Row rejections do not increment the worker's failed-city count. Use each cursor only with its original job and view; history, entry and rejection cursors are distinct.

## 6. DELETE /history — run last if you want to clear history

This deletes **all shared search history**, including searches made before this session. It does not delete jobs, weather cache, or quota accounting. This command is provided for your manual testing; the startup smoke checks preserve existing history.

```powershell
curl.exe -i -X DELETE "$base/history" -H "X-API-Key: $env:API_KEY"
curl.exe -i "$base/history" -H "X-API-Key: $env:API_KEY"
```

Expected: 204, followed by an empty page if no concurrent weather request records a new search. Deleting an already empty history also returns 204.

## Error examples

### Missing authentication — 401

```powershell
curl.exe -i "$base/history"
```

### Missing city, repeated/unknown parameters, invalid page size — 400

```powershell
curl.exe -i "$base/weather" -H "X-API-Key: $env:API_KEY"
curl.exe -i "$base/weather?city=London&city=Paris" -H "X-API-Key: $env:API_KEY"
curl.exe -i "$base/weather?city=London&unexpected=1" -H "X-API-Key: $env:API_KEY"
curl.exe -i "$base/history?limit=0" -H "X-API-Key: $env:API_KEY"
curl.exe -i "$base/bulk/jobs/$jobId/results?limit=101" -H "X-API-Key: $env:API_KEY"
curl.exe -i "$base/bulk/jobs/$jobId/results?cursor=invalid" -H "X-API-Key: $env:API_KEY"
```

### Malformed job UUID — 400; unknown valid UUID — 404

```powershell
curl.exe -i "$base/bulk/jobs/not-a-uuid" -H "X-API-Key: $env:API_KEY"
curl.exe -i "$base/bulk/jobs/00000000-0000-4000-8000-000000000000" -H "X-API-Key: $env:API_KEY"
```

### Malformed CSV, wrong upload field, missing file — 400

```powershell
curl.exe -i -H "X-API-Key: $env:API_KEY" -F 'file=@data/cities-malformed.csv;type=text/csv' "$base/bulk/import"
curl.exe -i -H "X-API-Key: $env:API_KEY" -F 'wrong_field=@data/api-test-cities.csv;type=text/csv' "$base/bulk/import"
curl.exe -i -H "X-API-Key: $env:API_KEY" -F 'note=no-file-attached' "$base/bulk/import"
```

### Raw CSV instead of multipart, or unsupported file MIME — 415

```powershell
curl.exe -i -H "X-API-Key: $env:API_KEY" -H 'Content-Type: text/csv' --data-binary '@data/api-test-cities.csv' "$base/bulk/import"
curl.exe -i -H "X-API-Key: $env:API_KEY" -F 'file=@data/api-test-cities.csv;type=application/pdf' "$base/bulk/import"
```

### Optional large-file row-limit test — 413

This generates a local ignored file and stages a large rejected upload; it takes more resources than the small sample. It must not publish a ready job or dispatch provider work:

```powershell
node scripts/generate-fixture.cjs 100001 data/generated-too-many.csv
curl.exe -i -H "X-API-Key: $env:API_KEY" -F 'file=@data/generated-too-many.csv;type=text/csv' "$base/bulk/import"
```

Expected: `413 TOO_MANY_ROWS`. File size is independently capped at 10 MiB. A valid 100,000-row import can take days to refresh under the shared provider budget; avoid enqueuing it just to check HTTP reachability.

Other runtime errors include 429 quota/cooldown responses with `Retry-After`, 502 provider errors, 503 unavailable dependencies, and 504 provider timeouts. Those depend on runtime state; a fixed CSV cannot reliably trigger them. Error bodies use `{ "detail": "...", "code": "..." }` with additional bulk diagnostics where available.

## Worker and service diagnostics

```powershell
docker compose --env-file .env --env-file .env.runtime ps
docker compose --env-file .env --env-file .env.runtime exec -T worker node dist/src/ops.js status
docker compose --env-file .env --env-file .env.runtime logs --tail 50 api worker
```

There is no public health endpoint or root homepage. An unauthenticated request returns 401; an authenticated unknown route returns 404. Use history plus the local operations command to check API/database/worker/queue health.

For an ordinary shutdown that preserves the database and Redis ledger:

```powershell
docker compose --env-file .env --env-file .env.runtime down
```

The startup work leaves services running. The shutdown command above is for later use.

## Verified local run — 2026-10-16

Docker Desktop was started and the Compose stack rebuilt and started successfully. PostgreSQL and Redis are healthy, migrations completed, and API/worker are running. Live curl checks confirmed:

- Missing authentication: 401.
- Weather and its repeated cache hit: 200; the corresponding latest history row reports `source=cache`.
- History and its next page: 200.
- Mixed CSV upload: accepted with job ID `1a96645b-4a99-4bc9-be3f-87ed9c10a53b`.
- That job reached `done`: total 10, succeeded 1, failed 9, pending 0. Permanent city failures are expected test outcomes under strict provider ambiguity/syntax/not-found handling.
- Results pagination returned all 10 entries. Rejection pagination returned `INVALID_COLUMN_COUNT` and `CITY_VALUE_TOO_LONG`.
- Missing city, malformed job UUID and malformed CSV: 400; unknown valid job UUID: 404; unsupported MIME: 415.

Existing history was preserved. The DELETE example and the optional large-file test were not executed during this startup check. Use a newly returned `$jobId` when uploading again; the recorded job above remains available only for its retention period.
