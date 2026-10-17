import { Queue, ConnectionOptions } from "bullmq";
import { Config } from "../config";
export const queueName = "bulk-weather";
export const queuePrefix = "cityweather:bull";
export function connection(cfg: Config, worker = false): ConnectionOptions {
  const u = new URL(cfg.REDIS_URL);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: Number(u.pathname.slice(1) || 0),
    ...(u.protocol === "rediss:" ? { tls: {} } : {}),
    maxRetriesPerRequest: worker ? null : 1,
    connectTimeout: 5000,
    ...(worker ? {} : { enableOfflineQueue: false }),
  };
}
export type Delivery = {
  job_id?: string;
  result_id?: string;
  alias_id?: string;
  generation: number;
};
export const deliveryId = (kind: string, d: Delivery) =>
  `bulk-${d.result_id ?? d.alias_id ?? d.job_id}-${kind}-${d.generation}`;
export class BulkQueue {
  public queue: Queue;
  constructor(cfg: Config) {
    this.queue = new Queue(queueName, {
      connection: connection(cfg),
      prefix: queuePrefix,
      defaultJobOptions: {
        removeOnComplete: { age: 86400, count: 10000 },
        removeOnFail: { age: 86400, count: 10000 },
      },
    });
    this.queue.on("error", () =>
      console.error(
        JSON.stringify({ stage: "queue", code: "DEPENDENCY_UNAVAILABLE" }),
      ),
    );
  }
  async bootstrap(job: string) {
    await this.add("bootstrap", { job_id: job, generation: 1 });
  }
  async removeBootstrap(job: string) {
    await (
      await this.queue.getJob(
        deliveryId("bootstrap", { job_id: job, generation: 1 }),
      )
    )?.remove();
  }
  async add(kind: string, data: Delivery, delay = 0) {
    return this.queue.add(kind, data, {
      jobId: deliveryId(kind, data),
      delay: Math.max(0, delay),
    });
  }
  async close() {
    await this.queue.close();
  }
}
