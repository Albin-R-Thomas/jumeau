import express, { ErrorRequestHandler, Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { ApiError } from "./errors";
import { decodeCursor } from "./history";
import { History } from "./types";
import { WeatherService } from "./weather";
const invalid = () =>
  new ApiError(400, "INVALID_INPUT", "Invalid query parameters.");
export function cityInput(raw: unknown): string {
  if (typeof raw !== "string") throw invalid();
  const city = raw.trim();
  if (!city || city.length > 100 || /[\x00-\x1f\x7f-\x9f]/.test(raw))
    throw invalid();
  const parts = city.split(",");
  if (
    parts.some((p) => !p.trim()) ||
    parts.length > 3 ||
    (parts.length >= 2 && !/^[A-Za-z]{2}$/.test(parts.at(-1)!)) ||
    (parts.length === 3 &&
      (!/^[A-Za-z]{2}$/.test(parts[1]!) || parts[2]!.toUpperCase() !== "US"))
  )
    throw invalid();
  return city;
}
export function createApp(
  apiKey: string,
  weather: Pick<WeatherService, "get">,
  history: History,
  bulk?: Router,
) {
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  // Render probes this endpoint without client credentials.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.use((req, res, next) => {
    const key = req.get("X-API-Key");
    if (
      !key ||
      !timingSafeEqual(
        createHash("sha256").update(key).digest(),
        createHash("sha256").update(apiKey).digest(),
      )
    ) {
      next(new ApiError(401, "UNAUTHORIZED", "A valid X-API-Key is required."));
      return;
    }
    next();
  });
  app.get("/weather", async (req, res) => {
    if (Object.keys(req.query).some((k) => k !== "city")) throw invalid();
    res.json(await weather.get(cityInput(req.query.city)));
  });
  app.get("/history", async (req, res) => {
    if (Object.keys(req.query).some((k) => !["limit", "cursor"].includes(k)))
      throw invalid();
    const raw = req.query.limit;
    if (
      raw !== undefined &&
      (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw))
    )
      throw invalid();
    const limit = raw === undefined ? 20 : Number(raw);
    if (limit > 100) throw invalid();
    const cursor = req.query.cursor;
    if (cursor !== undefined && typeof cursor !== "string") throw invalid();
    res.json(
      await history.page(
        limit,
        cursor === undefined ? undefined : decodeCursor(cursor),
      ),
    );
  });
  app.delete("/history", async (req, res) => {
    if (Object.keys(req.query).length) throw invalid();
    await history.delete();
    res.sendStatus(204);
  });
  if (bulk) app.use(bulk);
  app.use((_req, _res, next) =>
    next(new ApiError(404, "NOT_FOUND", "Route not found.")),
  );
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const e =
      error instanceof ApiError
        ? error
        : new ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred.");
    if (e.retryAfter !== undefined)
      res.set("Retry-After", String(e.retryAfter));
    res
      .status(e.status)
      .json({ detail: e.message, code: e.code, ...e.diagnostics });
  };
  app.use(errors);
  return app;
}
