import { Worker, Job, DelayedError } from "bullmq";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { runtime, Runtime } from "../runtime";
import { Delivery, queueName, queuePrefix, connection } from "./queue";
export function startWorker(r: Runtime) {
  const worker = new Worker<Delivery>(
    queueName,
    async (job: Job<Delivery>, token?: string) => {
      if (job.name === "bootstrap") {
        const parent = await r.db.bulkJob.findUnique({
          where: { job_id: job.data.job_id },
        });
        if (parent?.admission_phase === "preparing") {
          await job.moveToDelayed(Date.now() + 5000, token);
          throw new DelayedError();
        }
        return;
      }
      if (job.name === "revalidate-alias" && job.data.alias_id) {
        await r.reconciler.revalidate(job.data.alias_id, job.data.generation);
        return;
      }
      await r.processor.process(job.data);
    },
    {
      connection: connection(r.cfg, true),
      prefix: queuePrefix,
      concurrency: r.cfg.BULK_WORKER_CONCURRENCY,
      lockDuration: 60000,
      stalledInterval: 30000,
    },
  );
  worker.on("error", () =>
    console.error('{"stage":"worker","code":"DEPENDENCY_UNAVAILABLE"}'),
  );
  worker.on("failed", (job) =>
    console.error(
      JSON.stringify({
        stage: "worker",
        delivery_id: job?.id,
        code: "DELIVERY_FAILED",
      }),
    ),
  );
  worker.on("stalled", () => {
    void r.index.incr("cityweather:ops:stalled").catch(() => {});
  });
  const id = randomUUID();
  let activeTick: Promise<void> | undefined;
  const tick = async () => {
    try {
      await r.reconciler.tick();
      await r.index.set(
        `cityweather:worker:${id}`,
        JSON.stringify({ heartbeat_at: new Date().toISOString() }),
        "EX",
        30,
      );
    } catch {
      console.error('{"stage":"reconcile","code":"DEPENDENCY_UNAVAILABLE"}');
    }
  };
  const runTick = () => {
    if (!activeTick)
      activeTick = tick().finally(() => {
        activeTick = undefined;
      });
  };
  const interval = setInterval(runTick, r.cfg.BULK_RECONCILE_INTERVAL_MS);
  runTick();
  return {
    worker,
    async close() {
      clearInterval(interval);
      await activeTick;
      await worker.close();
      await r.index.del(`cityweather:worker:${id}`).catch(() => {});
    },
  };
}
async function main() {
  const r = await runtime(config(process.env));
  const w = startWorker(r);
  console.log("CityWeather+ worker started.");
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    void w
      .close()
      .then(() => r.close())
      .then(() => {
        clearTimeout(deadline);
        process.exit(0);
      });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
if (require.main === module)
  main().catch(() => {
    console.error(
      "Worker startup failed. Check configuration and dependencies.",
    );
    process.exit(1);
  });
