import { config } from "../src/config";
import { Store, Weather } from "../src/types";
export const cfg = config({
  API_KEY: "test-placeholder",
  OPENWEATHER_API_KEY: "provider-placeholder",
  DATABASE_URL: "postgresql://test:test@localhost/test",
  REDIS_URL: "redis://localhost:6379",
});
export const weather: Weather = {
  city: "London",
  country: "GB",
  temperature_celsius: 18.5,
  condition: "clouds",
  humidity_percent: 72,
  observed_at: "2026-10-14T08:00:00.000Z",
};
export const payload = {
  name: "London",
  sys: { country: "GB" },
  main: { temp: 18.5, humidity: 72 },
  weather: [{ description: "clouds" }],
  dt: 1791964800,
};
export function mockStore(): jest.Mocked<Store> {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    reserve: jest.fn().mockResolvedValue(undefined),
    cooldown: jest.fn().mockResolvedValue(undefined),
  };
}
export const response = (
  status: number,
  body: unknown,
  headers?: HeadersInit,
) => new Response(JSON.stringify(body), { status, headers });
