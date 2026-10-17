import { createHash } from "node:crypto";
import { Provider } from "./provider";
import { ApiError } from "./errors";
import {
  geoSchema,
  History,
  Source,
  Store,
  Weather,
  weatherSchema,
} from "./types";
export const STALE_RETENTION_SECONDS = 86400;
const fallbackCodes = new Set([
  "LOCAL_QUOTA_EXCEEDED",
  "PROVIDER_QUOTA_EXCEEDED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_FAILURE",
]);
export class WeatherService {
  private pending = new Map<
    string,
    Promise<{ weather: Weather; source: Source }>
  >();
  constructor(
    private store: Store,
    private provider: Pick<Provider, "geocode" | "weather">,
    private history: History,
    private ttl: number,
    private shared?: {
      http(city: string): Promise<{ weather: Weather; source: Source }>;
    },
  ) {}
  private async load(
    city: string,
    key: string,
  ): Promise<{ weather: Weather; source: Source }> {
    // New namespace prevents old 122-minute entries from remaining fresh after rollout.
    const freshKey = "weather:v2:fresh:" + key;
    const staleKey = "weather:v2:stale:" + key;
    const cached = await this.store.get(freshKey);
    if (cached) {
      try {
        return {
          weather: weatherSchema.parse(JSON.parse(cached)),
          source: "cache",
        };
      } catch {
        /* corrupt entries are misses */
      }
    }
    let weather: Weather;
    try {
      const rawGeo = await this.store.get("geo:" + key);
      let geo;
      if (rawGeo) {
        try {
          geo = geoSchema.parse(JSON.parse(rawGeo));
        } catch {
          /* refetch */
        }
      }
      if (!geo) {
        geo = await this.provider.geocode(city);
        await this.store.set("geo:" + key, JSON.stringify(geo), 30 * 86400);
      }
      weather = await this.provider.weather(geo);
    } catch (error) {
      if (error instanceof ApiError && fallbackCodes.has(error.code)) {
        const stale = await this.store.get(staleKey);
        if (stale) {
          const parsed = weatherSchema.safeParse(
            (() => {
              try {
                return JSON.parse(stale);
              } catch {
                return null;
              }
            })(),
          );
          if (parsed.success) return { weather: parsed.data, source: "cache" };
        }
      }
      throw error;
    }
    // Reads and fallback never extend freshness or backup retention.
    const serialized = JSON.stringify(weather);
    await this.store.set(
      staleKey,
      serialized,
      Math.max(this.ttl, STALE_RETENTION_SECONDS),
    );
    await this.store.set(freshKey, serialized, this.ttl);
    return { weather, source: "provider" };
  }
  async get(city: string): Promise<Weather> {
    const key = createHash("sha256").update(city.toLowerCase()).digest("hex");
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.shared ? this.shared.http(city) : this.load(city, key);
      this.pending.set(key, pending);
    }
    let result;
    try {
      result = await pending;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
    await this.history.record(result.weather.city, result.source);
    return result.weather;
  }
}
