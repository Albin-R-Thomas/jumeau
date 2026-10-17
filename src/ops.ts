import { config } from "./config";
import { runtime } from "./runtime";
import { uuid } from "./bulk/repository";
import { Prisma } from "@prisma/client";
async function main() {
  const r = await runtime(config(process.env));
  try {
    const command = process.argv[2] ?? "status";
    if (command === "rebuild-geo")
      console.log(
        JSON.stringify({ rebuilt_aliases: await r.resolver.rebuild() }),
      );
    else if (command === "reconcile") {
      await r.reconciler.tick();
      console.log('{"reconciled":true}');
    } else if (command === "repair-alias") {
      const id = process.argv[3];
      if (!id || !uuid(id)) throw new Error("Invalid alias ID.");
      await r.db.$transaction(async (tx) => {
        const a = await tx.cityAlias.findUniqueOrThrow({ where: { id } });
        await tx.cityAlias.update({
          where: { id },
          data: {
            city_id: null,
            verification_status: "invalidated",
            version: { increment: 1 },
            last_error: Prisma.DbNull,
          },
        });
        await tx.bulkResult.updateMany({
          where: {
            normalized_key: a.normalized_query,
            status: "pending",
            recovery_condition: "identity_mapping_repaired",
          },
          data: { city_id: null, recovery_condition: null, resume_at: null },
        });
      });
      console.log('{"alias_reset_for_verification":true}');
    } else if (command === "status") {
      const now = new Date();
      const guard = await r.db.quotaSafetyGuard.findUnique({
        where: { scope: "openweather" },
        select: {
          hold_until: true,
          last_intent_at: true,
          blocked_reason: true,
        },
      });
      console.log(
        JSON.stringify({
          queue: await r.queue.queue.getJobCounts(
            "waiting",
            "active",
            "delayed",
            "failed",
          ),
          stalled_events: Number(
            (await r.index.get("cityweather:ops:stalled")) ?? 0,
          ),
          quota: await r.store.inspect(),
          guard,
          workers: (await r.index.keys("cityweather:worker:*")).length,
          pending: await r.db.bulkResult.count({
            where: { status: "pending" },
          }),
          oldest_pending: await r.db.bulkJob.aggregate({
            where: { status: { in: ["queued", "running", "pending"] } },
            _min: { created_at: true },
          }),
          outbox_backlog: await r.db.bulkDispatch.count({
            where: { delivery_status: "pending" },
          }),
          outbox_oldest: await r.db.bulkDispatch.aggregate({
            where: { delivery_status: "pending" },
            _min: { due_at: true },
          }),
          expired_leases: await r.db.bulkResult.count({
            where: { status: "in_flight", lease_expires_at: { lte: now } },
          }),
          cleanup_backlog: await r.db.bulkJob.count({
            where: {
              OR: [
                { expires_at: { lte: now } },
                {
                  admission_phase: { not: "ready" },
                  admission_heartbeat: { lt: new Date(now.getTime() - 600000) },
                },
              ],
            },
          }),
          reasons: await r.db
            .$queryRaw`SELECT last_error->>'code' AS code, COUNT(*)::int AS count FROM "BulkResult" WHERE status='pending' GROUP BY last_error->>'code'`,
        }),
      );
    } else throw new Error("Unknown operations command.");
  } finally {
    await r.close();
  }
}
main().catch(() => {
  console.error(
    "Operation failed; check command, configuration and dependencies.",
  );
  process.exit(1);
});
