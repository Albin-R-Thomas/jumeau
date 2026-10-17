# Node.js Data & Backend Engineer (SDE-1) — Take-Home Task

## Objective

* Build a **Node.js (TypeScript) + Express/Fastify** backend that integrates with a simple third-party API, exposes RESTful endpoints, and supports **background processing** for larger data using **BullMQ** and **Redis**.
* You will also write unit tests, deploy the app, and document the project.

## How we want you to work (read this first)

The problem is **intentionally ambiguous and underspecified**. We grade your process and communication as much as your code.

- **Ask, don't assume.** Questions are never penalized; silent assumptions are. If we are slow to reply, note your assumption, proceed, and flag it.
- **Plan first.** Within your first few hours, send us your understanding, open questions, assumptions, scope cuts and a proposed design before writing significant code.
- **Be deliberate.** For each key design choice, write down what you chose, why, and what you traded off.
- **Update daily.** Send a short update (done, next, blocked) at least once a day and push small commits. No silent days, no final code dump.

Contact: `tech@jumeaucapital.com`

## Expected Deliverables and Evaluation Criteria

* Have a working prototype of the task described below. We value a complete vertical slice over polishing one part only.
* We will assess how you scope the problem, divide it into components, and execute within a few days.
* Attention to detail matters—clear code, small helpful comments, and sound defaults.
* Show how you get unstuck (graceful fallbacks, good errors, small notes in README).
* Communicate progress (commit history, short README notes on decisions).

## Task Description

You will build a small application called **CityWeather+** that:

1. Fetches **current weather** for a given city (via a third-party API like OpenWeather).
2. Stores a **search history**.
3. Supports **bulk city imports** from a CSV (simulating “larger data”) and runs **background jobs** to fetch and cache weather for those cities using **BullMQ + Redis**.
4. Exposes **REST APIs** to query weather, history, and the status/results of background jobs.

> Keep it simple: one third-party API, a few endpoints, Redis caching, and queue workers. Aim for clarity over cleverness.

### Requirements

#### Authentication (simple)

* Public endpoints are fine for demo. If you prefer, protect admin/job endpoints with a single **API key** header (document the header name and where to set it).

#### API Integration

* Use **OpenWeather** (or similar).
* Create a route: given `city`, fetch **current weather** and return basic fields (temperature, condition, humidity).
* Use request timeouts and retries.

#### Caching with Redis

* Cache per-city weather responses (e.g., **15 minutes**), using `ioredis` or `redis`.

#### Background Processing with BullMQ

* A CLI script or endpoint to **enqueue** a bulk job:
  * Input: CSV of city names (could be 10k+ to simulate “larger data”).
  * Each city fetch is done in worker jobs (batched or per-city—your choice).
  * Store per-city results and a **job summary** (counts: total, succeeded, failed).
  * Provide an endpoint to **check job status** and a simple aggregate view (top N cities most recently refreshed, failures, etc.).

#### Larger Data Handling (simple & visible)

* The bulk import pipeline should:
  * Stream/process the CSV without loading it fully in memory (Node streams).
  * Use **idempotency** on city records (don’t duplicate).
  * Show you considered scale: small indexes, simple pagination, and basic retry/backoff for API errors.

## REST API

* `GET /weather?city={city}`
  Fetch current weather (uses Redis cache; on miss, hits API; on hit, returns cached).

* `GET /history?limit=&cursor=`
  Returns recent searches (city, timestamp). Use simple pagination.

* `DELETE /history`
  Clears all search history.

* `POST /bulk/import`
  Accepts a CSV file of city names (`multipart/form-data` or pre-uploaded path).
  Enqueues a **BullMQ job** to fetch+cache weather for all rows. Returns `{ "job_id": "..." }`.

* `GET /bulk/jobs/{job_id}`
  Returns job status and summary (total rows, processed, succeeded, failed, started_at, finished_at).

* `GET /bulk/jobs/{job_id}/results?limit=&cursor=`
  Paginated list of per-city results (city, status, last_refreshed_at, last_error).

> Use appropriate status codes and clear JSON error bodies (`{ "detail": "...", "code": "..." }`).

## Database

Use Postgres (or SQLite for demo) with an ORM/query builder of your choice (Prisma, Drizzle, Knex, TypeORM). Create minimal models:

1. **SearchHistory**: `city_name`, `timestamp` (default now)
2. **City** (for idempotent bulk work): `name` (unique), `last_refreshed_at` (nullable), `last_status` (`"success" | "failed" | "pending"`), `last_error` (nullable)
3. **BulkJob**: `job_id` (UUID PK), `total`, `processed`, `succeeded`, `failed`, `created_at`, `started_at`, `finished_at`, `status` (`"queued" | "running" | "done" | "failed"`)

**Indexes (suggested)**: `SearchHistory(timestamp)`, `City(name)` unique, `City(last_refreshed_at)`.

## Deployment

* Deploy on any cloud (Render/Heroku/Fly.io/AWS).
* Include a link to the deployed app in the README.
* Provide a demo **API key** in the README if you use API-key auth for job endpoints.

## Unit Tests

* Tests for:
  * `GET /weather` happy path, cache hit, cache miss, and error handling.
  * `POST /bulk/import` enqueues a job (mock the queue).
  * `GET /bulk/jobs/{job_id}` returns correct counters.
  * Simple DB tests for idempotent insert/upsert of `City`.
* Use `jest` or `vitest` (plus `supertest` for API tests). A small coverage target on API and core logic is sufficient.

## Documentation

Include a `README.md` that provides:

1. **Approach** (top section): your overall plan, tools chosen, and trade-offs.
2. **Local setup** (Node version, env variables, DB/Redis, migrations).
3. **Running** (API server, worker, Redis).
4. **How to run bulk import** (sample CSV & commands).
5. **How to run tests**.
6. **API docs** (endpoints with example requests/responses).
7. **Link to deployed app**.

## Evaluation Criteria

* **API Integration:** Correctly uses third-party API with timeouts/retries.
* **Code Quality:** Clear structure, small functions, strict TypeScript types.
* **Data Management:** Simple, correct models and indexes; idempotency for cities.
* **Redis & Queue:** Cache works; background job runs; status is observable.
* **Larger Data Handling:** Streams CSV, doesn’t duplicate cities, shows simple retry/backoff.
* **Testing:** Core endpoints and logic are covered.
* **Deployment:** App runs in cloud; short notes on env/config.
* **Docs:** Setup + usage are easy to follow.

## Expected Time

* **Max 1 week**; achievable in **2–3 focused days**.
* If you need more time, email `tech@jumeaucapital.com`.

## Instructions to Submit Your Work

* Do **not** fork this repo. Use a private repo; add collaborator `tech@jumeaucapital.com`.
* Push frequently with meaningful commits.
* Use **Node 20+** and **TypeScript**; commit a lockfile.
* Suggested structure: `./src/`, `./data/` (sample CSVs, rejected rows), `./tests/`.
* Include a `.gitignore`.
* Keep updating the README with any clarifications.
* Communication: email `tech@jumeaucapital.com` subject **"Node Data and Backend Engineer Exercise evaluation: [your full name]"** and share progress updates.
* Questions: email `tech@jumeaucapital.com` subject **"Query on Node Data and Backend Engineer Exercise"**.
* Focus on getting a working vertical slice first.

### Submit your AI prompts

We want to see **how you worked with AI tools**, not just the final code. Commit your prompts and chat logs to your repo in a top-level `prompts/` folder.

1. **Create `prompts/`** in the repo root. Put one file per session or tool, named by date/tool, e.g. `prompts/2026-01-15-claude-code.jsonl`.
2. **Export your chats** using the steps for your tool:
   - **Claude Code (automatic if you work inside a clone of this repo)**: hooks in `.claude/settings.json` copy every session into `prompts/claude-code/` (secrets redacted) as you work. Run `/sync-prompts` at the end to catch anything missed. If you work in a different repo, copy this repo's `.claude/` and `scripts/` folders into it. Manual fallback: your transcripts are saved on your machine (not in the repo), under `~/.claude/projects/<your-project-path>/*.jsonl`. Copy those files into `prompts/`. Committing the project's `.claude/` folder is *not* enough, as it holds settings, not your conversations. Alternatively, run `/export` inside a session and save the output to `prompts/`.
   - **Cursor**: open the chat panel, use the chat's `...` menu → **Export Chat** (saves Markdown), and save it into `prompts/`. Cursor has no built-in bulk export; export each important chat.
   - **VS Code (Copilot Chat)**: run **Chat: Export Chat...** from the Command Palette and save the JSON into `prompts/`.
   - **Any other tool (ChatGPT, Gemini, etc.)**: use its export/share feature, or copy-paste the conversation into a `.md` file in `prompts/`.
3. **Remove secrets** before committing: search the files for API keys, tokens and passwords, and redact them.
4. **Commit and push** `prompts/` along with your code, then mention it in your README. Include **all** sessions, including dead ends and ones you abandoned. We evaluate how you prompt, iterate and recover, not how polished the prompts look.
5. If you wrote prompts by hand that no tool logged, add them to `prompts/notes.md`.

---

**All the best!**