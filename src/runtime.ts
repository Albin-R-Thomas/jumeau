import { PrismaClient } from "@prisma/client";
import { createClient } from "redis";
import Redis from "ioredis";
import { AsyncLocalStorage } from "node:async_hooks";
import { Config } from "./config";
import { PrismaHistory } from "./history";
import { RedisStore } from "./store";
import { Provider } from "./provider";
import { WeatherService } from "./weather";
import { WeatherFetcher } from "./weather-fetch";
import { CityResolver } from "./cities/resolver";
import { QuotaGuard } from "./quota-guard";
import { BulkRepository, Claim } from "./bulk/repository";
import { BulkQueue } from "./bulk/queue";
import { BulkProcessor } from "./bulk/processor";
import { Reconciler } from "./bulk/reconcile";
import { ApiError } from "./errors";

export async function runtime(
  cfg: Config,
  options: {
    fetcher?: typeof fetch;
    now?: () => number;
    random?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const db = new PrismaClient();
  const redis = createClient({
    url: cfg.REDIS_URL,
    disableOfflineQueue: true,
    socket: { connectTimeout: 5000 },
  });
  const index = new Redis(cfg.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 5000,
    connectTimeout: 5000,
  });
  redis.on("error", () =>
    console.error('{"stage":"redis","code":"DEPENDENCY_UNAVAILABLE"}'),
  );
  index.on("error", () =>
    console.error('{"stage":"redis-index","code":"DEPENDENCY_UNAVAILABLE"}'),
  );
  await Promise.all([db.$connect(), redis.connect(), index.connect()]);
  const store = new RedisStore(
    redis,
    cfg.PROVIDER_CALLS_PER_MINUTE,
    cfg.PROVIDER_CALLS_PER_MONTH,
  );
  const guard = new QuotaGuard(db, index, cfg);
  const repo = new BulkRepository(db, cfg);
  const ownership = new AsyncLocalStorage<Claim>();
  const provider = new Provider(
    store,
    cfg,
    options.fetcher,
    options.sleep,
    options.random,
    options.now,
    async () => {
      const claim = ownership.getStore();
      if (claim && !(await repo.owned(claim)))
        throw new ApiError(503, "LEASE_LOST", "Worker ownership expired.");
      try {
        await guard.beforeAttempt();
      } catch (e) {
        if (e instanceof ApiError) throw e;
        throw new ApiError(
          503,
          "DEPENDENCY_UNAVAILABLE",
          "Provider dispatch dependencies are unavailable.",
        );
      }
    },
  );
  const resolver = new CityResolver(db, index, provider, cfg, options.now);
  const fetcher = new WeatherFetcher(index, resolver, provider, options.now);
  const history = new PrismaHistory(db);
  const weather = new WeatherService(
    store,
    provider,
    history,
    cfg.WEATHER_CACHE_TTL_SECONDS,
    fetcher,
  );
  const queue = new BulkQueue(cfg);
  const processor = new BulkProcessor(
    repo,
    fetcher,
    guard,
    options.random,
    options.now,
    (claim, fn) => ownership.run(claim, fn),
  );
  const reconciler = new Reconciler(repo, queue, fetcher, store);
  return {
    cfg,
    db,
    redis,
    index,
    store,
    guard,
    repo,
    resolver,
    fetcher,
    history,
    weather,
    queue,
    processor,
    reconciler,
    ownership,
    async close() {
      await Promise.allSettled([
        queue.close(),
        db.$disconnect(),
        redis.quit(),
        index.quit(),
      ]);
    },
  };
}
export type Runtime = Awaited<ReturnType<typeof runtime>>;
