import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { Config } from "./config";
import { ApiError } from "./errors";
const marker = "cityweather:quota-continuity:v1";
export class QuotaGuard {
  constructor(
    private db: PrismaClient,
    private redis: Redis,
    private cfg: Config,
  ) {}
  async beforeAttempt() {
    const result = await this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('cityweather-account-guard'))`;
        const now = (
          await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
        )[0]!.now;
        let guard = await tx.quotaSafetyGuard.findUnique({
          where: { scope: "openweather" },
        });
        if (!guard)
          guard = await tx.quotaSafetyGuard.create({
            data: {
              scope: "openweather",
              token: randomUUID(),
              minute_budget: this.cfg.PROVIDER_CALLS_PER_MINUTE,
              month_budget: this.cfg.PROVIDER_CALLS_PER_MONTH,
            },
          });
        if (
          guard.minute_budget !== this.cfg.PROVIDER_CALLS_PER_MINUTE ||
          guard.month_budget !== this.cfg.PROVIDER_CALLS_PER_MONTH
        )
          return new ApiError(
            503,
            "QUOTA_CONFIGURATION_CONFLICT",
            "API and worker quota budgets must match the durable account configuration.",
          );
        const existing = await this.redis.get(marker);
        if (
          guard.initialized &&
          existing !== guard.token &&
          guard.last_intent_at
        ) {
          const hold = new Date(guard.last_intent_at.getTime() + 2678400000);
          if (hold > now)
            guard = await tx.quotaSafetyGuard.update({
              where: { scope: guard.scope },
              data: { hold_until: hold },
            });
        }
        // Initial rollout adopts the pre-existing quota namespace without deleting it.
        if (existing !== guard.token) await this.redis.set(marker, guard.token);
        await tx.quotaSafetyGuard.update({
          where: { scope: guard.scope },
          data: { initialized: true },
        });
        if (guard.hold_until && guard.hold_until > now)
          return new ApiError(
            429,
            "QUOTA_RECOVERY_HOLD",
            "Quota ledger continuity was lost; conservative rolling-window recovery hold is active.",
            Math.ceil((guard.hold_until.getTime() - now.getTime()) / 1000),
          );
        if (guard.blocked_revision === this.cfg.PROVIDER_CONFIG_REVISION)
          return new ApiError(
            502,
            "PROVIDER_AUTH_ERROR",
            "Provider configuration repair is required.",
          );
        await tx.quotaSafetyGuard.update({
          where: { scope: guard.scope },
          data: { last_intent_at: now, hold_until: null },
        });
        return null;
      },
      { timeout: 10000 },
    );
    if (result) throw result;
  }
  async blockAuth() {
    await this.db.quotaSafetyGuard.updateMany({
      where: { scope: "openweather" },
      data: {
        blocked_revision: this.cfg.PROVIDER_CONFIG_REVISION,
        blocked_reason: "PROVIDER_AUTH_ERROR",
      },
    });
  }
  async clearAuth() {
    await this.db.quotaSafetyGuard.updateMany({
      where: {
        scope: "openweather",
        blocked_revision: { not: this.cfg.PROVIDER_CONFIG_REVISION },
      },
      data: { blocked_revision: null, blocked_reason: null },
    });
  }
}
