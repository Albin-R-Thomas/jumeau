import { createReadStream } from "node:fs";
import { parse } from "csv-parse";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ApiError, unavailable } from "../errors";
import { Config } from "../config";
import { normalize } from "../cities/normalization";

export type AdmissionRow = {
  record_number: number;
  row_number: number;
  end_line: number;
  city: string;
  normalized_key: string;
  codes: string[];
  detail: string;
};
export type AdmissionCounts = {
  input_rows: number;
  blank_rows: number;
  rejected_rows: number;
};
/** Decode incrementally and fatally; replacement characters must never hide bad bytes. */
class Utf8 extends Transform {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    cb: (error?: Error | null, data?: string) => void,
  ) {
    try {
      cb(null, this.decoder.decode(chunk, { stream: true }));
    } catch {
      cb(
        new ApiError(
          415,
          "UNSUPPORTED_CSV_ENCODING",
          "CSV must be valid UTF-8.",
        ),
      );
    }
  }
  _flush(cb: (error?: Error | null, data?: string) => void) {
    try {
      cb(null, this.decoder.decode());
    } catch {
      cb(
        new ApiError(
          415,
          "UNSUPPORTED_CSV_ENCODING",
          "CSV must be valid UTF-8.",
        ),
      );
    }
  }
}
export async function readCsv(
  path: string,
  cfg: Config,
  batch: (rows: AdmissionRow[]) => Promise<void>,
): Promise<AdmissionCounts> {
  const parser = parse({
    bom: true,
    relax_column_count: true,
    skip_empty_lines: false,
    record_delimiter: ["\r\n", "\n", "\r"],
  });
  // Attach a rejection handler immediately while the consumer supplies backpressure.
  const pumping = pipeline(
    createReadStream(path, { highWaterMark: 16384 }),
    new Utf8(),
    parser,
  );
  void pumping.catch(() => {});
  let record = 0,
    line = 1;
  const counts = { input_rows: 0, blank_rows: 0, rejected_rows: 0 };
  let rows: AdmissionRow[] = [];
  const diagnostics: {
    record_number: number;
    row_number: number;
    end_line: number;
    codes: string[];
    detail: string;
  }[] = [];
  try {
    for await (const item of parser) {
      record++;
      const values = item as string[];
      const start = line;
      // CSV fields preserve embedded newlines; the record delimiter adds one
      // physical line. Avoid retaining a second raw copy/info object per row.
      const embedded = values.reduce(
        (n, value) => n + (value.match(/\r\n|\r|\n/g)?.length ?? 0),
        0,
      );
      const end = start + embedded;
      line = end + 1;
      const city = values[0]?.trim() ?? "";
      if (values.length === 1 && !city) {
        counts.blank_rows++;
        continue;
      }
      if (++counts.input_rows > cfg.BULK_UPLOAD_MAX_ROWS)
        throw new ApiError(
          413,
          "TOO_MANY_ROWS",
          "CSV exceeds the nonblank row limit.",
          undefined,
          { limit: cfg.BULK_UPLOAD_MAX_ROWS },
        );
      const codes: string[] = [];
      if (values.length !== 1) codes.push("INVALID_COLUMN_COUNT");
      if ([...city].length > cfg.BULK_CITY_MAX_CODEPOINTS)
        codes.push("CITY_VALUE_TOO_LONG");
      if (codes.length) {
        counts.rejected_rows++;
        if (diagnostics.length < 100)
          diagnostics.push({
            record_number: record,
            row_number: start,
            end_line: end,
            codes,
            detail:
              "Expected one city value of at most 200 Unicode code points.",
          });
      }
      rows.push({
        record_number: record,
        row_number: start,
        end_line: end,
        city: codes.length ? [...city].slice(0, 100).join("") : city,
        normalized_key: codes.length ? "" : normalize(city),
        codes,
        detail: codes.length
          ? "Expected one city value of at most 200 Unicode code points."
          : "",
      });
      if (rows.length >= cfg.BULK_DB_BATCH_SIZE) {
        await batch(rows);
        rows = [];
      }
    }
    await pumping;
    if (rows.length) await batch(rows);
    return counts;
  } catch (error) {
    parser.destroy();
    await pumping.catch(() => {});
    if (error instanceof ApiError) {
      error.diagnostics = {
        errors: diagnostics,
        error_count: counts.rejected_rows,
        ...error.diagnostics,
      };
      throw error;
    }
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string" &&
        error.code.startsWith("CSV_")
      )
    )
      throw unavailable();
    throw new ApiError(
      400,
      "MALFORMED_CSV",
      "CSV quoting or record syntax is invalid.",
      undefined,
      {
        record_number: record + 1,
        row_number: line,
        errors: diagnostics,
        error_count: counts.rejected_rows,
      },
    );
  }
}
