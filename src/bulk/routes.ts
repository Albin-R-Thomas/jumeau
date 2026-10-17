import { Router } from "express";
import { Config } from "../config";
import { ApiError, unavailable } from "../errors";
import { BulkRepository, uuid, invalidBulk } from "./repository";
import { BulkQueue } from "./queue";
import { importCsv } from "./admission";
export function bulkRoutes(
  cfg: Config,
  repo: BulkRepository,
  queue: BulkQueue,
) {
  const router = Router();
  router.post("/bulk/import", async (req, res) => {
    const id = await importCsv(req, cfg, repo, queue);
    res.location(`/bulk/jobs/${id}`).status(202).json({ job_id: id });
  });
  router.get("/bulk/jobs/:job_id", async (req, res) => {
    if (!uuid(req.params.job_id) || Object.keys(req.query).length)
      throw invalidBulk();
    try {
      res.json(await repo.status(req.params.job_id));
    } catch (e) {
      throw e instanceof ApiError ? e : unavailable();
    }
  });
  router.get("/bulk/jobs/:job_id/results", async (req, res) => {
    if (
      !uuid(req.params.job_id) ||
      Object.keys(req.query).some(
        (k) => !["limit", "cursor", "view"].includes(k),
      )
    )
      throw invalidBulk();
    const { limit: raw, cursor, view = "entries" } = req.query;
    if (view !== "entries" && view !== "rejections") throw invalidBulk();
    if (
      raw !== undefined &&
      (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw) || Number(raw) > 100)
    )
      throw invalidBulk();
    if (cursor !== undefined && (typeof cursor !== "string" || !cursor))
      throw invalidBulk();
    try {
      res.json(
        await repo.page(
          req.params.job_id,
          view,
          raw === undefined ? 20 : Number(raw),
          cursor,
        ),
      );
    } catch (e) {
      throw e instanceof ApiError ? e : unavailable();
    }
  });
  return router;
}
