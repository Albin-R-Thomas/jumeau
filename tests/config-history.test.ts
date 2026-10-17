import { config } from "../src/config";
import { decodeCursor, encodeCursor } from "../src/history";
import { cfg } from "./helpers";
test("configuration defaults and required fields", () => {
  expect(cfg.WEATHER_CACHE_TTL_SECONDS).toBe(900);
  expect(cfg.PROVIDER_CALLS_PER_MINUTE).toBe(55);
  expect(() => config({})).toThrow("Invalid configuration fields");
});
test("configuration errors do not expose supplied values", () => {
  expect(() =>
    config({
      API_KEY: "sensitive-placeholder",
      REDIS_URL: "invalid-placeholder",
    }),
  ).toThrow(/^Invalid configuration fields:/);
  try {
    config({ REDIS_URL: "invalid-placeholder" });
  } catch (e) {
    expect(String(e)).not.toContain("invalid-placeholder");
  }
});
test.each([0, -1, 61, 1.5])("rejects invalid minute budget %s", (value) => {
  expect(() =>
    config({
      ...cfg,
      PORT: String(cfg.PORT),
      PROVIDER_CALLS_PER_MINUTE: String(value),
    } as unknown as NodeJS.ProcessEnv),
  ).toThrow();
});
test.each([
  {
    v: 2,
    timestamp: "2026-10-14T08:00:00.000Z",
    id: "12345678-1234-4234-8234-123456789abc",
  },
  { v: 1, timestamp: "not-date", id: "bad" },
  {
    v: 1,
    timestamp: "2026-10-14T08:00:00Z",
    id: "12345678-1234-4234-8234-123456789abc",
  },
])("rejects malformed cursor %j", (cursor) => {
  expect(() =>
    decodeCursor(Buffer.from(JSON.stringify(cursor)).toString("base64url")),
  ).toThrow("Invalid history cursor");
});
test("cursor round trips", () => {
  const c = {
    v: 1 as const,
    timestamp: "2026-10-14T08:00:00.000Z",
    id: "12345678-1234-4234-8234-123456789abc",
  };
  expect(decodeCursor(encodeCursor(c))).toEqual(c);
});
