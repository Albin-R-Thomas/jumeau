import { Provider } from "../src/provider";
import { ApiError } from "../src/errors";
import { cfg, mockStore, payload, response } from "./helpers";
test("honors HTTP-date Retry-After including past dates", async () => {
  const store = mockStore();
  const fetcher = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockImplementation(async () =>
      response(
        429,
        {},
        { "Retry-After": new Date(Date.now() + 120000).toUTCString() },
      ),
    );
  const provider = new Provider(store, cfg, fetcher);
  await expect(provider.geocode("London")).rejects.toMatchObject({
    code: "PROVIDER_QUOTA_EXCEEDED",
  });
  expect(store.cooldown.mock.calls[0]![0]).toBeGreaterThanOrEqual(119);
  expect(store.cooldown.mock.calls[0]![0]).toBeLessThanOrEqual(120);
  fetcher.mockImplementation(async () =>
    response(429, {}, { "Retry-After": "Thu, 01 Jan 1970 00:00:00 GMT" }),
  );
  await expect(provider.geocode("London")).rejects.toMatchObject({
    retryAfter: 1,
  });
});
test("zero retries makes exactly one outbound attempt", async () => {
  const store = mockStore(),
    fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockRejectedValue(new Error("network"));
  await expect(
    new Provider(store, { ...cfg, PROVIDER_MAX_RETRIES: 0 }, fetcher).geocode(
      "London",
    ),
  ).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
  expect(store.reserve).toHaveBeenCalledTimes(1);
});
test("invalid JSON is a payload failure without retry", async () => {
  const store = mockStore(),
    fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(new Response("invalid-json", { status: 200 }));
  await expect(
    new Provider(store, cfg, fetcher).geocode("London"),
  ).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
  expect(store.reserve).toHaveBeenCalledTimes(1);
});
const setup = () => {
  const store = mockStore();
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
  const sleep = jest.fn<Promise<void>, [number]>().mockResolvedValue(undefined);
  return {
    store,
    fetcher,
    sleep,
    provider: new Provider(store, cfg, fetcher, sleep),
  };
};
test("geocodes first match using limit one then metric coordinates", async () => {
  const s = setup();
  s.fetcher
    .mockResolvedValueOnce(
      response(200, [
        { lat: 51, lon: 0 },
        { lat: 2, lon: 3 },
      ]),
    )
    .mockResolvedValueOnce(response(200, payload));
  const geo = await s.provider.geocode("London,GB");
  const w = await s.provider.weather(geo);
  expect(w.city).toBe("London");
  expect(w.temperature_celsius).toBe(18.5);
  expect(w.observed_at).toBe(new Date(payload.dt * 1000).toISOString());
  const urls = s.fetcher.mock.calls.map((c) => new URL(String(c[0])));
  expect(urls[0]!.searchParams.get("limit")).toBe("1");
  expect(urls[1]!.searchParams.get("units")).toBe("metric");
  expect(s.store.reserve).toHaveBeenCalledTimes(2);
});
test.each([401, 403, 404, 400])("does not retry status %i", async (status) => {
  const s = setup();
  s.fetcher.mockResolvedValue(response(status, {}));
  await expect(s.provider.geocode("London")).rejects.toMatchObject({
    status: status === 404 ? 404 : 502,
  });
  expect(s.fetcher).toHaveBeenCalledTimes(1);
});
test.each([500, 502, 503, 504])(
  "reserves all three transient %i attempts",
  async (status) => {
    const s = setup();
    s.fetcher.mockImplementation(async () => response(status, {}));
    await expect(s.provider.geocode("London")).rejects.toMatchObject({
      code: "PROVIDER_FAILURE",
    });
    expect(s.store.reserve).toHaveBeenCalledTimes(3);
    expect(s.sleep).toHaveBeenCalledTimes(2);
  },
);
test("network retry recovers", async () => {
  const s = setup();
  s.fetcher
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce(response(200, [{ lat: 51, lon: 0 }]));
  await s.provider.geocode("London");
  expect(s.store.reserve).toHaveBeenCalledTimes(2);
});
test("timeout retried and distinguished", async () => {
  const s = setup();
  s.fetcher.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) =>
        options!.signal!.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      ),
  );
  const p = new Provider(
    s.store,
    { ...cfg, PROVIDER_TIMEOUT_MS: 5 },
    s.fetcher,
    s.sleep,
  );
  await expect(p.geocode("London")).rejects.toMatchObject({
    status: 504,
    code: "PROVIDER_TIMEOUT",
  });
  expect(s.store.reserve).toHaveBeenCalledTimes(3);
});
test.each([
  ["120", 120],
  [null, 600],
  ["invalid", 600],
])("quota cooldown %s", async (header, seconds) => {
  const s = setup();
  s.fetcher.mockResolvedValue(
    response(429, {}, header ? { "Retry-After": header } : undefined),
  );
  await expect(s.provider.geocode("London")).rejects.toMatchObject({
    status: 429,
    retryAfter: seconds,
  });
  expect(s.store.cooldown).toHaveBeenCalledWith(seconds);
  expect(s.fetcher).toHaveBeenCalledTimes(1);
});
test("quota blocks before fetch", async () => {
  const s = setup();
  s.store.reserve.mockRejectedValue(
    new ApiError(429, "LOCAL_QUOTA_EXCEEDED", "limit"),
  );
  await expect(s.provider.geocode("London")).rejects.toMatchObject({
    code: "LOCAL_QUOTA_EXCEEDED",
  });
  expect(s.fetcher).not.toHaveBeenCalled();
});
test.each([[], [{ lat: 999, lon: 0 }], {}])(
  "validates geocoding response %j",
  async (body) => {
    const s = setup();
    s.fetcher.mockResolvedValue(response(200, body));
    await expect(s.provider.geocode("London")).rejects.toBeInstanceOf(ApiError);
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  },
);
test("invalid weather payload never retries", async () => {
  const s = setup();
  s.fetcher.mockResolvedValue(
    response(200, { ...payload, main: { temp: "bad", humidity: 400 } }),
  );
  await expect(s.provider.weather({ lat: 0, lon: 0 })).rejects.toMatchObject({
    code: "PROVIDER_FAILURE",
  });
  expect(s.fetcher).toHaveBeenCalledTimes(1);
});
