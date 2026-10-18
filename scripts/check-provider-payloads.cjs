// Run after npm run build and starting provider-payloads.sim.yaml.
const assert = require("node:assert/strict");
const { Provider } = require("../dist/src/provider");
const { CityResolver } = require("../dist/src/cities/resolver");
const { WeatherFetcher } = require("../dist/src/weather-fetch");
const { config } = require("../dist/src/config");
const cfg = config({
  API_KEY: "test", OPENWEATHER_API_KEY: "simulation-placeholder",
  DATABASE_URL: "postgresql://test:test@localhost/test", REDIS_URL: "redis://localhost:6379",
  PROVIDER_BASE_URL: "http://127.0.0.1:4900/openweather",
});
const provider = new Provider({ reserve: async () => {}, cooldown: async () => {} }, cfg);
const redis = { get: async () => null, eval: async () => 1 };
const resolver = new CityResolver({}, redis, provider, cfg);
(async () => {
  for (const city of ["Ifo", "Smolensk"])
    await assert.rejects(resolver.resolve(city, "bulk_unambiguous"), { code: "CITY_AMBIGUOUS" });
  await assert.rejects(resolver.resolve("Ifo,NG", "bulk_unambiguous"), {
    code: "CITY_QUALIFICATION_UNVERIFIABLE",
  });
  const fetcher = new WeatherFetcher(redis, resolver, provider);
  for (const [name, country, lat, lon] of [
    ["Tangará da Serra", "BR", -14.6214, -57.4907],
    ["Cafunfo", "AO", -8.7677, 18.0014],
  ]) {
    const snapshot = await fetcher.fetch({
      verification_status: "verified",
      city: { id: name, name, country, lat, lon, verification_version: 1 },
    });
    assert.equal(snapshot.weather.city, name);
    assert.equal(snapshot.weather.country, country);
    assert.equal(snapshot.source, "provider");
  }
  console.log("PASS: ambiguous geocodes, unverifiable qualification, both weather metadata fallbacks over real HTTP");
})().catch(error => { console.error(error); process.exitCode = 1; });
