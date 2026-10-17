import { BulkResult, Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { ApiError } from "../errors";
import { Config } from "../config";
import { AdmissionCounts, AdmissionRow } from "./csv";
import { WeatherSnapshot } from "../weather-fetch";

type Tx = Prisma.TransactionClient;
export const invalidBulk = () =>
  new ApiError(400, "INVALID_INPUT", "Invalid bulk parameters.");
export const uuid = (v: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
const json = (value: unknown) => value as Prisma.InputJsonValue;
const terminal = (r: BulkResult) =>
  ["succeeded", "failed", "merged"].includes(r.status);
export type Claim = BulkResult & { lease_token: string };
export type SafeError = {
  code: string;
  detail: string;
  suggestions?: string[];
  window?: string;
};
type PageCursor = {
  v: 1;
  job: string;
  view: string;
  generation: number;
  ordinal: number;
};
function cursorDecode(
  raw: string,
  job: string,
  view: string,
  generation: number,
): number {
  try {
    if (raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw 0;
    const buffer = Buffer.from(raw, "base64url");
    if (buffer.toString("base64url") !== raw) throw 0;
    const c = JSON.parse(buffer.toString("utf8")) as PageCursor;
    if (
      Object.keys(c).sort().join() !== "generation,job,ordinal,v,view" ||
      c.v !== 1 ||
      c.job !== job ||
      c.view !== view ||
      c.generation !== generation ||
      !Number.isSafeInteger(c.ordinal) ||
      c.ordinal < 1
    )
      throw 0;
    return c.ordinal;
  } catch {
    throw invalidBulk();
  }
}
export class BulkRepository {
  constructor(
    public db: PrismaClient,
    public cfg: Config,
  ) {}
  private async lock(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT job_id FROM "BulkJob" WHERE job_id=${id}::uuid FOR UPDATE`;
  }
  private async now(tx: Tx) {
    return (
      await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
    )[0]!.now;
  }
  async prepare() {
    return (await this.db.bulkJob.create({ data: {} })).job_id;
  }
  async touchAdmission(id: string) {
    await this.db.bulkJob.updateMany({
      where: { job_id: id, admission_phase: "preparing" },
      data: { admission_heartbeat: new Date() },
    });
  }
  async abort(id: string) {
    // Closed admissions never execute. If deletion fails, the stale-admission sweeper retries.
    await this.db.bulkJob.updateMany({
      where: { job_id: id, admission_phase: { not: "ready" } },
      data: { admission_phase: "aborting" },
    });
    await this.db.bulkJob.deleteMany({
      where: { job_id: id, admission_phase: { not: "ready" } },
    });
  }
  async stage(job: string, rows: AdmissionRow[]) {
    const good = new Map<string, AdmissionRow & { occurrences: number }>();
    const rejected = rows.filter((r) => r.codes.length);
    for (const r of rows)
      if (!r.codes.length) {
        const old = good.get(r.normalized_key);
        if (old) old.occurrences++;
        else good.set(r.normalized_key, { ...r, occurrences: 1 });
      }
    await this.db.$transaction(async (tx) => {
      if (good.size)
        await tx.$executeRaw(Prisma.sql`
        INSERT INTO "BulkEntry" (id,job_id,ordinal,first_record_number,first_line,display_city,normalized_key,normalization_version,occurrences)
        VALUES ${Prisma.join([...good.values()].map((r) => Prisma.sql`(${randomUUID()}::uuid,${job}::uuid,${r.record_number},${r.record_number},${r.row_number},${r.city},${r.normalized_key},1,${r.occurrences})`))}
        ON CONFLICT (job_id,normalized_key,normalization_version) DO UPDATE SET occurrences="BulkEntry".occurrences+EXCLUDED.occurrences`);
      if (rejected.length)
        await tx.bulkRejectedRow.createMany({
          data: rejected.map((r) => ({
            job_id: job,
            record_number: r.record_number,
            row_number: r.row_number,
            end_line: r.end_line,
            codes: r.codes,
            detail: r.detail,
            value_preview: r.city.replace(/[\x00-\x1f\x7f-\x9f]/g, " "),
          })),
        });
      await tx.bulkJob.update({
        where: { job_id: job },
        data: { admission_heartbeat: new Date() },
      });
    });
  }
  async finalizeAdmission(id: string, counts: AdmissionCounts) {
    await this.db.$transaction(
      async (tx) => {
        await this.lock(tx, id);
        const admitted = await tx.bulkEntry.count({ where: { job_id: id } });
        if (!admitted) {
          const errors = await tx.bulkRejectedRow.findMany({
            where: { job_id: id },
            orderBy: { record_number: "asc" },
            take: 100,
          });
          throw new ApiError(
            400,
            "NO_ADMISSIBLE_CITIES",
            "CSV contains no admissible city values.",
            undefined,
            { errors, error_count: counts.rejected_rows },
          );
        }
        await tx.$executeRaw`INSERT INTO "BulkResult" (id,job_id,display_city,normalized_key,initial_ordinal) SELECT id,job_id,display_city,normalized_key,ordinal FROM "BulkEntry" WHERE job_id=${id}::uuid`;
        await tx.$executeRaw`UPDATE "BulkEntry" SET result_id=id WHERE job_id=${id}::uuid`;
        await tx.bulkJob.update({
          where: { job_id: id },
          data: {
            ...counts,
            admitted_entries: admitted,
            total: admitted,
            admission_duplicate_rows:
              counts.input_rows - counts.rejected_rows - admitted,
          },
        });
        await tx.bulkDispatch.create({
          data: { job_id: id, kind: "bootstrap", generation: 1 },
        });
      },
      { timeout: 30000 },
    );
  }
  async activate(id: string) {
    await this.db.$transaction(async (tx) => {
      await this.lock(tx, id);
      const now = await this.now(tx);
      await tx.bulkDispatch.updateMany({
        where: { job_id: id, kind: "bootstrap" },
        data: { delivery_status: "acknowledged", enqueued_at: now },
      });
      await tx.bulkJob.update({
        where: { job_id: id },
        data: { admission_phase: "ready", admitted_at: now },
      });
    });
  }
  private async visible(tx: Tx, id: string) {
    const now = await this.now(tx);
    const job = await tx.bulkJob.findFirst({
      where: {
        job_id: id,
        admission_phase: "ready",
        OR: [{ expires_at: null }, { expires_at: { gt: now } }],
      },
    });
    if (!job)
      throw new ApiError(404, "BULK_JOB_NOT_FOUND", "Bulk job not found.");
    return { job, now };
  }
  async claim(id: string, generation: number): Promise<Claim | null> {
    const first = await this.db.bulkResult.findUnique({ where: { id } });
    if (!first) return null;
    return this.db.$transaction(async (tx) => {
      await this.lock(tx, first.job_id);
      const now = await this.now(tx);
      const job = await tx.bulkJob.findUnique({
        where: { job_id: first.job_id },
      });
      const r = await tx.bulkResult.findUnique({ where: { id } });
      if (
        !job ||
        job.admission_phase !== "ready" ||
        ["done", "failed"].includes(job.status) ||
        !r ||
        r.status !== "pending" ||
        r.generation !== generation ||
        (r.resume_at && r.resume_at > now) ||
        r.recovery_condition
      )
        return null;
      if (job.admission_generation !== 1) {
        await tx.bulkResult.updateMany({
          where: {
            job_id: job.job_id,
            status: { in: ["pending", "in_flight"] },
          },
          data: {
            status: "pending",
            lease_token: null,
            lease_expires_at: null,
            recovery_condition: "none",
            last_error: {
              code: "JOB_FAILED",
              detail: "Unsupported admission schema generation.",
            },
          },
        });
        await tx.bulkJob.update({
          where: { job_id: job.job_id },
          data: {
            status: "failed",
            finished_at: now,
            expires_at: new Date(
              now.getTime() + this.cfg.BULK_RETENTION_DAYS * 86400000,
            ),
            job_error: {
              code: "INCOMPATIBLE_JOB_DATA",
              detail: "Unsupported admission schema generation.",
            },
            counters_version: { increment: 1 },
          },
        });
        return null;
      }
      const result = await tx.bulkResult.update({
        where: { id },
        data: {
          status: "in_flight",
          attempts: { increment: 1 },
          lease_token: randomUUID(),
          lease_expires_at: new Date(
            now.getTime() + this.cfg.BULK_LEASE_SECONDS * 1000,
          ),
        },
      });
      await tx.bulkJob.update({
        where: { job_id: job.job_id },
        data: {
          status: "running",
          started_at: job.started_at ?? now,
          last_progress_at: now,
          counters_version: { increment: 1 },
        },
      });
      return result as Claim;
    });
  }
  async owned(r: Claim) {
    const rows = await this.db.$queryRaw<
      { id: string }[]
    >`SELECT r.id FROM "BulkResult" r JOIN "BulkJob" j ON r.job_id=j.job_id WHERE r.id=${r.id}::uuid AND r.lease_token=${r.lease_token}::uuid AND r.status='in_flight' AND r.lease_expires_at>clock_timestamp() AND j.admission_phase='ready' AND j.status NOT IN ('done','failed')`;
    return !!rows.length;
  }
  async heartbeat(r: Claim) {
    await this.db
      .$executeRaw`UPDATE "BulkResult" SET lease_expires_at=clock_timestamp()+${this.cfg.BULK_LEASE_SECONDS}*interval '1 second' WHERE id=${r.id}::uuid AND lease_token=${r.lease_token}::uuid AND status='in_flight' AND lease_expires_at>clock_timestamp()`;
  }
  /** All canonical arbitration and counter changes share the job lock. */
  async bind(r: Claim, city: string): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      await this.lock(tx, r.job_id);
      const current = await tx.bulkResult.findUnique({ where: { id: r.id } });
      const now = await this.now(tx);
      if (
        !current ||
        current.lease_token !== r.lease_token ||
        current.status !== "in_flight" ||
        !current.lease_expires_at ||
        current.lease_expires_at <= now
      )
        return false;
      const survivor = await tx.bulkResult.findFirst({
        where: {
          job_id: r.job_id,
          city_id: city,
          status: { not: "merged" },
          id: { not: r.id },
        },
      });
      if (survivor) {
        await tx.bulkEntry.updateMany({
          where: { job_id: r.job_id, result_id: r.id },
          data: { result_id: survivor.id },
        });
        await tx.bulkResult.update({
          where: { id: r.id },
          data: {
            status: "merged",
            merged_into_id: survivor.id,
            lease_token: null,
            lease_expires_at: null,
            generation: { increment: 1 },
          },
        });
        await tx.bulkDispatch.deleteMany({ where: { result_id: r.id } });
        await tx.bulkJob.update({
          where: { job_id: r.job_id },
          data: {
            total: { decrement: 1 },
            alias_duplicate_rows: { increment: 1 },
            counters_version: { increment: 1 },
          },
        });
        await this.updateState(tx, r.job_id, now);
        return false;
      }
      await tx.bulkResult.update({
        where: { id: r.id },
        data: { city_id: city },
      });
      r.city_id = city;
      return true;
    });
  }
  private async updateState(tx: Tx, id: string, now: Date) {
    const job = await tx.bulkJob.findUniqueOrThrow({ where: { job_id: id } });
    if (["done", "failed"].includes(job.status)) return;
    const inflight = await tx.bulkResult.count({
      where: { job_id: id, status: "in_flight", lease_expires_at: { gt: now } },
    });
    const unfinished = await tx.bulkResult.count({
      where: { job_id: id, status: { in: ["pending", "in_flight"] } },
    });
    const runnable = await tx.bulkResult.count({
      where: {
        job_id: id,
        status: "pending",
        recovery_condition: null,
        OR: [{ resume_at: null }, { resume_at: { lte: now } }],
      },
    });
    const done = unfinished === 0;
    await tx.bulkJob.update({
      where: { job_id: id },
      data: {
        status: done
          ? "done"
          : inflight || (runnable && job.started_at)
            ? "running"
            : runnable
              ? "queued"
              : "pending",
        ...(done
          ? {
              finished_at: now,
              expires_at: new Date(
                now.getTime() + this.cfg.BULK_RETENTION_DAYS * 86400000,
              ),
            }
          : {}),
      },
    });
  }
  async finish(
    r: Claim,
    outcome: {
      snapshot?: WeatherSnapshot;
      error?: SafeError;
      resume_at?: Date;
      recovery_condition?: string;
      provisional?: WeatherSnapshot;
    },
  ) {
    await this.db.$transaction(async (tx) => {
      await this.lock(tx, r.job_id);
      const now = await this.now(tx);
      const current = await tx.bulkResult.findUnique({ where: { id: r.id } });
      if (
        !current ||
        terminal(current) ||
        current.lease_token !== r.lease_token ||
        current.status !== "in_flight" ||
        !current.lease_expires_at ||
        current.lease_expires_at <= now
      )
        return;
      const deferred = !!(outcome.resume_at || outcome.recovery_condition);
      if (outcome.snapshot && !current.city_id)
        throw new Error("Weather result requires verified canonical identity.");
      const s = outcome.snapshot;
      await tx.bulkResult.update({
        where: { id: r.id },
        data: {
          status: s ? "succeeded" : deferred ? "pending" : "failed",
          lease_token: null,
          lease_expires_at: null,
          last_error: outcome.error ? json(outcome.error) : Prisma.DbNull,
          resume_at: outcome.resume_at ?? null,
          recovery_condition: outcome.recovery_condition ?? null,
          completed_at: deferred ? null : now,
          generation: { increment: 1 },
          ...(s
            ? {
                weather: json(s.weather),
                source: s.source,
                fetched_at: new Date(s.fetched_at),
                fresh_until: new Date(s.fresh_until),
                observed_at: new Date(s.weather.observed_at),
              }
            : {}),
          ...(outcome.provisional
            ? {
                provisional_weather: json(outcome.provisional.weather),
                provisional_expires_at: new Date(
                  outcome.provisional.backup_until,
                ),
              }
            : {}),
        },
      });
      if (current.city_id)
        await tx.city.update({
          where: { id: current.city_id },
          data: s
            ? {
                last_status: "success",
                last_refreshed_at: new Date(s.fetched_at),
                last_error: Prisma.DbNull,
              }
            : {
                last_status: deferred ? "pending" : "failed",
                last_error: outcome.error ? json(outcome.error) : Prisma.DbNull,
              },
        });
      if (deferred)
        await tx.bulkDispatch.create({
          data: {
            job_id: r.job_id,
            result_id: r.id,
            generation: current.generation + 1,
            kind: "process-city",
            due_at: outcome.resume_at ?? now,
          },
        });
      await tx.bulkJob.update({
        where: { job_id: r.job_id },
        data: {
          counters_version: { increment: 1 },
          last_progress_at: now,
          ...(!deferred
            ? {
                processed: { increment: 1 },
                ...(s
                  ? { succeeded: { increment: 1 } }
                  : { failed: { increment: 1 } }),
              }
            : {}),
        },
      });
      await this.updateState(tx, r.job_id, now);
    });
  }
  async recoverLeases(tx: Tx, job?: string) {
    const expired = await tx.bulkResult.findMany({
      where: {
        ...(job ? { job_id: job } : {}),
        status: "in_flight",
        lease_expires_at: { lte: await this.now(tx) },
      },
      take: 500,
    });
    for (const r of expired) {
      // Callers must hold the per-job lock; global reconciliation calls this per job.
      const updated = await tx.bulkResult.updateMany({
        where: { id: r.id, status: "in_flight", lease_token: r.lease_token },
        data: {
          status: "pending",
          lease_token: null,
          lease_expires_at: null,
          generation: { increment: 1 },
          resume_at: null,
          recovery_condition: null,
          last_error: {
            code: "WORKER_RESTARTED",
            detail: "Expired worker lease; scheduled for recovery.",
          },
        },
      });
      if (updated.count) {
        await tx.bulkDispatch.create({
          data: {
            job_id: r.job_id,
            result_id: r.id,
            generation: r.generation + 1,
            kind: "process-city",
          },
        });
        await tx.bulkJob.update({
          where: { job_id: r.job_id },
          data: { counters_version: { increment: 1 } },
        });
      }
    }
  }
  async recover() {
    const jobs = await this.db.$queryRaw<
      { job_id: string }[]
    >`SELECT DISTINCT job_id FROM "BulkResult" WHERE status='in_flight' AND lease_expires_at<=clock_timestamp() LIMIT 100`;
    for (const { job_id } of jobs)
      await this.db.$transaction(async (tx) => {
        await this.lock(tx, job_id);
        await this.recoverLeases(tx, job_id);
        await this.updateState(tx, job_id, await this.now(tx));
      });
    await this.db
      .$executeRaw`DELETE FROM "BulkJob" WHERE admission_phase<>'ready' AND admission_heartbeat<clock_timestamp()-interval '10 minutes'`;
  }
  private async summary(tx: Tx, id: string) {
    const { job, now } = await this.visible(tx, id);
    const live = { job_id: id, status: { not: "merged" as const } };
    const groups = await tx.bulkResult.groupBy({
      by: ["status"],
      where: live,
      _count: true,
    });
    const counts = Object.fromEntries(groups.map((g) => [g.status, g._count]));
    // Expired leases are projected as pending in this single repeatable-read snapshot.
    const expired = await tx.bulkResult.count({
      where: {
        job_id: id,
        status: "in_flight",
        lease_expires_at: { lte: now },
      },
    });
    const ready = await tx.bulkResult.count({
      where: {
        job_id: id,
        status: "pending",
        recovery_condition: null,
        OR: [{ resume_at: null }, { resume_at: { lte: now } }],
      },
    });
    const pending = (counts.pending ?? 0) + expired,
      inflight = (counts.in_flight ?? 0) - expired;
    const unresolved = await tx.bulkResult.count({
      where: {
        ...live,
        city_id: null,
        status: { in: ["pending", "in_flight"] },
      },
    });
    const provisional = await tx.bulkResult.count({
      where: {
        ...live,
        status: { in: ["pending", "in_flight"] },
        provisional_expires_at: { gt: now },
      },
    });
    const reasons = await tx.$queryRaw<
      { code: string; count: number }[]
    >`SELECT last_error->>'code' AS code, COUNT(*)::int AS count FROM "BulkResult" WHERE job_id=${id}::uuid AND status IN ('pending','in_flight') AND last_error IS NOT NULL GROUP BY last_error->>'code'`;
    const conditions = await tx.bulkResult.groupBy({
      by: ["recovery_condition"],
      where: { ...live, recovery_condition: { not: null }, status: "pending" },
      _count: true,
    });
    const resume = await tx.bulkResult.aggregate({
      where: { ...live, status: "pending", resume_at: { not: null } },
      _min: { resume_at: true },
    });
    const recent = async (status: "succeeded" | "failed") =>
      (
        await tx.bulkResult.findMany({
          where: { job_id: id, status },
          orderBy: [{ completed_at: "desc" }, { id: "asc" }],
          take: 5,
        })
      ).map((r) => ({
        result_id: r.id,
        city: r.display_city,
        completed_at: r.completed_at,
        ...(status === "failed" ? { last_error: r.last_error } : {}),
      }));
    const {
      admission_phase,
      admission_heartbeat,
      admission_generation,
      ...publicJob
    } = job;
    return {
      ...publicJob,
      status: ["done", "failed"].includes(job.status)
        ? job.status
        : inflight || (ready + expired && job.started_at)
          ? "running"
          : ready + expired
            ? "queued"
            : "pending",
      duplicate_rows: job.admission_duplicate_rows + job.alias_duplicate_rows,
      total_basis: unresolved ? "provisional" : "resolved",
      pending,
      in_flight: inflight,
      ready_count: ready + expired,
      blocked_count: pending - ready - expired,
      unfinished: pending + inflight,
      provisional_count: provisional,
      state_evaluated_at: now,
      resume_at: resume._min.resume_at,
      blocking_reasons: reasons,
      recovery_conditions: conditions.map((c) => ({
        condition: c.recovery_condition,
        count: c._count,
      })),
      recent_refreshes: await recent("succeeded"),
      recent_failures: await recent("failed"),
      rejected_rows_url: `/bulk/jobs/${id}/results?view=rejections`,
    };
  }
  async status(id: string) {
    return this.db.$transaction((tx) => this.summary(tx, id), {
      isolationLevel: "RepeatableRead",
    });
  }
  async page(
    id: string,
    view: "entries" | "rejections",
    limit: number,
    raw?: string,
  ) {
    return this.db.$transaction(
      async (tx) => {
        const { job, now } = await this.visible(tx, id);
        const after = raw
          ? cursorDecode(raw, id, view, job.admission_generation)
          : 0;
        const encode = (ordinal: number) =>
          Buffer.from(
            JSON.stringify({
              v: 1,
              job: id,
              view,
              generation: job.admission_generation,
              ordinal,
            } satisfies PageCursor),
          ).toString("base64url");
        if (view === "rejections") {
          const rows = await tx.bulkRejectedRow.findMany({
            where: { job_id: id, record_number: { gt: after } },
            orderBy: { record_number: "asc" },
            take: limit + 1,
          });
          return {
            job_id: id,
            view,
            rejected_rows: job.rejected_rows,
            errors: rows
              .slice(0, limit)
              .map(({ id: _, job_id: __, ...r }) => r),
            next_cursor:
              rows.length > limit
                ? encode(rows[limit - 1]!.record_number)
                : null,
          };
        }
        const rows = await tx.bulkEntry.findMany({
          where: { job_id: id, ordinal: { gt: after } },
          orderBy: { ordinal: "asc" },
          take: limit + 1,
        });
        const entries = rows.slice(0, limit);
        const results = await tx.bulkResult.findMany({
          where: {
            job_id: id,
            id: {
              in: entries.flatMap((e) => (e.result_id ? [e.result_id] : [])),
            },
          },
        });
        const outcomes = Object.fromEntries(
          results.map((r) => [
            r.id,
            {
              city: r.display_city,
              status:
                r.status === "in_flight" &&
                r.lease_expires_at &&
                r.lease_expires_at <= now
                  ? "pending"
                  : r.status,
              canonical_city_id: r.city_id,
              last_refreshed_at: r.fetched_at,
              last_error: r.last_error,
              resume_at: r.resume_at,
              recovery_condition: r.recovery_condition,
              attempts: r.attempts,
              completed_at: r.completed_at,
              weather: r.status === "succeeded" ? r.weather : null,
              source: r.source,
              fetched_at: r.fetched_at,
              fresh_until: r.fresh_until,
              observed_at: r.observed_at,
              provisional_weather:
                r.provisional_expires_at &&
                r.provisional_expires_at > now &&
                !terminal(r)
                  ? r.provisional_weather
                  : null,
              provisional_expires_at:
                r.provisional_expires_at &&
                r.provisional_expires_at > now &&
                !terminal(r)
                  ? r.provisional_expires_at
                  : null,
            },
          ]),
        );
        return {
          job_id: id,
          view,
          counters_version: job.counters_version,
          admitted_entries: job.admitted_entries,
          total: job.total,
          rejected_rows: job.rejected_rows,
          entries: entries.map((e) => ({
            entry_id: e.id,
            ordinal: e.ordinal,
            record_number: e.first_record_number,
            row_number: e.first_line,
            city: e.display_city,
            occurrences: e.occurrences,
            result_id: e.result_id,
            canonical_city_id:
              results.find((r) => r.id === e.result_id)?.city_id ?? null,
          })),
          outcomes,
          next_cursor:
            rows.length > limit ? encode(entries.at(-1)!.ordinal) : null,
          rejections: {
            count: job.rejected_rows,
            url: `/bulk/jobs/${id}/results?view=rejections`,
          },
        };
      },
      { isolationLevel: "RepeatableRead" },
    );
  }
}
