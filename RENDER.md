# Deploy on Render

The root `render.yaml` creates four paid services in Singapore: the API, background worker, PostgreSQL 17 and persistent Render Key Value (Redis compatible). Review Render's cost summary before creating them. Render uses native Node.js; Docker Compose remains available locally.

## Manual steps

1. Create a private GitHub repository and upload this project. Include `render.yaml`, `package-lock.json`, `src`, `tests`, `prisma` (including migrations), `scripts` and `data`. This folder currently has no Git repository. To use Git locally:

   ```powershell
   git init
   git add .
   git status --short
   git commit -m "Prepare CityWeather for Render"
   git branch -M main
   git remote add origin https://github.com/YOUR_ACCOUNT/YOUR_REPOSITORY.git
   git push -u origin main
   ```

   Review staged filenames before committing. Never upload `.env` or `.env.runtime`; `.gitignore` excludes them.
2. Sign in at https://dashboard.render.com and connect your GitHub repository.
3. Choose **New > Blueprint**, select the repository and branch, and use `render.yaml` from its root.
4. Enter `OPENWEATHER_API_KEY` when prompted. Render generates the application's `API_KEY` and shares it with the worker. Database and Redis URLs are connected automatically. Do not use local Compose URLs.
5. Review all four resources and their charges, then create the Blueprint. To change region, edit every `region` before creating it.
6. Wait for the API and worker to deploy. Both run migrations before starting; Prisma serializes concurrent migrations. If an initial deploy encounters an advisory-lock timeout, redeploy that service after the other finishes migrating.
7. Copy the API's public HTTPS URL from its service page. Securely copy the generated `API_KEY` from **cityweather-api > Environment** into your API client's secret storage.
8. Test `GET https://YOUR-SERVICE.onrender.com/health` without authentication: expect `{"status":"ok"}`. Test `GET /weather?city=London` and `GET /history` with the header `X-API-Key: YOUR_GENERATED_APPLICATION_KEY`.
9. In the worker's Render Shell, run `npm run ops -- status` to check worker heartbeats and queues. Test a bulk upload using the routes in `README.md` and confirm the worker completes it.

## Operations

- This is an API with no homepage UI. `/health` checks the HTTP process only, without accessing the provider or checking ongoing dependency health. Business routes remain authenticated.
- Builds install development dependencies for TypeScript and Prisma. Migrations run in the pre-deploy step, never during builds.
- Upload staging is temporary; an upload interrupted by a deployment may need a retry. Parsed jobs and results live in PostgreSQL, so the worker needs no shared upload disk.
- The new database starts empty. Existing local history/jobs require a separate backup and restore.
- Keep provider budgets and `PROVIDER_CONFIG_REVISION` equal on API and worker. For provider credential rotation, update the API secret, increment the revision on both services in `render.yaml`, sync and redeploy both. Confirm the worker received the referenced secret.
- Redis has `noeviction` and paid persistence. Render-managed persistence differs from Compose's `appendfsync always`; crash durability should not be assumed identical. Monitor memory: the quota ledger can reach 900,000 entries at default limits. Upgrade capacity as necessary. Never delete Redis to reset limits; lost quota continuity can trigger a conservative 31-day hold.
- Monitor database storage and worker pending age. Starting plans do not guarantee capacity for maximum-size imports.
- Future pushes trigger deployments. Use backward-compatible migrations because API and worker deploy independently.

References: [Blueprints](https://render.com/docs/infrastructure-as-code), [Blueprint configuration](https://render.com/docs/blueprint-spec), [Key Value](https://render.com/docs/key-value).
