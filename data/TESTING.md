# Test every endpoint

Use `api-test-cities.csv` from this directory. It is UTF-8 without a header and deliberately mixes ordinary cities, a normalized duplicate, Unicode names, worker validation failures, two structural row rejections and two blank records. It should be accepted as one bulk job when dependencies are available. Live provider matches and ambiguity vary; a well-formed city is not a guaranteed successful bulk result.

The CSV is uploaded only to `POST /bulk/import`. Use city values from it for `/weather`; use the returned job UUID for bulk status/results. Bulk processing does not create search history, so make HTTP weather requests before testing history.

Run these commands in PowerShell from `C:\Code\jumeau`. Set `$env:API_KEY` to your existing application key locally (the value used by the API container, typically in `.env.runtime`). Do not use the OpenWeather provider key as the application key.

```powershell
$base = 'http://localhost:3000'
$headers = @{ 'X-API-Key' = $env:API_KEY }
```

## 1. Weather and cache

```powershell
$city = [uri]::EscapeDataString('Portland,OR,US')
Invoke-RestMethod "$base/weather?city=$city" -Headers $headers
Invoke-RestMethod "$base/weather?city=$city" -Headers $headers
$otherCity = [uri]::EscapeDataString('London,GB')
Invoke-RestMethod "$base/weather?city=$otherCity" -Headers $headers
```

Expect 200 with city, country, temperature, condition, humidity and observation time when the provider/configuration/quota permits. The repeated request should use fresh cache. The response has no cache-source field; inspect the corresponding history rows for `source=cache`. A first request can already be cached from earlier testing. Each successful weather HTTP request records history.

## 2. History and its next page

```powershell
$history = Invoke-RestMethod "$base/history?limit=1" -Headers $headers
$history | ConvertTo-Json -Depth 10
if ($history.next_cursor) {
    $cursor = [uri]::EscapeDataString($history.next_cursor)
    Invoke-RestMethod "$base/history?limit=1&cursor=$cursor" -Headers $headers
}
```

Expect recent searches, their source/timestamp, and a cursor when another page exists.

## 3. Import the CSV

```powershell
$uploadJson = curl.exe --silent --show-error `
    -H "X-API-Key: $env:API_KEY" `
    -F 'file=@data/api-test-cities.csv;type=text/csv' `
    "$base/bulk/import"
$upload = $uploadJson | ConvertFrom-Json
if (-not $upload.job_id) { throw "Upload failed: $uploadJson" }
$jobId = $upload.job_id
$jobId
```

Expect HTTP 202 and `{"job_id":"..."}`. To inspect HTTP headers separately, repeat using `curl.exe -i`; every upload creates a new independent job. Do not include `-i` when parsing the response as JSON above.

These admission counts are deterministic, even if workers start immediately:

| Field | Expected |
|---|---:|
| `input_rows` | 13 |
| `blank_rows` | 2 |
| `admitted_entries` | 10 |
| `admission_duplicate_rows` | 1 |
| `rejected_rows` | 2 |

`total` initially represents 10 provisional outcomes and may decrease if separately admitted aliases are proven to identify the same place. No provider call is needed to admit the file.

## 4. Job status

```powershell
Invoke-RestMethod "$base/bulk/jobs/$jobId" -Headers $headers |
    ConvertTo-Json -Depth 10
```

Repeat to observe processing. `done` can include permanent city failures. `pending` means work is waiting for quota, a retry time or a repair condition. Check `blocking_reasons`, `resume_at`, and `recovery_conditions`. The worker must be running for processing to progress.

## 5. Results, pagination and row diagnostics

```powershell
$results = Invoke-RestMethod "$base/bulk/jobs/$jobId/results?limit=2" -Headers $headers
$results | ConvertTo-Json -Depth 15
if ($results.next_cursor) {
    $cursor = [uri]::EscapeDataString($results.next_cursor)
    Invoke-RestMethod "$base/bulk/jobs/$jobId/results?limit=2&cursor=$cursor" -Headers $headers |
        ConvertTo-Json -Depth 15
}

$rejections = Invoke-RestMethod "$base/bulk/jobs/$jobId/results?view=rejections&limit=1" -Headers $headers
$rejections | ConvertTo-Json -Depth 10
if ($rejections.next_cursor) {
    $cursor = [uri]::EscapeDataString($rejections.next_cursor)
    Invoke-RestMethod "$base/bulk/jobs/$jobId/results?view=rejections&limit=1&cursor=$cursor" -Headers $headers |
        ConvertTo-Json -Depth 10
}
```

Entries keep immutable membership; outcomes contain current processing state and successful weather or errors. Entry and rejection cursors are separate and bound to this job.

| CSV input | Intended case |
|---|---|
| `Portland,OR,US` and its spaced uppercase duplicate | One admission entry with `occurrences=2` |
| Paris, London, Tokyo | Ordinary qualified inputs; bulk can report provider ambiguity |
| Springfield | Possible ambiguous place |
| `NoSuchCityForTesting12345,US` | Intended not-found lookup; actual provider response determines the outcome |
| `London,XYZ` | Admitted, then permanent worker `INVALID_CITY_SYNTAX` |
| `Portland,XX,US` | Admitted, then permanent worker `INVALID_CITY_SYNTAX` |
| Unquoted `London,GB`, record 10 | Rejected row: `INVALID_COLUMN_COUNT` |
| 201-character value, record 11 | Rejected row: `CITY_VALUE_TOO_LONG` |
| Blank line and quoted empty value | Ignored, `blank_rows=2` |
| São Paulo and München | UTF-8 city names |

## 6. Delete history last

This endpoint deletes **all shared search history**, including searches made before this test. Run it when that is the intended test action:

```powershell
curl.exe -i -X DELETE -H "X-API-Key: $env:API_KEY" "$base/history"
Invoke-RestMethod "$base/history" -Headers $headers
```

Expect 204, then an empty history page if no concurrent weather request adds a new search. Bulk jobs, weather cache and quotas remain present.

## Additional error cases

```powershell
# Authentication: 401
curl.exe -i "$base/history"

# Missing city / invalid page size / malformed job UUID: 400
curl.exe -i -H "X-API-Key: $env:API_KEY" "$base/weather"
curl.exe -i -H "X-API-Key: $env:API_KEY" "$base/history?limit=0"
curl.exe -i -H "X-API-Key: $env:API_KEY" "$base/bulk/jobs/not-a-uuid"

# Fatal CSV quoting error: 400; no accepted job
curl.exe -i -H "X-API-Key: $env:API_KEY" `
    -F 'file=@data/cities-malformed.csv;type=text/csv' "$base/bulk/import"
```

This small fixture covers manual endpoint flows and representative input failures. The automated suite covers size ceilings, dependency outages, quota exhaustion and worker crashes; a CSV alone cannot trigger those conditions reliably.
