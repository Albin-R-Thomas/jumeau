import Redis from "ioredis";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Provider } from "./provider";
import { ApiError, unavailable } from "./errors";
import { Weather, Source, weatherSchema, geoSchema } from "./types";
import { CityResolver, VerifiedAlias, bulkGrammar } from "./cities/resolver";

const envelopeSchema = z.object({
  weather: weatherSchema,
  source: z.enum(["provider", "cache"]),
  fetched_at: z.number().finite(),
  fresh_until: z.number().finite(),
  backup_until: z.number().finite(),
  verification_version: z.number().int(),
});
export type WeatherSnapshot = z.infer<typeof envelopeSchema>;
export type FetchOutcome =
  | { kind: "fresh"; snapshot: WeatherSnapshot }
  | { kind: "deferred"; error: ApiError; provisional?: WeatherSnapshot };
export const fallbackCodes = new Set([
  "LOCAL_QUOTA_EXCEEDED",
  "PROVIDER_QUOTA_EXCEEDED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_FAILURE",
  "PROVIDER_INVALID_PAYLOAD",
  "QUOTA_RECOVERY_HOLD",
]);
export class WeatherFetcher {
  private pending = new Map<string, Promise<WeatherSnapshot>>();
  constructor(
    private redis: Redis,
    public resolver: CityResolver,
    private provider: Pick<Provider, "weather">,
    private now = Date.now,
  ) {}
  key(id: string, fresh = true) {
    return `cityweather:weather:v3:${fresh ? "fresh" : "backup"}:place:${id}`;
  }
  async cached(
    alias: VerifiedAlias,
    fresh = true,
  ): Promise<WeatherSnapshot | undefined> {
    if (!alias.city || alias.verification_status !== "verified") return;
    const raw = await this.redis.get(this.key(alias.city.id, fresh));
    if (!raw) return;
    try {
      const value = envelopeSchema.parse(JSON.parse(raw));
      if (
        value.verification_version !== alias.city.verification_version ||
        (fresh ? value.fresh_until : value.backup_until) <= this.now()
      )
        return;
      return { ...value, source: "cache" };
    } catch {
      return;
    }
  }
  async write(alias: VerifiedAlias, snapshot: WeatherSnapshot) {
    const script = `local now=redis.call('TIME'); local ms=tonumber(now[1])*1000+math.floor(tonumber(now[2])/1000); local ttl=tonumber(ARGV[2])-ms; if ttl<=0 then return 0 end; local old=redis.call('GET',KEYS[1]); if old then local ok,v=pcall(cjson.decode,old); if ok and (tonumber(v.verification_version or 0)>tonumber(ARGV[4]) or (tonumber(v.verification_version or 0)==tonumber(ARGV[4]) and tonumber(v.fetched_at or 0)>tonumber(ARGV[3]))) then return 0 end end; redis.call('PSETEX',KEYS[1],math.floor(ttl),ARGV[1]); return 1`;
    const serialized = JSON.stringify(snapshot);
    await this.redis.eval(
      script,
      1,
      this.key(alias.city!.id, false),
      serialized,
      snapshot.backup_until,
      snapshot.fetched_at,
      snapshot.verification_version,
    );
    await this.redis.eval(
      script,
      1,
      this.key(alias.city!.id),
      serialized,
      snapshot.fresh_until,
      snapshot.fetched_at,
      snapshot.verification_version,
    );
  }
  async fetch(alias: VerifiedAlias): Promise<WeatherSnapshot> {
    const hit = await this.cached(alias);
    if (hit) return hit;
    const key = `${alias.city!.id}:${alias.city!.verification_version}`;
    let work = this.pending.get(key);
    if (!work) {
      work = (async () => {
        const weather = await this.provider.weather({
          lat: Number(alias.city!.lat),
          lon: Number(alias.city!.lon),
        });
        const fetched_at = this.now();
        const snapshot: WeatherSnapshot = {
          weather,
          source: "provider",
          fetched_at,
          fresh_until: fetched_at + 900000,
          backup_until: fetched_at + 86400000,
          verification_version: alias.city!.verification_version,
        };
        await this.write(alias, snapshot);
        return snapshot;
      })();
      this.pending.set(key, work);
    }
    try {
      return await work;
    } finally {
      if (this.pending.get(key) === work) this.pending.delete(key);
    }
  }
  private async compatibleLegacy(query: string, alias: VerifiedAlias) {
    const key = createHash("sha256").update(query.toLowerCase()).digest("hex");
    const raw = await this.redis.get("cityweather:geo:" + key);
    if (!raw || !alias.city) return;
    try {
      const geo = geoSchema.parse(JSON.parse(raw));
      if (
        geo.lat !== Number(alias.city.lat) ||
        geo.lon !== Number(alias.city.lon)
      )
        return;
      const fresh = await this.legacy(query, true);
      if (!fresh || fresh.weather.country !== alias.city.country) return;
      const backup = await this.legacy(query, false);
      const snapshot = {
        ...fresh,
        backup_until: Math.min(
          fresh.backup_until,
          backup?.backup_until ?? fresh.fresh_until,
        ),
        verification_version: alias.city.verification_version,
      };
      await this.write(alias, snapshot);
      return snapshot;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      return;
    }
  }
  async bulk(
    query: string,
    bind: (id: string) => Promise<boolean>,
  ): Promise<FetchOutcome | null> {
    bulkGrammar(query);
    let alias = await this.resolver.lookup(query, "bulk_unambiguous");
    let backup: WeatherSnapshot | undefined;
    try {
      if (alias) {
        const hit = await this.cached(alias);
        if (hit) {
          if (!(await bind(alias.city_id!))) return null;
          await this.resolver.scheduleRevalidation(alias);
          return { kind: "fresh", snapshot: hit };
        }
        backup = await this.cached(alias, false);
      }
      if (
        !alias ||
        !alias.revalidate_after ||
        alias.revalidate_after.getTime() <= this.now()
      )
        alias = await this.resolver.resolve(query, "bulk_unambiguous", alias);
      backup = (await this.cached(alias, false)) ?? backup;
      if (!(await bind(alias.city_id!))) return null;
      const compatible = await this.compatibleLegacy(query, alias);
      if (compatible) return { kind: "fresh", snapshot: compatible };
      return { kind: "fresh", snapshot: await this.fetch(alias) };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const permanent = new Set([
        "INVALID_CITY_SYNTAX",
        "CITY_NOT_FOUND",
        "CITY_AMBIGUOUS",
        "CITY_QUALIFICATION_UNVERIFIABLE",
      ]);
      if (permanent.has(error.code)) throw error;
      return {
        kind: "deferred",
        error,
        ...(backup && backup.backup_until > this.now()
          ? { provisional: backup }
          : {}),
      };
    }
  }
  private async legacy(
    query: string,
    fresh: boolean,
  ): Promise<WeatherSnapshot | undefined> {
    const key = createHash("sha256").update(query.toLowerCase()).digest("hex");
    const k = `cityweather:weather:v2:${fresh ? "fresh" : "stale"}:${key}`;
    const [raw, ttl] = (await this.redis.multi().get(k).pttl(k).exec()) ?? [];
    if (
      !raw ||
      raw[0] ||
      typeof raw[1] !== "string" ||
      !ttl ||
      typeof ttl[1] !== "number" ||
      ttl[1] <= 0
    )
      return;
    try {
      const remaining = ttl[1];
      const fetched_at = this.now() + remaining - (fresh ? 900000 : 86400000);
      return {
        weather: weatherSchema.parse(JSON.parse(raw[1])),
        source: "cache",
        fetched_at,
        fresh_until: fetched_at + 900000,
        backup_until: fetched_at + 86400000,
        verification_version: 0,
      };
    } catch {
      return;
    }
  }
  async http(query: string): Promise<{ weather: Weather; source: Source }> {
    try {
      return await this.httpLoad(query);
    } catch (error) {
      if (!(error instanceof ApiError)) throw unavailable();
      if (error.code === "PROVIDER_INVALID_PAYLOAD")
        throw new ApiError(
          502,
          "PROVIDER_FAILURE",
          "Invalid OpenWeather response.",
        );
      throw error;
    }
  }
  private async httpLoad(
    query: string,
  ): Promise<{ weather: Weather; source: Source }> {
    const legacy = await this.legacy(query, true);
    if (legacy) return legacy;
    // Strictly certified aliases are safe for HTTP reuse; HTTP first-match never certifies bulk.
    let alias =
      (await this.resolver.lookup(query, "http_first_match")) ??
      (await this.resolver.lookup(query, "bulk_unambiguous"));
    try {
      if (alias) {
        const hit = await this.cached(alias);
        if (hit) {
          await this.resolver.scheduleRevalidation(alias);
          return hit;
        }
      }
      if (
        !alias ||
        !alias.revalidate_after ||
        alias.revalidate_after.getTime() <= this.now()
      )
        alias = await this.resolver.resolve(
          query,
          "http_first_match",
          alias?.resolution_policy === "http_first_match" ? alias : undefined,
        );
      return await this.fetch(alias);
    } catch (error) {
      if (error instanceof ApiError && fallbackCodes.has(error.code)) {
        const backup =
          (alias ? await this.cached(alias, false) : undefined) ??
          (await this.legacy(query, false));
        if (backup) return backup;
      }
      throw error;
    }
  }
}
