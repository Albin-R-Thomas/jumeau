// Test-only isolated API process: benchmark client allocations are excluded.
if (process.env.NODE_ENV !== "test" || !process.send) process.exit(2);
const { runtime } = require("../dist/src/runtime");
const { config } = require("../dist/src/config");
const { createApp } = require("../dist/src/app");
const { bulkRoutes } = require("../dist/src/bulk/routes");
const { once } = require("node:events");
async function main() {
  let calls = 0,
    maxBatch = 0,
    peak = 0;
  const r = await runtime(config(process.env), {
    fetcher: async () => {
      calls++;
      throw new Error("Unexpected provider dispatch.");
    },
  });
  await r.queue.queue.waitUntilReady();
  const stage = r.repo.stage.bind(r.repo);
  r.repo.stage = async (id, rows) => {
    maxBatch = Math.max(maxBatch, rows.length);
    return stage(id, rows);
  };
  const server = createApp(
    r.cfg.API_KEY,
    r.weather,
    r.history,
    bulkRoutes(r.cfg, r.repo, r.queue),
  ).listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseline = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 10);
  process.send({ ready: true, port: server.address().port });
  process.on("message", async (message) => {
    try {
      if (message.command === "measure")
        process.send({
          request: message.request,
          metrics: {
            baseline_rss_mib: +(baseline / 1048576).toFixed(1),
            peak_rss_mib: +(peak / 1048576).toFixed(1),
            max_batch: maxBatch,
            provider_attempts: calls,
          },
        });
      if (message.command === "cleanup") {
        clearInterval(sampler);
        await new Promise((resolve) => server.close(resolve));
        for (const id of message.jobs) {
          await r.queue.removeBootstrap(id);
          await r.db.bulkJob.deleteMany({ where: { job_id: id } });
        }
        await r.close();
        process.send({ request: message.request, closed: true });
        process.disconnect();
      }
    } catch {
      process.send({ request: message.request, error: "HARNESS_FAILED" });
      process.exit(1);
    }
  });
}
main().catch(() => {
  process.send({ error: "HARNESS_FAILED" });
  process.exit(1);
});
