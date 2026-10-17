import { config } from "./config";
import { createApp } from "./app";
import { runtime } from "./runtime";
import { bulkRoutes } from "./bulk/routes";
import { cleanupUploads } from "./bulk/admission";
async function main() {
  const cfg = config(process.env);
  const r = await runtime(cfg);
  await cleanupUploads(cfg.BULK_STAGING_DIR);
  const cleanup = setInterval(() => {
    void cleanupUploads(cfg.BULK_STAGING_DIR).catch(() => {});
  }, 60000);
  const server = createApp(
    cfg.API_KEY,
    r.weather,
    r.history,
    bulkRoutes(cfg, r.repo, r.queue),
    process.env.ALL_IN_ONE === "true"
      ? async () => {
          const check = Promise.all([
            r.db.$queryRaw`SELECT 1`,
            r.redis.ping(),
            r.index.keys("cityweather:worker:*"),
          ]).then(([, pong, workers]) => pong === "PONG" && workers.length > 0);
          let timeout: NodeJS.Timeout | undefined;
          try {
            return await Promise.race([
              check,
              new Promise<boolean>((resolve) => {
                timeout = setTimeout(() => resolve(false), 2000);
              }),
            ]);
          } finally {
            clearTimeout(timeout);
          }
        }
      : undefined,
  ).listen(cfg.PORT, "0.0.0.0", () => console.log("CityWeather+ listening."));
  server.requestTimeout = cfg.BULK_UPLOAD_TIMEOUT_MS + 5000;
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(cleanup);
    const timer = setTimeout(() => process.exit(1), 10000);
    timer.unref();
    server.close(() => {
      void r.close().then(() => {
        clearTimeout(timer);
        process.exit(0);
      });
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
main().catch(() => {
  console.error(
    "Startup failed. Check configuration and dependency availability.",
  );
  process.exit(1);
});
