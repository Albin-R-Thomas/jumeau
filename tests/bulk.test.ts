import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { readCsv, AdmissionRow } from "../src/bulk/csv";
import { bulkGrammar, stateCode } from "../src/cities/resolver";
import { normalize } from "../src/cities/normalization";
import { cfg } from "./helpers";
import { backoff } from "../src/bulk/processor";
import { createApp } from "../src/app";
import { bulkRoutes } from "../src/bulk/routes";
import { BulkRepository } from "../src/bulk/repository";
import { BulkQueue } from "../src/bulk/queue";

async function parse(input: string | Buffer, options = cfg) {
  const dir = await mkdtemp(join(tmpdir(), "csv-unit-")),
    rows: AdmissionRow[] = [];
  try {
    const file = join(dir, "test.csv");
    await writeFile(file, input);
    const counts = await readCsv(file, options, async (batch) => {
      rows.push(...batch);
    });
    return { counts, rows };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("normalization is versioned NFKC, whitespace/comma aware, case insensitive and accent preserving", () => {
  expect(normalize("  ＰＯＲＴＬＡＮＤ , OR , US  ")).toBe("portland,or,us");
  expect(normalize("San\u00a0  José,CR")).toBe("san josé,cr");
  expect(normalize("Portland,ME,US")).not.toBe(normalize("Portland,OR,US"));
});
test("CSV logical records, physical lines, quoted newlines, CRLF and blanks", async () => {
  const p = await parse(
    '\ufeff"London,GB"\r\n\r\n"a\r\nb"\r\n""\r\n   \r\n,,\r\n',
  );
  expect(p.counts).toEqual({ input_rows: 3, blank_rows: 3, rejected_rows: 1 });
  expect(
    p.rows.map((r) => [r.record_number, r.row_number, r.end_line]),
  ).toEqual([
    [1, 1, 1],
    [3, 3, 4],
    [6, 7, 7],
  ]);
  expect(p.rows[2]!.codes).toContain("INVALID_COLUMN_COUNT");
});
test("200 Unicode code points accepted, 201 rejected, trim before count, syntax is deferred", async () => {
  const p = await parse(
    `${"😀".repeat(200)}\n  ${"x".repeat(200)}  \n${"😀".repeat(201)}\n"London,XYZ"\n`,
  );
  expect(p.counts).toEqual({ input_rows: 4, blank_rows: 0, rejected_rows: 1 });
  expect(p.rows[0]!.codes).toEqual([]);
  expect(p.rows[3]!.codes).toEqual([]);
});
test.each(["London", "London\nParis\nTokyo\n"])("headerless CSV keeps its first city: %j", async (input) => {
  const result = await parse(input);
  expect(result.rows.map((row) => row.city)).toEqual(input.trim().split("\n"));
  expect(result.rows[0]!.record_number).toBe(1);
  expect(result.rows[0]!.row_number).toBe(1);
});
test("empty CSV has no records; first-row column errors are row rejections", async () => {
  expect((await parse("")).counts.input_rows).toBe(0);
  const result = await parse("London,GB\nParis\n");
  expect(result.counts).toEqual({ input_rows: 2, blank_rows: 0, rejected_rows: 1 });
  expect(result.rows[0]!.codes).toEqual(["INVALID_COLUMN_COUNT"]);
  expect(result.rows[1]!.city).toBe("Paris");
});
test("fatal late quotes and fatal UTF-8 get distinct errors", async () => {
  await expect(parse('London\n"unclosed')).rejects.toMatchObject({
    code: "MALFORMED_CSV",
  });
  await expect(
    parse(Buffer.from([99, 105, 116, 121, 10, 0xc3, 0x28])),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_CSV_ENCODING" });
});
test("nonblank row ceiling includes duplicates and structural rejections", async () => {
  await expect(
    parse("\nLondon\nLondon,GB\nLondon\n", {
      ...cfg,
      BULK_UPLOAD_MAX_ROWS: 2,
    }),
  ).rejects.toMatchObject({ status: 413, code: "TOO_MANY_ROWS" });
  expect(
    (await parse("London\nLondon\n", { ...cfg, BULK_UPLOAD_MAX_ROWS: 2 }))
      .counts.input_rows,
  ).toBe(2);
});
test.each([
  "London,XYZ",
  "London,ZZ",
  "Portland,XX,US",
  "Portland,OR,GB",
  "A\nB",
  ",GB",
  "x,a,b,c",
])("worker grammar rejects %j", (query) => {
  expect(() => bulkGrammar(query)).toThrow(
    expect.objectContaining({ code: "INVALID_CITY_SYNTAX" }),
  );
});
test("qualification uses actual pinned country/state tables", () => {
  expect(bulkGrammar(" Portland , OR , US ")).toEqual({
    city: "portland",
    country: "US",
    state: "OR",
  });
  expect(stateCode("Oregon")).toBe("OR");
  expect(bulkGrammar("Tokyo,JP").country).toBe("JP");
});
test("durable backoff is deterministic and finally capped including jitter", () => {
  expect(backoff(1, () => 0)).toBe(5000);
  expect(backoff(2, () => 0)).toBe(10000);
  expect(backoff(99, () => 1)).toBe(300000);
});
test("bulk authentication happens before dependency access; validation precedes reads", async () => {
  const repo = { status: jest.fn(), page: jest.fn() };
  const app = createApp(
    "key",
    { get: jest.fn() },
    {} as never,
    bulkRoutes(cfg, repo as unknown as BulkRepository, {} as BulkQueue),
  );
  expect((await request(app).post("/bulk/import")).status).toBe(401);
  for (const url of [
    "/bulk/jobs/bad",
    "/bulk/jobs/12345678-1234-4234-8234-123456789abc/results?limit=0",
    "/bulk/jobs/12345678-1234-4234-8234-123456789abc/results?view=x",
    "/bulk/jobs/12345678-1234-4234-8234-123456789abc/results?limit=1&limit=2",
  ])
    expect((await request(app).get(url).set("X-API-Key", "key")).status).toBe(
      400,
    );
  expect(repo.status).not.toHaveBeenCalled();
  expect(repo.page).not.toHaveBeenCalled();
});
