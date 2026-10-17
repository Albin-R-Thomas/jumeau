import busboy from "busboy";
import { Request } from "express";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, readdir, lstat } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Config } from "../config";
import { ApiError, unavailable } from "../errors";
import { BulkRepository } from "./repository";
import { BulkQueue } from "./queue";
import { readCsv } from "./csv";

export async function cleanupUploads(
  root: string,
  before = Date.now() - 600000,
) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const name of await readdir(root)) {
    if (!/^request-[A-Za-z0-9]+$/.test(name)) continue;
    const path = resolve(root, name),
      base = resolve(root);
    if (!path.startsWith(base + require("node:path").sep)) continue;
    const info = await lstat(path);
    if (info.isDirectory() && !info.isSymbolicLink() && info.mtimeMs < before)
      await rm(path, { recursive: true, force: true });
  }
}
export async function importCsv(
  req: Request,
  cfg: Config,
  repo: BulkRepository,
  queue: Pick<BulkQueue, "bootstrap" | "removeBootstrap">,
) {
  if (Object.keys(req.query).length)
    throw new ApiError(
      400,
      "INVALID_INPUT",
      "Upload accepts no query parameters.",
    );
  if (!/^multipart\/form-data\s*;/i.test(req.headers["content-type"] ?? ""))
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Use multipart/form-data with one CSV file named file.",
    );
  let directory: string | undefined, job: string | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let inspectHeaders: ((chunk: Buffer) => void) | undefined;
  const abort = new AbortController();
  const timeout = setTimeout(
    () => abort.abort(new ApiError(408, "UPLOAD_TIMEOUT", "Upload timed out.")),
    cfg.BULK_UPLOAD_TIMEOUT_MS,
  );
  const disconnected = () =>
    abort.abort(new ApiError(400, "INVALID_MULTIPART", "Upload disconnected."));
  req.once("aborted", disconnected);
  const responseClosed = () => {
    if (!req.res?.writableEnded) disconnected();
  };
  req.res?.once("close", responseClosed);
  try {
    await mkdir(cfg.BULK_STAGING_DIR, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(cfg.BULK_STAGING_DIR, "request-"));
    const path = join(directory, "input.csv");
    let parser: ReturnType<typeof busboy>;
    try {
      parser = busboy({
        headers: req.headers,
        limits: {
          files: 2,
          fields: 1,
          parts: 3,
          fieldSize: 1,
          headerPairs: 100,
        },
      });
    } catch {
      throw new ApiError(
        400,
        "INVALID_MULTIPART",
        "Invalid multipart boundary.",
      );
    }
    let files = 0,
      parts = 0,
      bytes = 0,
      failure: ApiError | undefined;
    // Busboy reports MIME without parameters. Inspect only bounded part headers to
    // reject an explicitly declared non-UTF-8 charset; never retain CSV bodies.
    const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(
      req.headers["content-type"] ?? "",
    );
    const boundary = Buffer.from(
      "--" + (boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? ""),
    );
    let headerBuffer = Buffer.alloc(0),
      headerState: "boundary" | "headers" | "body" = "boundary";
    inspectHeaders = (chunk: Buffer) => {
      headerBuffer = Buffer.concat([headerBuffer, chunk]);
      for (;;) {
        if (headerState === "headers") {
          const end = headerBuffer.indexOf("\r\n\r\n");
          if (end < 0) {
            if (headerBuffer.length > 16384) {
              failure = new ApiError(
                400,
                "INVALID_MULTIPART",
                "Multipart headers are too large.",
              );
              parser.destroy(failure);
            }
            return;
          }
          const headers = headerBuffer.subarray(0, end).toString("latin1");
          const charset =
            /content-type:[^\r\n]*;\s*charset\s*=\s*"?([^";\s\r\n]+)/i.exec(
              headers,
            )?.[1];
          if (charset && !/^utf-?8$/i.test(charset)) {
            failure = new ApiError(
              415,
              "UNSUPPORTED_CSV_ENCODING",
              "CSV must declare UTF-8 encoding.",
            );
            parser.destroy(failure);
            return;
          }
          headerBuffer = headerBuffer.subarray(end + 4);
          headerState = "body";
        } else {
          const delimiter =
            headerState === "boundary"
              ? boundary
              : Buffer.concat([Buffer.from("\r\n"), boundary]);
          const pos = headerBuffer.indexOf(delimiter);
          if (pos < 0) {
            headerBuffer = Buffer.from(
              headerBuffer.subarray(
                Math.max(0, headerBuffer.length - delimiter.length - 2),
              ),
            );
            return;
          }
          if (headerBuffer.length < pos + delimiter.length + 2) {
            headerBuffer = Buffer.from(headerBuffer.subarray(pos));
            return;
          }
          const suffix = headerBuffer
            .subarray(pos + delimiter.length, pos + delimiter.length + 2)
            .toString();
          if (suffix === "--") {
            headerBuffer = Buffer.alloc(0);
            return;
          }
          headerBuffer = headerBuffer.subarray(pos + delimiter.length + 2);
          headerState = "headers";
        }
      }
    };
    const writes: Promise<void>[] = [];
    parser.on("file", (field, file, info) => {
      files++;
      parts++;
      if (files !== 1 || field !== "file")
        failure = new ApiError(
          400,
          "INVALID_MULTIPART",
          "Exactly one file named file is required.",
        );
      if (
        extname(info.filename ?? "").toLowerCase() !== ".csv" ||
        !["text/csv", "application/csv", "application/octet-stream"].includes(
          info.mimeType,
        )
      )
        failure = new ApiError(
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          "Only CSV files are supported.",
        );
      if (
        !/^utf-?8$/i.test(info.encoding) &&
        !["7bit", "binary"].includes(info.encoding)
      )
        failure = new ApiError(
          415,
          "UNSUPPORTED_CSV_ENCODING",
          "CSV must use UTF-8.",
        );
      if (failure) {
        file.resume();
        return;
      }
      let prefix = Buffer.alloc(0);
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, cb) {
          bytes += chunk.length;
          if (bytes > cfg.BULK_UPLOAD_MAX_BYTES) {
            cb(
              new ApiError(
                413,
                "UPLOAD_TOO_LARGE",
                "CSV exceeds the file byte limit.",
                undefined,
                { limit: cfg.BULK_UPLOAD_MAX_BYTES },
              ),
            );
            return;
          }
          if (prefix.length < 8) {
            prefix = Buffer.concat([
              prefix,
              chunk.subarray(0, 8 - prefix.length),
            ]);
            if (
              prefix.subarray(0, 2).equals(Buffer.from([0x50, 0x4b])) ||
              prefix.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])) ||
              prefix.subarray(0, 2).equals(Buffer.from([0xd0, 0xcf]))
            ) {
              cb(
                new ApiError(
                  415,
                  "UNSUPPORTED_MEDIA_TYPE",
                  "Archives and spreadsheets are not CSV.",
                ),
              );
              return;
            }
          }
          cb(null, chunk);
        },
      });
      const writing = pipeline(
        file,
        counter,
        createWriteStream(path, { mode: 0o600 }),
        { signal: abort.signal },
      );
      void writing.catch((error) => {
        failure = error instanceof ApiError ? error : unavailable();
        parser.destroy(failure);
      });
      writes.push(writing);
    });
    parser.on("field", () => {
      parts++;
      failure = new ApiError(
        400,
        "INVALID_MULTIPART",
        "Text parts are not accepted.",
      );
    });
    for (const event of ["filesLimit", "fieldsLimit", "partsLimit"] as const)
      parser.on(event, () => {
        failure = new ApiError(
          400,
          "INVALID_MULTIPART",
          "Unexpected multipart parts.",
        );
      });
    try {
      await new Promise<void>((done, reject) => {
        const fail = (error: unknown) => {
          req.unpipe(parser);
          req.resume();
          reject(error);
        };
        const cancelled = () => {
          parser.destroy();
          fail(abort.signal.reason);
        };
        abort.signal.addEventListener("abort", cancelled, { once: true });
        parser.once("error", fail);
        parser.once("close", () => {
          abort.signal.removeEventListener("abort", cancelled);
        });
        parser.once("finish", done);
        req.on("data", inspectHeaders!);
        req.pipe(parser);
      });
      await Promise.all(writes);
    } catch (error) {
      await Promise.allSettled(writes);
      throw (
        abort.signal.reason ??
        failure ??
        new ApiError(400, "INVALID_MULTIPART", "Malformed multipart body.")
      );
    }
    if (failure) throw failure;
    if (files !== 1 || parts !== 1)
      throw new ApiError(
        400,
        "INVALID_MULTIPART",
        "Exactly one CSV file named file is required.",
      );
    clearTimeout(timeout);
    job = await repo.prepare();
    heartbeat = setInterval(() => {
      void repo.touchAdmission(job!).catch(() => {});
    }, 15000);
    const counts = await readCsv(path, cfg, (rows) => {
      if (abort.signal.aborted) throw abort.signal.reason;
      return repo.stage(job!, rows);
    });
    await repo.finalizeAdmission(job, counts);
    if (abort.signal.aborted) throw abort.signal.reason;
    try {
      await queue.bootstrap(job);
    } catch {
      throw new ApiError(
        503,
        "BULK_ENQUEUE_FAILED",
        "Bulk queue is unavailable; upload was not activated.",
      );
    }
    if (abort.signal.aborted) throw abort.signal.reason;
    await repo.activate(job);
    return job;
  } catch (error) {
    if (job) {
      await repo.abort(job).catch(() => {});
      await queue.removeBootstrap(job).catch(() => {});
    }
    if (error instanceof ApiError) throw error;
    throw unavailable();
  } finally {
    clearTimeout(timeout);
    if (heartbeat) clearInterval(heartbeat);
    req.removeListener("aborted", disconnected);
    req.res?.removeListener("close", responseClosed);
    if (inspectHeaders) req.removeListener("data", inspectHeaders);
    if (directory)
      await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
