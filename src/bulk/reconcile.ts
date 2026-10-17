import { Prisma } from "@prisma/client";
import { BulkRepository } from "./repository";
import { BulkQueue, Delivery, deliveryId } from "./queue";
import { WeatherFetcher } from "../weather-fetch";
import { RedisStore } from "../store";
import { cleanupUploads } from "./admission";
import { bulkGrammar } from "../cities/resolver";

export class Reconciler {
  private running = false;
  constructor(
    private repo: BulkRepository,
    private queue: BulkQueue,
    private fetcher: WeatherFetcher,
    private store: RedisStore,
  ) {}
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.repo.recover();
      await this.unblockConfiguration();
      await this.plan();
      await this.deliver();
      await this.retention();
      await cleanupUploads(this.repo.cfg.BULK_STAGING_DIR);
    } finally {
      this.running = false;
    }
  }
  private async unblockConfiguration() {
    await this.repo.db.bulkResult.updateMany({
      where: {
        status: "pending",
        recovery_condition: {
          startsWith: "provider_configuration_repaired:",
          not: `provider_configuration_repaired:${this.repo.cfg.PROVIDER_CONFIG_REVISION}`,
        },
      },
      data: { recovery_condition: null, resume_at: null },
    });
  }
  private async plan() {
    const capacity = await this.store.inspect();
    let misses = capacity.available;
    const guard = await this.repo.db.quotaSafetyGuard.findUnique({
      where: { scope: "openweather" },
    });
    const blocked =
      guard?.blocked_revision === this.repo.cfg.PROVIDER_CONFIG_REVISION;
    const rows = await this.repo.db.$queryRaw<
      { id: string }[]
    >`SELECT r.id FROM "BulkResult" r JOIN "BulkJob" j ON j.job_id=r.job_id WHERE r.status='pending' AND r.recovery_condition IS NULL AND (r.resume_at IS NULL OR r.resume_at<=clock_timestamp()) AND j.admission_phase='ready' AND j.status NOT IN ('done','failed') ORDER BY r.resume_at NULLS FIRST,r.id LIMIT ${this.repo.cfg.BULK_DISPATCH_BATCH_SIZE}`;
    for (const { id } of rows) {
      const r = await this.repo.db.bulkResult.findUnique({ where: { id } });
      if (!r || r.status !== "pending") continue;
      let cached = false;
      try {
        bulkGrammar(r.display_city);
      } catch {
        cached = true;
      } // Local permanent failures need no provider capacity.
      if (!cached)
        try {
          const alias = await this.fetcher.resolver.lookup(
            r.display_city,
            "bulk_unambiguous",
          );
          cached = !!(alias && (await this.fetcher.cached(alias)));
        } catch {
          /* unknowns are misses */
        }
      if (
        !cached &&
        (blocked ||
          misses <= 0 ||
          (guard?.hold_until && guard.hold_until > new Date()))
      ) {
        const claim = await this.repo.claim(r.id, r.generation);
        if (!claim) continue;
        const hold =
          guard?.hold_until && guard.hold_until > new Date()
            ? guard.hold_until
            : null;
        await this.repo.finish(claim, {
          error: {
            code: blocked
              ? "PROVIDER_AUTH_ERROR"
              : hold
                ? "QUOTA_RECOVERY_HOLD"
                : capacity.reason === "cooldown"
                  ? "PROVIDER_QUOTA_EXCEEDED"
                  : "LOCAL_QUOTA_EXCEEDED",
            detail:
              "Waiting for shared account capacity or configuration repair.",
            ...(capacity.reason ? { window: capacity.reason } : {}),
          },
          ...(blocked
            ? {
                recovery_condition: `provider_configuration_repaired:${this.repo.cfg.PROVIDER_CONFIG_REVISION}`,
              }
            : {
                resume_at:
                  hold ?? new Date(capacity.resume_at ?? Date.now() + 5000),
              }),
        });
        continue;
      }
      if (!cached) misses--;
      await this.repo.db.bulkDispatch.upsert({
        where: {
          result_id_generation: { result_id: r.id, generation: r.generation },
        },
        create: {
          job_id: r.job_id,
          result_id: r.id,
          kind: "process-city",
          generation: r.generation,
          due_at: r.resume_at ?? new Date(),
        },
        update: {},
      });
    }
  }
  private async deliver() {
    const rows = await this.repo.db.bulkDispatch.findMany({
      where: {
        due_at: { lte: new Date() },
        OR: [
          { alias_id: { not: null } },
          {
            job: {
              admission_phase: "ready",
              status: { notIn: ["done", "failed"] },
            },
          },
        ],
      },
      orderBy: [{ delivery_status: "desc" }, { due_at: "asc" }],
      take: this.repo.cfg.BULK_DISPATCH_BATCH_SIZE,
    });
    for (const d of rows) {
      if (d.kind === "bootstrap") {
        await this.repo.db.bulkDispatch.deleteMany({ where: { id: d.id } });
        continue;
      }
      const data: Delivery = {
        generation: d.generation,
        ...(d.job_id ? { job_id: d.job_id } : {}),
        ...(d.result_id ? { result_id: d.result_id } : {}),
        ...(d.alias_id ? { alias_id: d.alias_id } : {}),
      };
      const existing = await this.queue.queue.getJob(deliveryId(d.kind, data));
      const state = existing ? await existing.getState() : "unknown";
      if (
        [
          "waiting",
          "active",
          "delayed",
          "prioritized",
          "waiting-children",
        ].includes(state)
      )
        continue;
      if (existing && ["completed", "failed"].includes(state)) {
        // A queue acknowledgement is not proof of a DB final. Renew delivery generation.
        if (d.result_id)
          await this.repo.db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT job_id FROM "BulkJob" WHERE job_id=${d.job_id}::uuid FOR UPDATE`;
            const r = await tx.bulkResult.findUnique({
              where: { id: d.result_id! },
            });
            if (
              r?.status === "pending" &&
              r.generation === d.generation &&
              !r.recovery_condition
            ) {
              await tx.bulkResult.update({
                where: { id: r.id },
                data: { generation: { increment: 1 } },
              });
              await tx.bulkDispatch.create({
                data: {
                  job_id: r.job_id,
                  result_id: r.id,
                  kind: d.kind,
                  generation: r.generation + 1,
                  due_at: r.resume_at ?? new Date(),
                },
              });
            }
            await tx.bulkDispatch.deleteMany({ where: { id: d.id } });
          });
        else {
          const alias = await this.repo.db.cityAlias.findUnique({
            where: { id: d.alias_id! },
          });
          if (
            !alias ||
            alias.version > d.generation ||
            alias.verification_status !== "verified"
          )
            await this.repo.db.bulkDispatch.deleteMany({ where: { id: d.id } });
          else {
            await existing.remove();
            await this.repo.db.bulkDispatch.updateMany({
              where: { id: d.id },
              data: {
                delivery_status: "pending",
                due_at: new Date(Date.now() + 5000),
              },
            });
          }
        }
        continue;
      }
      // Concurrent dispatchers arbitrate the actual outbox acknowledgement using SKIP LOCKED.
      await this.repo.db.$transaction(
        async (tx) => {
          const claimed = await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM "BulkDispatch" WHERE id=${d.id}::uuid FOR UPDATE SKIP LOCKED`;
          if (!claimed.length) return;
          if (d.result_id) {
            const r = await tx.bulkResult.findUnique({
              where: { id: d.result_id },
            });
            if (
              !r ||
              r.generation !== d.generation ||
              r.status !== "pending" ||
              r.recovery_condition
            ) {
              await tx.bulkDispatch.deleteMany({ where: { id: d.id } });
              return;
            }
          }
          try {
            await this.queue.add(d.kind, data);
            await tx.bulkDispatch.update({
              where: { id: d.id },
              data: {
                delivery_status: "acknowledged",
                enqueued_at: new Date(),
                attempts: { increment: 1 },
                last_error: null,
              },
            });
          } catch {
            await tx.bulkDispatch.updateMany({
              where: { id: d.id },
              data: {
                delivery_status: "pending",
                attempts: { increment: 1 },
                last_error: "BULK_ENQUEUE_FAILED",
                due_at: new Date(Date.now() + 5000),
              },
            });
          }
        },
        { timeout: 10000 },
      );
    }
  }
  async revalidate(aliasId: string, generation: number) {
    const alias = await this.repo.db.cityAlias.findUnique({
      where: { id: aliasId },
      include: { city: true },
    });
    if (
      !alias ||
      alias.version !== generation ||
      alias.verification_status !== "verified"
    )
      return;
    const guard = await this.repo.db.quotaSafetyGuard.findUnique({
      where: { scope: "openweather" },
    });
    if (guard?.blocked_revision === this.repo.cfg.PROVIDER_CONFIG_REVISION)
      return;
    try {
      await this.fetcher.resolver.resolve(
        alias.display_query,
        alias.resolution_policy,
        alias,
      );
      await this.repo.db.bulkDispatch.deleteMany({
        where: { alias_id: aliasId, generation },
      });
    } catch (error) {
      const code =
        error instanceof importError ? error.code : "DEPENDENCY_UNAVAILABLE";
      const permanent = [
        "CITY_NOT_FOUND",
        "CITY_AMBIGUOUS",
        "CITY_QUALIFICATION_UNVERIFIABLE",
      ].includes(code);
      await this.repo.db.cityAlias.updateMany({
        where: { id: aliasId, version: generation },
        data: {
          last_error: {
            code,
            detail: "Alias revalidation deferred or invalidated.",
          },
          ...(permanent
            ? { verification_status: "invalidated", version: { increment: 1 } }
            : {}),
        },
      });
      await this.repo.db.bulkDispatch.updateMany({
        where: { alias_id: aliasId, generation },
        data: {
          delivery_status: "pending",
          due_at: new Date(
            Date.now() +
              (error instanceof importError && error.retryAfter
                ? error.retryAfter * 1000
                : 300000),
          ),
        },
      });
    }
  }
  async retention() {
    const jobs = await this.repo.db.bulkJob.findMany({
      where: {
        status: { in: ["done", "failed"] },
        expires_at: { lte: new Date() },
      },
      select: { job_id: true },
      take: 100,
    });
    for (const { job_id } of jobs) {
      // Bound child work; logical expiry already hides the job from reads and claims.
      for (const model of [
        "BulkDispatch",
        "BulkEntry",
        "BulkRejectedRow",
        "BulkResult",
      ] as const) {
        let deleted: number;
        do {
          deleted = await this.repo.db.$executeRaw(
            Prisma.sql`DELETE FROM ${Prisma.raw('"' + model + '"')} WHERE id IN (SELECT id FROM ${Prisma.raw('"' + model + '"')} WHERE job_id=${job_id}::uuid LIMIT 500)`,
          );
        } while (deleted === 500);
      }
      await this.repo.db.bulkJob.deleteMany({
        where: { job_id, expires_at: { lte: new Date() } },
      });
    }
  }
}
import { ApiError as importError } from "../errors";
