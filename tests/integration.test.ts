import { PrismaClient } from "@prisma/client";
import { createClient } from "redis";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { PrismaHistory, decodeCursor } from "../src/history";
import { RedisStore } from "../src/store";
import { Provider } from "../src/provider";
import { WeatherService } from "../src/weather";
import { createApp } from "../src/app";
import { cfg, payload, response, weather } from "./helpers";
import { createHash } from "node:crypto";
import { ApiError } from "../src/errors";
const suite =
  process.env.NODE_ENV === "test" &&
  process.env.DATABASE_URL &&
  process.env.REDIS_URL
    ? describe
    : describe.skip;
suite("real PostgreSQL/Redis integration", () => {
  const db = new PrismaClient();
  const redis = createClient({
    url: process.env.REDIS_URL,
    disableOfflineQueue: true,
  });
  redis.on("error", () => {});
  const history = new PrismaHistory(db);
  const prefix = "test:" + randomUUID() + ":";
  let store: RedisStore;
  beforeAll(async () => {
    await db.$connect();
    await redis.connect();
  }, 30000);
  beforeEach(async () => {
    await history.delete();
    await redis.flushDb();
    store = new RedisStore(redis, 55, 900000, prefix);
  });
  afterAll(async () => {
    await db.$disconnect();
    await redis.quit();
  });
  test("complete authenticated API flow, provider then cache, pagination and deletion", async () => {
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(async (url) =>
        String(url).includes("/geo/")
          ? response(200, [{ lat: 51, lon: 0 }])
          : response(200, payload),
      );
    const service = new WeatherService(
      store,
      new Provider(store, cfg, fetcher),
      history,
      900,
    );
    const app = createApp(cfg.API_KEY, service, history);
    const auth = (r: request.Test) => r.set("X-API-Key", cfg.API_KEY);
    expect((await request(app).get("/weather?city=London")).status).toBe(401);
    expect((await auth(request(app).get("/weather?city=London"))).status).toBe(
      200,
    );
    expect((await auth(request(app).get("/weather?city=london"))).status).toBe(
      200,
    );
    const first = await auth(request(app).get("/history?limit=1"));
    expect(first.body.items[0].source).toBe("cache");
    expect(first.body.items[0].city_name).toBe("London");
    const second = await auth(
      request(app)
        .get("/history")
        .query({ limit: 1, cursor: first.body.next_cursor }),
    );
    expect(second.body.items[0].source).toBe("provider");
    expect(second.body.next_cursor).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    const quota = await redis.zCard(prefix + "month");
    for (let i = 0; i < 2; i++)
      expect((await auth(request(app).delete("/history"))).status).toBe(204);
    expect((await auth(request(app).get("/history"))).body.items).toEqual([]);
    await auth(request(app).get("/weather?city=London"));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await redis.zCard(prefix + "month")).toBe(quota);
    expect((await history.page(20)).items[0]!.source).toBe("cache");
  });
  test("timestamp ties paginate with no duplicates; cursor survives deleted row", async () => {
    const timestamp = new Date("2026-10-14T08:00:00.000Z");
    const ids = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ];
    await db.searchHistory.createMany({
      data: ids.map((id) => ({
        id,
        timestamp,
        city_name: "London",
        source: "provider",
      })),
    });
    const first = await history.page(1);
    expect(first.items[0]!.id).toBe(ids[2]);
    await db.searchHistory.delete({ where: { id: ids[2] } });
    const second = await history.page(1, decodeCursor(first.next_cursor!));
    expect(second.items[0]!.id).toBe(ids[1]);
    const third = await history.page(1, decodeCursor(second.next_cursor!));
    expect(third.items[0]!.id).toBe(ids[0]);
    expect(third.next_cursor).toBeNull();
  });
  test("cache expires, refetches weather but retains geocoding", async () => {
    const provider = {
      geocode: jest.fn().mockResolvedValue({ lat: 51, lon: 0 }),
      weather: jest.fn().mockResolvedValue({
        city: "London",
        country: "GB",
        temperature_celsius: 18,
        condition: "clouds",
        humidity_percent: 72,
        observed_at: "2026-10-14T08:00:00.000Z",
      }),
    };
    const service = new WeatherService(store, provider, history, 1);
    await service.get("London");
    await new Promise((r) => setTimeout(r, 1100));
    await service.get("London");
    expect(provider.weather).toHaveBeenCalledTimes(2);
    expect(provider.geocode).toHaveBeenCalledTimes(1);
    expect((await history.page(20)).items.map((r) => r.source)).toEqual([
      "provider",
      "provider",
    ]);
  });
  test("concurrent quota reservations are atomic", async () => {
    const limited = new RedisStore(redis, 3, 100, prefix);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => limited.reserve()),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await redis.zCard(prefix + "minute")).toBe(3);
    expect(await redis.zCard(prefix + "month")).toBe(3);
  });
  test("expired fresh cache falls back on provider failure and recovers without renewing stale retention", async () => {
    const provider = {
      geocode: jest.fn().mockResolvedValue({ lat: 51, lon: 0 }),
      weather: jest.fn().mockResolvedValue(weather),
    };
    const service = new WeatherService(store, provider, history, 1);
    const key = createHash("sha256").update("london").digest("hex");
    await service.get("London");
    const retentionBefore = await redis.pTTL(
      prefix + "weather:v2:stale:" + key,
    );
    await new Promise((r) => setTimeout(r, 1100));
    provider.weather.mockRejectedValueOnce(
      new ApiError(502, "PROVIDER_FAILURE", "Unavailable"),
    );
    expect(await service.get("London")).toEqual(weather);
    expect(await store.get("weather:v2:fresh:" + key)).toBeNull();
    expect(await redis.pTTL(prefix + "weather:v2:stale:" + key)).toBeLessThan(
      retentionBefore,
    );
    expect((await history.page(20)).items[0]!.source).toBe("cache");
    const refreshed = { ...weather, temperature_celsius: 25 };
    provider.weather.mockResolvedValueOnce(refreshed);
    expect(await service.get("London")).toEqual(refreshed);
    expect(JSON.parse((await store.get("weather:v2:fresh:" + key))!)).toEqual(
      refreshed,
    );
    expect((await history.page(20)).items[0]!.source).toBe("provider");
  });
  test("stale backup covers local quota and shared provider cooldown, but expires", async () => {
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(async (url) =>
        String(url).includes("/geo/")
          ? response(200, [{ lat: 51, lon: 0 }])
          : response(200, payload),
      );
    const limited = new RedisStore(redis, 2, 100, prefix);
    const service = new WeatherService(
      limited,
      new Provider(limited, cfg, fetcher),
      history,
      1,
    );
    await service.get("London");
    await new Promise((r) => setTimeout(r, 1100));
    expect((await service.get("London")).city).toBe("London");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await redis.zCard(prefix + "month")).toBe(2);
    await limited.cooldown(600);
    expect((await service.get("London")).city).toBe("London");
    expect((await history.page(20)).items[0]!.source).toBe("cache");
    const key = createHash("sha256").update("london").digest("hex");
    await redis.pExpire(prefix + "weather:v2:stale:" + key, 1);
    await new Promise((r) => setTimeout(r, 10));
    await expect(service.get("London")).rejects.toMatchObject({
      code: "PROVIDER_QUOTA_EXCEEDED",
    });
    expect(await db.searchHistory.count()).toBe(3);
  });
  test("rolling month and minute boundaries prune expired calls", async () => {
    const limited = new RedisStore(redis, 1, 1, prefix);
    await limited.reserve();
    await expect(limited.reserve()).rejects.toMatchObject({
      code: "LOCAL_QUOTA_EXCEEDED",
    });
    const old = Date.now() - 2678400001;
    await redis.zAdd(prefix + "minute", { score: old, value: "old" });
    await redis.zAdd(prefix + "month", { score: old, value: "old" });
    // Replace the current reservation with an expired one, exercising both windows.
    for (const key of ["minute", "month"]) {
      const entries = await redis.zRange(prefix + key, 0, -1);
      for (const entry of entries)
        if (entry !== "old") await redis.zRem(prefix + key, entry);
    }
    await limited.reserve();
    expect(await redis.zCard(prefix + "month")).toBe(1);
  });
  test("shared cooldown only extends, cached requests remain available", async () => {
    await store.cooldown(2);
    await store.cooldown(1);
    expect(await redis.pTTL(prefix + "cooldown")).toBeGreaterThan(1000);
    await expect(store.reserve()).rejects.toMatchObject({
      code: "PROVIDER_QUOTA_EXCEEDED",
    });
    await store.set("available", "cached", 10);
    expect(await store.get("available")).toBe("cached");
  });
  test("disconnected Redis and PostgreSQL return safe 503 errors", async () => {
    const offline = createClient({
      url: process.env.REDIS_URL,
      disableOfflineQueue: true,
    });
    await expect(
      new RedisStore(offline, 55, 900000).reserve(),
    ).rejects.toMatchObject({ status: 503 });
    const broken = new PrismaClient({
      datasources: {
        db: {
          url: "postgresql://test:test@127.0.0.1:1/test?connect_timeout=1",
        },
      },
    });
    try {
      await expect(
        new PrismaHistory(broken).record("London", "cache"),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      await broken.$disconnect();
    }
  });
});
