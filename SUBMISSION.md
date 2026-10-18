# Task.md submission audit — 2026-10-18

The implementation covers the requested backend. External submission requirements remain open; this is not yet a claim of full assignment completion.

| Requirement | Evidence / status |
| --- | --- |
| Node 20+, strict TypeScript, Express, lockfile | Node 24; package.json, tsconfig.json, package-lock.json |
| Current weather, timeout/retry, Redis caching | src/provider.ts, src/weather.ts, src/store.ts; 900-second fresh cache |
| History retrieval, cursor pagination, deletion | src/app.ts, src/history.ts; indexed Prisma SearchHistory |
| Streamed CSV import, BullMQ, worker, Redis | src/bulk; bounded DB batches; sample files in data/ |
| Status, counters, per-city results, aggregate view | src/bulk/routes.ts, repository.ts; paginated results and top successes/failures |
| Idempotent cities | Canonical provider identity and normalized aliases have unique constraints; concurrent identity/merge integration tests. City names themselves are deliberately not unique so distinct same-name places can coexist; see README identity tradeoffs. |
| ORM, migrations, indexes | Prisma schema and three committed migrations |
| Required endpoint and DB tests | Jest/Supertest unit and real PostgreSQL/Redis integration suites; see VERIFICATION.md for executed results |
| Setup, commands, auth and API examples | README.md, sample-curl.md, .env.example; X-API-Key |
| Cloud deployment | Render configuration and supervisor supplied; public URL and live cloud smoke still unverified |
| Private repository and reviewer access | Origin exists at https://github.com/Albin-R-Thomas/jumeau; privacy/access not verified in this environment |
| AI prompts and full conversations | prompts/ contains session notes; complete historical exports remain missing, disclosed in prompts/manifest.md |
| Planning / daily communication | Design notes and meaningful Git commits exist; earlier emails and daily updates are not independently verified |

Before sending: supply the real deployed URL, verify the cloud's six authenticated routes, give the reviewer repository access and a demo API key, attach the missing redacted AI exports, and push final changes. Keep the OpenWeather key private. The email below is a draft; replace the placeholders and confirm your full name.

To: tech@jumeaucapital.com

Subject: Node Data and Backend Engineer Exercise evaluation: [your full name]

Hello Team,

Please find my CityWeather+ submission below:

Repository: https://github.com/Albin-R-Thomas/jumeau
Live API: [deployed URL]
Demo X-API-Key: [reviewer demo key]

The README includes setup instructions, API examples, and testing details. Verification results and AI session records, including disclosed transcript gaps, are included in the repository.

Thank you for your time.

Regards,
[your full name]
