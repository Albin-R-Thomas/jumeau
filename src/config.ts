import { z } from "zod";
const positive = (value: number, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(1).max(max).default(value);
const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("production"),
    PORT: positive(3000, 65535),
    API_KEY: z.string().min(1),
    OPENWEATHER_API_KEY: z.string().min(1),
    DATABASE_URL: z
      .string()
      .url()
      .refine((v) => /^postgres(ql)?:/.test(v)),
    REDIS_URL: z
      .string()
      .url()
      .refine((v) => /^rediss?:/.test(v)),
    WEATHER_CACHE_TTL_SECONDS: positive(900),
    PROVIDER_TIMEOUT_MS: positive(5000, 60000),
    PROVIDER_MAX_RETRIES: z.coerce.number().int().min(0).max(2).default(2),
    PROVIDER_CALLS_PER_MINUTE: positive(55, 60),
    PROVIDER_CALLS_PER_MONTH: positive(900000, 1000000),
    BULK_UPLOAD_MAX_BYTES: positive(10485760, 10485760),
    BULK_UPLOAD_MAX_ROWS: positive(100000, 100000),
    BULK_CITY_MAX_CODEPOINTS: positive(200, 200),
    BULK_UPLOAD_TIMEOUT_MS: positive(120000, 600000),
    BULK_STAGING_DIR: z
      .string()
      .min(1)
      .default(
        process.platform === "win32"
          ? "C:/Code/jumeau/.uploads"
          : "/tmp/cityweather-uploads",
      ),
    BULK_DB_BATCH_SIZE: positive(500, 500),
    BULK_DISPATCH_BATCH_SIZE: positive(500, 500),
    BULK_WORKER_CONCURRENCY: positive(5, 100),
    BULK_RECONCILE_INTERVAL_MS: positive(5000, 60000),
    BULK_LEASE_SECONDS: positive(90, 600),
    BULK_LEASE_HEARTBEAT_SECONDS: positive(15, 60),
    BULK_PENDING_BACKOFF_MAX_SECONDS: positive(300, 300),
    BULK_RETENTION_DAYS: positive(30, 30),
    GEO_REVERIFY_DAYS: positive(30, 30),
    PROVIDER_CONFIG_REVISION: z.string().min(1).max(100).default("initial"),
    BULK_CURSOR_VERSION: z.coerce.number().int().min(1).max(1).default(1),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.BULK_LEASE_HEARTBEAT_SECONDS * 2 >= cfg.BULK_LEASE_SECONDS)
      ctx.addIssue({
        code: "custom",
        path: ["BULK_LEASE_SECONDS"],
        message: "Lease must exceed two heartbeat intervals.",
      });
  });
export type Config = z.infer<typeof schema>;
export function config(env: NodeJS.ProcessEnv): Config {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      "Invalid configuration fields: " +
        result.error.issues.map((i) => i.path.join(".")).join(", "),
    );
  return result.data;
}
