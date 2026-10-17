# Render: one container and one persistent disk

`render.yaml` deploys PostgreSQL 17, Redis, the API and worker together in a single paid Docker web service. No managed database, separate worker or Key Value service is created. The initial plan is `1c-2g` (2 GB RAM) with a 5 GB disk. Review the total in Render before creation; one larger service is not necessarily cheaper than every alternative.

## Deploy

1. Open https://dashboard.render.com and choose **New > Blueprint**.
2. Connect **Albin-R-Thomas/jumeau**, branch **main**, using the root `render.yaml`.
3. Enter your real `OPENWEATHER_API_KEY`. Render generates `API_KEY` for clients.
4. Confirm the preview contains **one web service (`cityweather`) and one disk**, then review the price and create it. Do not separately create PostgreSQL, Redis or a worker.
5. Leave Docker Command unset. Do not add a build or pre-deploy migration command: the disk is available only at runtime. The container initializes local storage and runs migrations before starting the apps.
6. Wait for deployment. The public `/health` checks PostgreSQL, Redis and a live worker heartbeat. It may briefly return 503 while the worker initializes.
7. Copy your public HTTPS URL and retrieve `API_KEY` from **cityweather > Environment**. Use it as the `X-API-Key` request header for `/weather?city=London`, `/history` and bulk routes. No key is required for `/health`. `/` has no homepage UI.

If creating a Web Service manually instead of a Blueprint: choose Docker, set Dockerfile Path to `./Dockerfile.render`, select a paid 2 GB plan, attach a disk at exactly `/var/data`, set health path `/health`, add both API keys, and copy the small-workload settings from `render.yaml`. The regular `Dockerfile` runs only the API and is for Compose.

## Storage and startup

- PostgreSQL files: `/var/data/postgres`; Redis AOF: `/var/data/redis`.
- The database password is generated once and saved in `/var/data/database-password`. Keep that file with the database; never replace it during a redeploy.
- Local PostgreSQL and Redis bind to loopback only. Only the HTTP port is public. Do not set `DATABASE_URL`, `REDIS_URL`, `PGDATA` or override the entrypoint in Render.
- PostgreSQL, Redis and Node apps run under their own unprivileged users. A root supervisor manages ownership and ordered shutdown. If any child exits, it stops the others and exits unsuccessfully so Render can restart the container.
- Migrations run after local dependencies are ready. On shutdown, apps stop first, then databases flush. Render allows 60 seconds for shutdown.
- Uploads are temporary; completed admission data is in PostgreSQL. An interrupted upload may need retrying.
- Uploads support up to 10 MiB and 100,000 nonblank data records, matching the bulk contract and the assignment's 10k+ requirement. Streaming admission uses batches of 100 and one worker task runs at a time to limit simultaneous work without reducing supported import size. Processing uncached cities still takes time under the shared provider quotas. Redis allows 192 MiB of dataset memory with `noeviction`; actual process memory can be higher during persistence. Memory exhaustion fails writes rather than discarding quota history.
- Existing local data is not imported. Never delete the persistent disk or Redis data to reset provider quotas. Losing Redis continuity can trigger a conservative 31-day provider hold.

## Operations in Render Shell

The supervisor generates local connection settings at runtime. Use this wrapper rather than invoking `ops.js` directly:

```sh
python3 /app/deploy/render-supervisor.py exec node dist/src/ops.js status
```

To run the existing bulk smoke script (makes real provider calls):

```sh
python3 /app/deploy/render-supervisor.py exec node scripts/smoke-bulk.cjs
```

For an additional PostgreSQL logical backup, run in Render Shell:

```sh
gosu postgres pg_dump -h /tmp -U cityweather -d cityweather -Fc -f /var/data/cityweather-backup.dump
```

Copy the backup off the service through your chosen secure backup storage. A backup on the same disk does not protect against losing/deleting that disk. Keep disk snapshots for whole-stack recovery, including Redis and the password file. PostgreSQL-only restore does not restore Redis quota accounting. A tested recovery procedure and regular off-service backups remain your responsibility.

## Redeploys and limitations

Push changes to `main` to deploy. All four processes restart together. A persistent disk prevents multiple replicas and zero-downtime deployment; brief downtime is expected. Do not use the free tier: it cannot attach the required persistent disk.

Rotate the OpenWeather key in Environment and increment `PROVIDER_CONFIG_REVISION` in `render.yaml`, then redeploy. Both apps inherit the same settings. Monitor memory, disk capacity, `/health` and worker pending age. This setup is intended for small workloads, not high availability.

References: [Docker](https://render.com/docs/docker), [persistent disks](https://render.com/docs/disks), [Blueprint configuration](https://render.com/docs/blueprint-spec).
