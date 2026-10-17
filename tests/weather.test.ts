import { WeatherService } from "../src/weather";
import { ApiError } from "../src/errors";
import { History } from "../src/types";
import { mockStore, weather } from "./helpers";
const setup = () => {
  const store = mockStore();
  const history: jest.Mocked<History> = {
    record: jest.fn().mockResolvedValue(undefined),
    page: jest.fn(),
    delete: jest.fn(),
  };
  const provider = {
    geocode: jest.fn().mockResolvedValue({ lat: 51, lon: 0 }),
    weather: jest.fn().mockResolvedValue(weather),
  };
  return {
    store,
    history,
    provider,
    service: new WeatherService(store, provider, history, 900),
  };
};
test("miss caches geo and weather, records provider resolved city", async () => {
  const s = setup();
  expect(await s.service.get("london")).toEqual(weather);
  expect(s.store.set.mock.calls.map((c) => c[2])).toEqual([
    2592000, 86400, 900,
  ]);
  expect(s.history.record).toHaveBeenCalledWith("London", "provider");
});
test("cache hits and repeats each record history without extending TTL", async () => {
  const s = setup();
  s.store.get.mockResolvedValue(JSON.stringify(weather));
  await s.service.get("London");
  await s.service.get("london");
  expect(s.history.record.mock.calls).toEqual([
    ["London", "cache"],
    ["London", "cache"],
  ]);
  expect(s.provider.weather).not.toHaveBeenCalled();
  expect(s.store.set).not.toHaveBeenCalled();
});
test("geo hit still records provider source", async () => {
  const s = setup();
  s.store.get
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce('{"lat":51,"lon":0}');
  await s.service.get("London");
  expect(s.provider.geocode).not.toHaveBeenCalled();
  expect(s.history.record).toHaveBeenCalledWith("London", "provider");
});
test("coalesces concurrent requests but records each", async () => {
  const s = setup();
  await Promise.all(Array.from({ length: 10 }, () => s.service.get("London")));
  expect(s.provider.weather).toHaveBeenCalledTimes(1);
  expect(s.history.record).toHaveBeenCalledTimes(10);
  expect(s.history.record.mock.calls.every((c) => c[1] === "provider")).toBe(
    true,
  );
});
test("corrupt entries refetch", async () => {
  const s = setup();
  s.store.get.mockResolvedValue("garbage");
  await s.service.get("London");
  expect(s.provider.weather).toHaveBeenCalledTimes(1);
});
test("redis outage fails closed", async () => {
  const s = setup();
  s.store.get.mockRejectedValue(
    new ApiError(503, "DEPENDENCY_UNAVAILABLE", "Unavailable"),
  );
  await expect(s.service.get("London")).rejects.toMatchObject({ status: 503 });
  expect(s.provider.weather).not.toHaveBeenCalled();
});
test("history failure prevents success", async () => {
  const s = setup();
  s.history.record.mockRejectedValue(
    new ApiError(503, "DEPENDENCY_UNAVAILABLE", "Unavailable"),
  );
  await expect(s.service.get("London")).rejects.toMatchObject({ status: 503 });
});
test("failed fetch removed from coalescing map", async () => {
  const s = setup();
  s.provider.weather.mockRejectedValueOnce(
    new ApiError(502, "PROVIDER_FAILURE", "Unavailable"),
  );
  await expect(s.service.get("London")).rejects.toMatchObject({ status: 502 });
  await s.service.get("London");
  expect(s.provider.weather).toHaveBeenCalledTimes(2);
});

test.each([
  "LOCAL_QUOTA_EXCEEDED",
  "PROVIDER_QUOTA_EXCEEDED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_FAILURE",
])("serves stale weather on %s without extending TTL", async (code) => {
  const s = setup();
  s.store.get.mockImplementation(async (key) =>
    key.startsWith("weather:v2:stale:") ? JSON.stringify(weather) : null,
  );
  s.provider.geocode.mockRejectedValue(new ApiError(502, code, "Unavailable"));
  expect(await s.service.get("London")).toEqual(weather);
  expect(s.history.record).toHaveBeenCalledWith("London", "cache");
  expect(s.store.set).not.toHaveBeenCalled();
});
test.each(["PROVIDER_AUTH_ERROR", "CITY_NOT_FOUND", "DEPENDENCY_UNAVAILABLE"])(
  "does not hide %s with stale data",
  async (code) => {
    const s = setup();
    s.store.get.mockImplementation(async (key) =>
      key.startsWith("weather:v2:stale:") ? JSON.stringify(weather) : null,
    );
    s.provider.geocode.mockRejectedValue(new ApiError(502, code, "Failure"));
    await expect(s.service.get("London")).rejects.toMatchObject({ code });
    expect(s.history.record).not.toHaveBeenCalled();
  },
);
test.each([null, "garbage", "{}"])(
  "missing or invalid stale backup preserves provider error: %s",
  async (stale) => {
    const s = setup();
    s.store.get.mockImplementation(async (key) =>
      key.startsWith("weather:v2:stale:") ? stale : null,
    );
    s.provider.geocode.mockRejectedValue(
      new ApiError(429, "LOCAL_QUOTA_EXCEEDED", "Limit", 60),
    );
    await expect(s.service.get("London")).rejects.toMatchObject({
      code: "LOCAL_QUOTA_EXCEEDED",
      retryAfter: 60,
    });
    expect(s.history.record).not.toHaveBeenCalled();
  },
);
test("weather-fetch failure uses stale backup after geocoding succeeds", async () => {
  const s = setup();
  s.store.get.mockImplementation(async (key) =>
    key.startsWith("weather:v2:stale:")
      ? JSON.stringify(weather)
      : key.startsWith("geo:")
        ? '{"lat":51,"lon":0}'
        : null,
  );
  s.provider.weather.mockRejectedValue(
    new ApiError(504, "PROVIDER_TIMEOUT", "Timeout"),
  );
  expect(await s.service.get("London")).toEqual(weather);
  expect(s.history.record).toHaveBeenCalledWith("London", "cache");
  expect(s.store.set).not.toHaveBeenCalled();
});
test("concurrent stale fallbacks share refresh but record every request", async () => {
  const s = setup();
  s.store.get.mockImplementation(async (key) =>
    key.startsWith("weather:v2:stale:") ? JSON.stringify(weather) : null,
  );
  s.provider.geocode.mockRejectedValue(
    new ApiError(429, "PROVIDER_QUOTA_EXCEEDED", "Limit"),
  );
  await Promise.all(Array.from({ length: 5 }, () => s.service.get("London")));
  expect(s.provider.geocode).toHaveBeenCalledTimes(1);
  expect(s.history.record).toHaveBeenCalledTimes(5);
});
test("history failure still prevents stale success", async () => {
  const s = setup();
  s.store.get.mockImplementation(async (key) =>
    key.startsWith("weather:v2:stale:") ? JSON.stringify(weather) : null,
  );
  s.provider.geocode.mockRejectedValue(
    new ApiError(502, "PROVIDER_FAILURE", "Failure"),
  );
  s.history.record.mockRejectedValue(
    new ApiError(503, "DEPENDENCY_UNAVAILABLE", "Unavailable"),
  );
  await expect(s.service.get("London")).rejects.toMatchObject({ status: 503 });
});
