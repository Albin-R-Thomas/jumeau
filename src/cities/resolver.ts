import {
  City,
  CityAlias,
  Prisma,
  PrismaClient,
  ResolutionPolicy,
} from "@prisma/client";
import Redis from "ioredis";
import countries from "i18n-iso-countries";
import { Provider, Candidate } from "../provider";
import { ApiError } from "../errors";
import { normalize, queryHash } from "./normalization";
import { Config } from "../config";

const states = Object.fromEntries(
  "AL:Alabama|AK:Alaska|AZ:Arizona|AR:Arkansas|CA:California|CO:Colorado|CT:Connecticut|DE:Delaware|DC:District of Columbia|FL:Florida|GA:Georgia|HI:Hawaii|ID:Idaho|IL:Illinois|IN:Indiana|IA:Iowa|KS:Kansas|KY:Kentucky|LA:Louisiana|ME:Maine|MD:Maryland|MA:Massachusetts|MI:Michigan|MN:Minnesota|MS:Mississippi|MO:Missouri|MT:Montana|NE:Nebraska|NV:Nevada|NH:New Hampshire|NJ:New Jersey|NM:New Mexico|NY:New York|NC:North Carolina|ND:North Dakota|OH:Ohio|OK:Oklahoma|OR:Oregon|PA:Pennsylvania|RI:Rhode Island|SC:South Carolina|SD:South Dakota|TN:Tennessee|TX:Texas|UT:Utah|VT:Vermont|VA:Virginia|WA:Washington|WV:West Virginia|WI:Wisconsin|WY:Wyoming|AS:American Samoa|GU:Guam|MP:Northern Mariana Islands|PR:Puerto Rico|VI:United States Virgin Islands"
    .split("|")
    .map((s) => s.split(":")),
);
export const stateCode = (s?: string) =>
  s
    ? Object.keys(states).find(
        (k) => k === s.toUpperCase() || normalize(states[k]!) === normalize(s),
      )
    : undefined;
export function bulkGrammar(query: string) {
  const q = normalize(query),
    parts = q.split(",");
  const country = parts.length > 1 ? parts.at(-1)!.toUpperCase() : undefined;
  const state = parts.length === 3 ? parts[1]!.toUpperCase() : undefined;
  if (
    !q ||
    [...q].length > 200 ||
    /[\x00-\x1f\x7f-\x9f]/.test(query) ||
    parts.some((p) => !p) ||
    parts.length > 3 ||
    (country && !countries.isValid(country)) ||
    (state && (country !== "US" || !states[state]))
  )
    throw new ApiError(
      400,
      "INVALID_CITY_SYNTAX",
      "Use city, city,CC, or city,STATE,US with valid codes.",
    );
  return { city: parts[0]!, country, state };
}
export type VerifiedAlias = CityAlias & { city: City | null };
const signature = (c: Candidate) =>
  JSON.stringify([
    c.country.toUpperCase(),
    stateCode(c.state) ?? normalize(c.state ?? ""),
    String(c.lat === 0 ? 0 : c.lat),
    String(c.lon === 0 ? 0 : c.lon),
  ]);
const review = () =>
  new ApiError(
    503,
    "IDENTITY_REVIEW_REQUIRED",
    "Provider identity changed; repair the alias mapping locally.",
  );
export class CityResolver {
  constructor(
    public db: PrismaClient,
    private redis: Redis,
    private provider: Pick<Provider, "geocodeCandidates">,
    private cfg: Config,
    private now = Date.now,
  ) {}
  key(query: string, policy: ResolutionPolicy) {
    return `cityweather:geo:v2:alias:${policy}:1:${queryHash(query)}`;
  }
  async mirror(alias: VerifiedAlias) {
    if (!alias.city) return;
    const write = `local old=redis.call('GET',KEYS[1]); if old then local ok,v=pcall(cjson.decode,old); if ok and (tonumber(v.version or 0)>tonumber(ARGV[2]) or (tonumber(v.version or 0)==tonumber(ARGV[2]) and tonumber(v.city_version or 0)>tonumber(ARGV[3]))) then return 0 end end; redis.call('SET',KEYS[1],ARGV[1]); return 1`;
    const payload = JSON.stringify({
      ...alias,
      city_version: alias.city.verification_version,
      city: {
        ...alias.city,
        lat: Number(alias.city.lat),
        lon: Number(alias.city.lon),
      },
    });
    await this.redis.eval(
      write,
      1,
      this.key(alias.normalized_query, alias.resolution_policy),
      payload,
      alias.version,
      alias.city.verification_version,
    );
    await this.redis.eval(
      write,
      1,
      `cityweather:geo:v2:place:${alias.city.id}`,
      JSON.stringify({
        ...alias.city,
        version: alias.city.verification_version,
      }),
      alias.city.verification_version,
      alias.city.verification_version,
    );
  }
  async lookup(
    query: string,
    policy: ResolutionPolicy,
  ): Promise<VerifiedAlias | null> {
    // DB version fences old rebuilds and invalidations, including after Redis-only loss.
    const alias = await this.db.cityAlias.findUnique({
      where: {
        normalization_version_normalized_query_resolution_policy: {
          normalization_version: 1,
          normalized_query: normalize(query),
          resolution_policy: policy,
        },
      },
      include: { city: true },
    });
    if (alias?.verification_status === "review_required") throw review();
    if (alias?.city && alias.verification_status === "verified") {
      try {
        const indexed = await this.redis.get(this.key(query, policy));
        if (
          !indexed ||
          JSON.parse(indexed).version !== alias.version ||
          JSON.parse(indexed).city_version !== alias.city.verification_version
        )
          await this.mirror(alias);
      } catch {
        await this.mirror(alias).catch(() => {});
      }
      return alias;
    }
    return null;
  }
  async resolve(
    query: string,
    policy: ResolutionPolicy,
    old?: VerifiedAlias | null,
  ): Promise<VerifiedAlias> {
    const strict = policy === "bulk_unambiguous";
    const grammar = strict ? bulkGrammar(query) : null;
    let candidates = await this.provider.geocodeCandidates(
      query,
      strict ? 5 : 1,
    );
    // Unknown countries remain candidates: never silently discard ambiguity.
    if (grammar?.country && candidates.some((c) => !c.country))
      throw new ApiError(
        400,
        "CITY_QUALIFICATION_UNVERIFIABLE",
        "Provider did not return country metadata for all candidate locations.",
      );
    if (grammar?.country)
      candidates = candidates.filter((c) => c.country === grammar.country);
    if (grammar?.state) {
      if (candidates.some((c) => !c.state))
        throw new ApiError(
          400,
          "CITY_QUALIFICATION_UNVERIFIABLE",
          "Provider did not return the requested state metadata.",
        );
      candidates = candidates.filter(
        (c) => stateCode(c.state) === grammar.state,
      );
    }
    candidates = [
      ...new Map(candidates.map((c) => [signature(c), c])).values(),
    ];
    if (!candidates.length)
      throw new ApiError(
        404,
        "CITY_NOT_FOUND",
        "City not found for the supplied qualification.",
      );
    if (strict && candidates.length > 1)
      throw new ApiError(
        400,
        "CITY_AMBIGUOUS",
        "Multiple weather locations match; qualify the city.",
        undefined,
        {
          suggestions: candidates
            .slice(0, 5)
            .map((c) =>
              [
                c.name,
                c.country === "US" ? stateCode(c.state) : null,
                c.country,
              ]
                .filter(Boolean)
                .join(","),
            ),
        },
      );
    const chosen = candidates[0]!,
      sig = signature(chosen),
      normalized = normalize(query);
    if (!chosen.country)
      throw new ApiError(
        400,
        "CITY_QUALIFICATION_UNVERIFIABLE",
        "Provider did not return country metadata for the selected location.",
      );
    const alias = await this.db
      .$transaction(async (tx) => {
        // Stable lock order serializes aliases for the same exact identity; no network in tx.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${sig}))`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${policy + ":" + normalized}))`;
        const current = await tx.cityAlias.findUnique({
          where: {
            normalization_version_normalized_query_resolution_policy: {
              normalization_version: 1,
              normalized_query: normalized,
              resolution_policy: policy,
            },
          },
          include: { city: true },
        });
        if (old && current && current.version !== old.version) return current;
        const identity = await tx.placeIdentityKey.findUnique({
          where: {
            provider_signature_version_signature: {
              provider: "openweather",
              signature_version: 1,
              signature: sig,
            },
          },
          include: { city: true },
        });
        let city = identity?.city;
        let moved = false;
        if (current?.city) {
          const previous = current.city;
          if (identity && identity.city_id !== previous.id) throw review();
          if (
            normalize(previous.name) !== normalize(chosen.name) ||
            previous.country !== chosen.country ||
            (stateCode(previous.state ?? undefined) ??
              normalize(previous.state ?? "")) !==
              (stateCode(chosen.state) ?? normalize(chosen.state ?? ""))
          )
            throw review();
          moved =
            Number(previous.lat) !== chosen.lat ||
            Number(previous.lon) !== chosen.lon;
          city = await tx.city.update({
            where: { id: previous.id },
            data: {
              lat: chosen.lat,
              lon: chosen.lon,
              verified_at: new Date(this.now()),
              ...(moved ? { verification_version: { increment: 1 } } : {}),
            },
          });
        }
        if (!city)
          city = await tx.city.create({
            data: {
              name: chosen.name,
              country: chosen.country,
              state: chosen.state,
              lat: chosen.lat,
              lon: chosen.lon,
              verified_at: new Date(this.now()),
            },
          });
        if (!identity)
          await tx.placeIdentityKey.create({
            data: { signature: sig, city_id: city.id },
          });
        const verified = new Date(this.now());
        const data = {
          display_query: query,
          city_id: city.id,
          verified_at: verified,
          revalidate_after: new Date(
            verified.getTime() + this.cfg.GEO_REVERIFY_DAYS * 86400000,
          ),
          verification_status: "verified",
          metadata: {
            selected: chosen,
            candidate_signatures: candidates.map(signature),
            coordinates_changed: moved,
          } as Prisma.InputJsonValue,
          last_error: Prisma.DbNull,
        };
        return tx.cityAlias.upsert({
          where: {
            normalization_version_normalized_query_resolution_policy: {
              normalization_version: 1,
              normalized_query: normalized,
              resolution_policy: policy,
            },
          },
          create: {
            normalization_version: 1,
            normalized_query: normalized,
            resolution_policy: policy,
            ...data,
          },
          update: { ...data, version: { increment: 1 } },
          include: { city: true },
        });
      })
      .catch(async (error: unknown) => {
        if (
          error instanceof ApiError &&
          error.code === "IDENTITY_REVIEW_REQUIRED"
        ) {
          await this.db.cityAlias.updateMany({
            where: {
              normalized_query: normalized,
              resolution_policy: policy,
              ...(old ? { version: old.version } : {}),
            },
            data: {
              verification_status: "review_required",
              version: { increment: 1 },
              last_error: { code: error.code, detail: error.message },
            },
          });
        }
        throw error;
      });
    if (!alias.city || alias.verification_status !== "verified") throw review();
    // DB is authoritative. Versioned envelope rejects cache from previous coordinates.
    await this.mirror(alias).catch(() => {});
    return alias;
  }
  async scheduleRevalidation(alias: VerifiedAlias) {
    if (
      !alias.revalidate_after ||
      alias.revalidate_after.getTime() > this.now()
    )
      return;
    await this.db.bulkDispatch.upsert({
      where: {
        alias_id_generation: { alias_id: alias.id, generation: alias.version },
      },
      create: {
        alias_id: alias.id,
        kind: "revalidate-alias",
        generation: alias.version,
      },
      update: {},
    });
  }
  async rebuild() {
    let after: string | undefined,
      count = 0;
    for (;;) {
      const page: VerifiedAlias[] = await this.db.cityAlias.findMany({
        where: {
          ...(after ? { id: { gt: after } } : {}),
          verification_status: "verified",
          city_id: { not: null },
        },
        include: { city: true },
        orderBy: { id: "asc" },
        take: 500,
      });
      for (const alias of page) {
        await this.mirror(alias);
        count++;
      }
      if (page.length < 500) break;
      after = page.at(-1)!.id;
    }
    return count;
  }
}
