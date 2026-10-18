import { z } from "zod";
import { Config } from "./config";
import { ApiError, invalidProviderPayload } from "./errors";
import { Geo, geoSchema, Store, Weather } from "./types";
const payloadSchema = z.object({
  name: z.string().optional(),
  sys: z
    .object({ country: z.string().regex(/^[A-Z]{2}$/).optional() })
    .optional(),
  main: z.object({
    temp: z.number().finite(),
    humidity: z.number().min(0).max(100),
  }),
  weather: z.array(z.object({ description: z.string().min(1) })).min(1),
  dt: z.number().int().min(0).max(8640000000000),
});
export const candidateSchema = geoSchema.extend({
  name: z.string().min(1),
  country: z
    .union([z.string().regex(/^[A-Z]{2}$/), z.literal("")])
    .default(""),
  state: z.string().optional(),
  local_names: z.record(z.string(), z.string()).optional(),
});
export type Candidate = z.infer<typeof candidateSchema>;
export class Provider {
  constructor(
    private store: Store,
    private cfg: Config,
    private fetcher: typeof fetch = fetch,
    private sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    private random = Math.random,
    private now = Date.now,
    private beforeAttempt: () => Promise<void> = async () => {},
  ) {}
  private async request(
    path: string,
    parameters: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(this.cfg.PROVIDER_BASE_URL.replace(/\/$/, "") + path);
    url.search = new URLSearchParams({
      ...parameters,
      appid: this.cfg.OPENWEATHER_API_KEY,
    }).toString();
    for (let attempt = 0; ; attempt++) {
      await this.beforeAttempt();
      await this.store.reserve();
      let retry: ApiError;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        this.cfg.PROVIDER_TIMEOUT_MS,
      );
      try {
        const response = await this.fetcher(url, { signal: controller.signal });
        // Release unused error bodies so repeated failures do not hold sockets.
        if (!response.ok) await response.body?.cancel().catch(() => {});
        if (response.status === 429) {
          const header = response.headers.get("retry-after");
          const parsed =
            header && /^\d+$/.test(header)
              ? Number(header)
              : header
                ? Math.ceil((Date.parse(header) - this.now()) / 1000)
                : NaN;
          const seconds = Number.isSafeInteger(parsed)
            ? Math.max(1, parsed)
            : 600;
          await this.store.cooldown(seconds);
          throw new ApiError(
            429,
            "PROVIDER_QUOTA_EXCEEDED",
            "OpenWeather call limit reached.",
            seconds,
          );
        }
        if (response.status === 401 || response.status === 403)
          throw new ApiError(
            502,
            "PROVIDER_AUTH_ERROR",
            "OpenWeather authentication failed.",
          );
        if (response.status === 404)
          throw new ApiError(404, "CITY_NOT_FOUND", "City not found.");
        if ([500, 502, 503, 504].includes(response.status))
          retry = new ApiError(
            502,
            "PROVIDER_FAILURE",
            "OpenWeather is unavailable.",
          );
        else {
          if (!response.ok)
            throw new ApiError(
              502,
              "PROVIDER_FAILURE",
              "OpenWeather request failed.",
            );
          try {
            return await response.json();
          } catch {
            if (controller.signal.aborted)
              throw new ApiError(
                504,
                "PROVIDER_TIMEOUT",
                "OpenWeather request timed out.",
              );
            throw invalidProviderPayload("Invalid OpenWeather response.");
          }
        }
      } catch (e) {
        if (e instanceof ApiError) {
          if (e.code !== "PROVIDER_TIMEOUT") throw e;
          retry = e;
        } else
          retry = controller.signal.aborted
            ? new ApiError(
                504,
                "PROVIDER_TIMEOUT",
                "OpenWeather request timed out.",
              )
            : new ApiError(
                502,
                "PROVIDER_FAILURE",
                "OpenWeather network failure.",
              );
      } finally {
        clearTimeout(timer);
      }
      if (attempt >= this.cfg.PROVIDER_MAX_RETRIES) throw retry;
      await this.sleep(100 * 2 ** attempt + Math.floor(this.random() * 100));
    }
  }
  async geocodeCandidates(
    city: string,
    limit: 1 | 5 = 5,
  ): Promise<Candidate[]> {
    const parsed = z
      .array(candidateSchema)
      .max(5)
      .safeParse(
        await this.request("/geo/1.0/direct", {
          q: city,
          limit: String(limit),
        }),
      );
    if (!parsed.success)
      throw new ApiError(
        502,
        "PROVIDER_INVALID_PAYLOAD",
        "Invalid OpenWeather geocoding response.",
      );
    return parsed.data;
  }
  async geocode(city: string): Promise<Geo> {
    const raw = await this.request("/geo/1.0/direct", { q: city, limit: "1" });
    if (Array.isArray(raw) && raw.length === 0)
      throw new ApiError(404, "CITY_NOT_FOUND", "City not found.");
    const parsed = z.array(geoSchema).min(1).safeParse(raw);
    if (!parsed.success)
      throw invalidProviderPayload("Invalid OpenWeather geocoding response.");
    return parsed.data[0]!;
  }
  async weather(
    geo: Geo,
    location?: { name: string; country: string },
  ): Promise<Weather> {
    const parsed = payloadSchema.safeParse(
      await this.request("/data/2.5/weather", {
        lat: String(geo.lat),
        lon: String(geo.lon),
        units: "metric",
      }),
    );
    if (!parsed.success)
      throw invalidProviderPayload("Invalid OpenWeather weather response.");
    const p = parsed.data;
    const city = location?.name ?? p.name;
    const country = location?.country ?? p.sys?.country;
    if (
      !city?.trim() ||
      !country ||
      (location && p.sys?.country && p.sys.country !== location.country)
    )
      throw invalidProviderPayload("Invalid OpenWeather weather location metadata.");
    return {
      city,
      country,
      temperature_celsius: p.main.temp,
      condition: p.weather[0]!.description,
      humidity_percent: p.main.humidity,
      observed_at: new Date(p.dt * 1000).toISOString(),
    };
  }
}
