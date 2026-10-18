import { Provider } from "../src/provider";
import { CityResolver } from "../src/cities/resolver";
import { BulkProcessor } from "../src/bulk/processor";
import { ApiError, invalidProviderPayload } from "../src/errors";
import { cfg, mockStore, payload, response } from "./helpers";

test.each(["", undefined])("missing country remains a geocoding candidate: %s", async (country) => {
  const fetcher = jest.fn().mockResolvedValue(response(200, [
    { name: "Ifo", lat: 6.8, lon: 3.2, country: "NG" },
    { name: "Ifo", lat: -66.6, lon: 139.7, country },
  ]));
  const provider = new Provider(mockStore(), cfg, fetcher);
  const candidates = await provider.geocodeCandidates("Ifo");
  expect(candidates).toHaveLength(2);
  expect(candidates[1]!.country).toBe("");
  const resolver = new CityResolver({} as any, {} as any, {
    geocodeCandidates: async () => candidates,
  }, cfg);
  await expect(resolver.resolve("Ifo", "bulk_unambiguous"))
    .rejects.toMatchObject({ code: "CITY_AMBIGUOUS" });
  await expect(resolver.resolve("Ifo,NG", "bulk_unambiguous"))
    .rejects.toMatchObject({ code: "CITY_QUALIFICATION_UNVERIFIABLE" });
});

test("a sole countryless location cannot be persisted as verified", async () => {
  const resolver = new CityResolver({} as any, {} as any, {
    geocodeCandidates: async () => [{ name: "Ifo", lat: 1, lon: 2, country: "" }],
  }, cfg);
  await expect(resolver.resolve("Ifo", "bulk_unambiguous"))
    .rejects.toMatchObject({ code: "CITY_QUALIFICATION_UNVERIFIABLE" });
});

test.each(["", "South America", undefined])("weather uses verified location when name is %s", async (name) => {
  const fetcher = jest.fn().mockImplementation(async () => response(200, {
    ...payload, name, sys: {},
  }));
  const provider = new Provider(mockStore(), cfg, fetcher);
  await expect(provider.weather({ lat: -14.6, lon: -57.4 }, {
    name: "Tangará da Serra", country: "BR",
  })).resolves.toMatchObject({ city: "Tangará da Serra", country: "BR", temperature_celsius: 18.5 });
  await expect(provider.weather({ lat: -14.6, lon: -57.4 }))
    .rejects.toMatchObject({ workerCode: "PROVIDER_INVALID_PAYLOAD" });
});

test.each([
  { ...payload, sys: { country: "NG" } },
  { ...payload, main: { temp: "bad", humidity: 70 } },
  { ...payload, main: { temp: 20, humidity: 101 } },
])("verified identity does not hide invalid measurements or conflicting country", async (body) => {
  const provider = new Provider(mockStore(), cfg, jest.fn().mockResolvedValue(response(200, body)));
  await expect(provider.weather({ lat: 1, lon: 2 }, { name: "London", country: "GB" }))
    .rejects.toMatchObject({ workerCode: "PROVIDER_INVALID_PAYLOAD" });
});

test.each([1, 5, 227])("invalid payload claim %i has bounded recovery", async (attempts) => {
  const repo = {
    cfg, claim: jest.fn().mockResolvedValue({ attempts, display_city: "Ifo" }),
    finish: jest.fn(), heartbeat: jest.fn(),
  };
  const processor = new BulkProcessor(repo as any, {
    bulk: async () => ({ kind: "deferred", error: invalidProviderPayload("bad payload") }),
  } as any, {} as any);
  await processor.process({ result_id: "row", generation: 1 } as any);
  const outcome = repo.finish.mock.calls[0]![1];
  expect(outcome.error.code).toBe("PROVIDER_INVALID_PAYLOAD");
  expect(Boolean(outcome.resume_at)).toBe(attempts < 5);
});

test("other transient errors are not terminalized by the payload attempt limit", async () => {
  const repo = { cfg, claim: jest.fn().mockResolvedValue({ attempts: 227, display_city: "Ifo" }), finish: jest.fn() };
  await new BulkProcessor(repo as any, {
    bulk: async () => ({ kind: "deferred", error: new ApiError(504, "PROVIDER_TIMEOUT", "timeout") }),
  } as any, {} as any).process({ result_id: "row", generation: 1 } as any);
  expect(repo.finish.mock.calls[0]![1].resume_at).toBeInstanceOf(Date);
});

test("an already over-limit row can recover with a valid fresh snapshot", async () => {
  const snapshot = { weather: {}, source: "provider" };
  const repo = {
    cfg, claim: jest.fn().mockResolvedValue({ attempts: 227, display_city: "Cafunfo" }),
    finish: jest.fn(),
  };
  const guard = { clearAuth: jest.fn() };
  await new BulkProcessor(repo as any, {
    bulk: async () => ({ kind: "fresh", snapshot }),
  } as any, guard as any).process({ result_id: "row", generation: 1 } as any);
  expect(repo.finish).toHaveBeenCalledWith(expect.anything(), { snapshot });
  expect(guard.clearAuth).toHaveBeenCalled();
});

test("direct geocoding payload errors also obey the attempt limit", async () => {
  const repo = {
    cfg, claim: jest.fn().mockResolvedValue({ attempts: 5, display_city: "Ifo" }),
    finish: jest.fn(),
  };
  await new BulkProcessor(repo as any, {
    bulk: async () => { throw new ApiError(502, "PROVIDER_INVALID_PAYLOAD", "bad geocoding"); },
  } as any, {} as any).process({ result_id: "row", generation: 1 } as any);
  expect(repo.finish.mock.calls[0]![1]).toEqual({
    error: { code: "PROVIDER_INVALID_PAYLOAD", detail: "bad geocoding" },
  });
});
