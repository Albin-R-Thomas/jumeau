import { RedisClient, RedisStore } from "../src/store";
const setup = () => {
  const redis: jest.Mocked<RedisClient> = {
    get: jest.fn(),
    set: jest.fn(),
    eval: jest.fn(),
  };
  return { redis, store: new RedisStore(redis, 55, 900000) };
};
test("quota executes one atomic script with unique reservation members", async () => {
  const s = setup();
  s.redis.eval.mockResolvedValue([0, 0]);
  await s.store.reserve();
  await s.store.reserve();
  expect(s.redis.eval.mock.calls[0]![1].keys).toEqual([
    "cityweather:minute",
    "cityweather:month",
    "cityweather:cooldown",
  ]);
  expect(s.redis.eval.mock.calls[0]![1].arguments.slice(0, 2)).toEqual([
    "55",
    "900000",
  ]);
  expect(s.redis.eval.mock.calls[0]![1].arguments[2]).not.toBe(
    s.redis.eval.mock.calls[1]![1].arguments[2],
  );
});
test.each([
  [1, "LOCAL_QUOTA_EXCEEDED"],
  [2, "PROVIDER_QUOTA_EXCEEDED"],
])("maps quota result %i", async (result, code) => {
  const s = setup();
  s.redis.eval.mockResolvedValue([result, 30]);
  await expect(s.store.reserve()).rejects.toMatchObject({
    status: 429,
    code,
    retryAfter: 30,
  });
});
test("redis connection errors are redacted and fail closed", async () => {
  const s = setup();
  s.redis.eval.mockRejectedValue(new Error("sensitive-placeholder"));
  await expect(s.store.reserve()).rejects.toMatchObject({
    status: 503,
    message: "A required dependency is unavailable.",
  });
});
test("cache writes fixed TTL and reads without touching expiry", async () => {
  const s = setup();
  s.redis.get.mockResolvedValue("cached");
  s.redis.set.mockResolvedValue("OK");
  await s.store.set("key", "cached", 900);
  expect(await s.store.get("key")).toBe("cached");
  expect(s.redis.set).toHaveBeenCalledTimes(1);
  expect(s.redis.set).toHaveBeenCalledWith("cityweather:key", "cached", {
    EX: 900,
  });
});
