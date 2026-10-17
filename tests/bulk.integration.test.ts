import request from "supertest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtime, Runtime } from "../src/runtime";
import { config } from "../src/config";
import { createApp } from "../src/app";
import { bulkRoutes } from "../src/bulk/routes";
import { cfg, payload, response } from "./helpers";
import { startWorker } from "../src/bulk/worker";
import { deliveryId } from "../src/bulk/queue";
import { ApiError } from "../src/errors";
import { fork } from "node:child_process";
import { once } from "node:events";
import { reserveScript } from "../src/store";
import { createHash } from "node:crypto";
import { weather } from "./helpers";
import { request as httpRequest } from "node:http";

const enabled =
  process.env.NODE_ENV === "test" &&
  !!process.env.DATABASE_URL &&
  !!process.env.REDIS_URL;
const suite = enabled ? describe : describe.skip;
suite("bulk real PostgreSQL/Redis/BullMQ", () => {
  jest.setTimeout(20000);
  let r: Runtime, app: ReturnType<typeof createApp>, dir: string;
  let fetcher: jest.MockedFunction<typeof fetch>;
  const geo = { name: "London", country: "GB", lat: 51.5, lon: -0.12 };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "bulk-integration-"));
    fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(async (input) => {
        const u = new URL(String(input));
        if (u.pathname.includes("geo")) {
          const q = u.searchParams.get("q")!.toLowerCase();
          if (q.includes("missing")) return response(200, []);
          if (q.includes("ambiguous"))
            return response(200, [geo, { ...geo, lat: 50 }]);
          return response(200, [geo]);
        }
        return response(200, payload);
      });
    r = await runtime(
      config({
        ...process.env,
        API_KEY: "test-placeholder",
        OPENWEATHER_API_KEY: "provider-placeholder",
        BULK_STAGING_DIR: dir,
        BULK_RECONCILE_INTERVAL_MS: "100",
        PROVIDER_MAX_RETRIES: "0",
      }),
      { fetcher, random: () => 0, sleep: async () => {} },
    );
    await r.queue.queue.waitUntilReady();
    app = createApp(
      r.cfg.API_KEY,
      r.weather,
      r.history,
      bulkRoutes(r.cfg, r.repo, r.queue),
    );
  });
  const clean = async () => {
    await r.queue.queue.obliterate({ force: true });
    await r.db.bulkJob.deleteMany();
    await r.db.bulkDispatch.deleteMany();
    await r.db.cityAlias.deleteMany();
    await r.db.placeIdentityKey.deleteMany();
    await r.db.city.deleteMany();
    await r.db.quotaSafetyGuard.deleteMany();
    await r.db.searchHistory.deleteMany();
    await r.redis.flushDb();
  };
  beforeEach(async () => {
    await clean();
    fetcher.mockClear();
  });
  afterAll(async () => {
    if (r) {
      await clean();
      await r.close();
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  function upload(csv: string | Buffer) {
    return request(app)
      .post("/bulk/import")
      .set("X-API-Key", r.cfg.API_KEY)
      .attach("file", Buffer.isBuffer(csv) ? csv : Buffer.from(csv), {
        filename: "cities.csv",
        contentType: "text/csv",
      });
  }
  async function admitted(csv: string) {
    const res = await upload(csv);
    expect(res.status).toBe(202);
    return res.body.job_id as string;
  }
  async function processAll(id: string) {
    const results = await r.db.bulkResult.findMany({
      where: { job_id: id, status: "pending" },
      orderBy: { initial_ordinal: "asc" },
    });
    for (const result of results)
      await r.processor.process({
        result_id: result.id,
        generation: result.generation,
      });
  }
  const invariant = async (id: string) => {
    const s = await r.repo.status(id);
    expect(s.total).toBe(s.processed + s.pending + s.in_flight);
    expect(s.processed).toBe(s.succeeded + s.failed);
    expect(s.input_rows).toBe(s.rejected_rows + s.duplicate_rows + s.total);
    return s;
  };
  test("202 gate, complete immediate membership, partial rejections, deduplication, no admission provider calls", async () => {
    const id = await admitted(
      `city\n"London,GB"\n" LONDON , gb "\nLondon,GB\n${"x".repeat(201)}\n"London,XYZ"\n\n`,
    );
    expect(fetcher).not.toHaveBeenCalled();
    const s = await invariant(id);
    expect(s).toMatchObject({
      input_rows: 5,
      blank_rows: 1,
      admitted_entries: 2,
      rejected_rows: 2,
      admission_duplicate_rows: 1,
      total: 2,
      pending: 2,
    });
    const p = await r.repo.page(id, "entries", 1);
    expect(p.entries![0]!.occurrences).toBe(2);
    expect(p.next_cursor).toBeTruthy();
    const errs = await r.repo.page(id, "rejections", 1);
    expect(errs.errors).toHaveLength(1);
    expect(errs.next_cursor).toBeTruthy();
    expect(await readdir(dir)).toEqual([]);
    const bootstrap = await r.queue.queue.getJob(
      deliveryId("bootstrap", { job_id: id, generation: 1 }),
    );
    expect(bootstrap?.data).toEqual({ job_id: id, generation: 1 });
  });
  test("canonical aliases merge into one outcome, pagination survives merge, finals are fenced and immutable", async () => {
    const id = await admitted('city\n"London,GB"\n"Londres,GB"\n');
    const first = await r.repo.page(id, "entries", 1);
    const before = await r.db.bulkResult.findMany({ where: { job_id: id } });
    await processAll(id);
    const s = await invariant(id);
    expect(s).toMatchObject({
      status: "done",
      total: 1,
      succeeded: 1,
      alias_duplicate_rows: 1,
    });
    const second = await r.repo.page(id, "entries", 1, first.next_cursor!);
    expect(first.entries![0]!.entry_id).not.toBe(second.entries![0]!.entry_id);
    const after = await r.repo.page(id, "entries", 20);
    expect(new Set(after.entries!.map((e) => e.result_id)).size).toBe(1);
    expect(Object.keys(after.outcomes!)).toHaveLength(1);
    for (const item of before)
      await r.processor.process({
        result_id: item.id,
        generation: item.generation,
      });
    expect((await invariant(id)).processed).toBe(1);
    expect(await r.db.searchHistory.count()).toBe(0);
    const result = await r.db.bulkResult.findFirstOrThrow({
      where: { job_id: id, status: "succeeded" },
    });
    await r.index.del(r.fetcher.key(result.city_id!));
    expect(
      (await r.repo.page(id, "entries", 20)).outcomes![result.id]!.weather,
    ).toEqual(result.weather);
  });
  test("concurrent canonical bind leaves one live result and counter equations", async () => {
    const id = await admitted('city\n"London,GB"\n"Londres,GB"\n"Londra,GB"\n');
    const results = await r.db.bulkResult.findMany({ where: { job_id: id } });
    await Promise.all(
      results.map((x) =>
        r.processor.process({ result_id: x.id, generation: 1 }),
      ),
    );
    expect((await invariant(id)).total).toBe(1);
    expect(await r.db.city.count()).toBe(1);
    expect(
      await r.db.bulkResult.count({
        where: { job_id: id, status: "succeeded" },
      }),
    ).toBe(1);
  });
  test("ambiguity, not-found and syntax are permanent worker errors; HTTP first match remains successful", async () => {
    const id = await admitted('city\nambiguous\nmissing\n"London,XYZ"\n');
    await processAll(id);
    expect(await invariant(id)).toMatchObject({
      status: "done",
      total: 3,
      failed: 3,
    });
    const codes = (
      await r.db.bulkResult.findMany({ where: { job_id: id } })
    ).map((x) => (x.last_error as { code: string }).code);
    expect(codes.sort()).toEqual([
      "CITY_AMBIGUOUS",
      "CITY_NOT_FOUND",
      "INVALID_CITY_SYNTAX",
    ]);
    expect(
      (
        await request(app)
          .get("/weather?city=ambiguous")
          .set("X-API-Key", r.cfg.API_KEY)
      ).status,
    ).toBe(200);
    expect(
      await r.db.cityAlias.count({
        where: { resolution_policy: "bulk_unambiguous" },
      }),
    ).toBe(0);
  });
  test.each([
    "city,country\nLondon,GB\n",
    'city\n"London,GB"\n"unclosed',
    "city\nLondon,GB\n",
  ])("fatal upload %j publishes nothing and cleans up", async (csv) => {
    expect((await upload(csv)).status).toBe(400);
    expect(await r.db.bulkJob.count()).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });
  test("invalid UTF8, unsupported format, unexpected parts, missing file and byte ceiling", async () => {
    expect(
      (await upload(Buffer.from([99, 105, 116, 121, 10, 255]))).status,
    ).toBe(415);
    expect((await upload(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).status).toBe(
      415,
    );
    expect(
      (
        await request(app)
          .post("/bulk/import")
          .set("X-API-Key", r.cfg.API_KEY)
          .field("extra", "x")
          .attach("file", Buffer.from("city\nLondon"), "x.csv")
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/bulk/import")
          .set("X-API-Key", r.cfg.API_KEY)
          .attach("file", Buffer.from("city\nLondon"), "x.csv")
          .attach("file", Buffer.from("city\nParis"), "y.csv")
      ).status,
    ).toBe(400);
    const small = createApp(
      r.cfg.API_KEY,
      r.weather,
      r.history,
      bulkRoutes({ ...r.cfg, BULK_UPLOAD_MAX_BYTES: 12 }, r.repo, r.queue),
    );
    expect(
      (
        await request(small)
          .post("/bulk/import")
          .set("X-API-Key", r.cfg.API_KEY)
          .attach("file", Buffer.from("city\nLondon\nx"), "x.csv")
      ).status,
    ).toBe(413);
    expect(await r.db.bulkJob.count()).toBe(0);
  });
  test("enqueue timeout after acceptance and activation failure leave no executable ready graph", async () => {
    const original = r.queue.bootstrap.bind(r.queue);
    const spy = jest
      .spyOn(r.queue, "bootstrap")
      .mockImplementation(async (id) => {
        await original(id);
        throw new Error("unknown enqueue outcome");
      });
    expect((await upload("city\nLondon\n")).status).toBe(503);
    expect(await r.db.bulkJob.count()).toBe(0);
    spy.mockRestore();
    const activate = jest
      .spyOn(r.repo, "activate")
      .mockRejectedValueOnce(new Error("DB commit failure"));
    expect((await upload("city\nLondon\n")).status).toBe(503);
    activate.mockRestore();
    expect(await r.db.bulkJob.count()).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
  test("provider transient failures stay pending, later delivery resumes without new upload", async () => {
    const id = await admitted("city\nLondon\n");
    fetcher.mockResolvedValueOnce(response(503, {}));
    await processAll(id);
    const result = await r.db.bulkResult.findFirstOrThrow({
      where: { job_id: id },
    });
    expect(await invariant(id)).toMatchObject({
      status: "pending",
      processed: 0,
      pending: 1,
    });
    expect(result.resume_at).toBeTruthy();
    await r.db.bulkResult.update({
      where: { id: result.id },
      data: { resume_at: new Date(0) },
    });
    await processAll(id);
    expect(await invariant(id)).toMatchObject({ status: "done", succeeded: 1 });
  });
  test("expired leases recover; old completion token cannot finalize", async () => {
    const id = await admitted("city\nLondon\n"),
      item = await r.db.bulkResult.findFirstOrThrow({ where: { job_id: id } });
    const claim = (await r.repo.claim(item.id, 1))!;
    await r.db.bulkResult.update({
      where: { id: item.id },
      data: { lease_expires_at: new Date(0) },
    });
    expect((await invariant(id)).in_flight).toBe(0);
    await r.repo.recover();
    await r.repo.finish(claim, {
      error: { code: "OLD", detail: "Stale callback." },
    });
    expect((await invariant(id)).processed).toBe(0);
    await processAll(id);
    expect((await invariant(id)).succeeded).toBe(1);
  });
  test("fresh cache shared between HTTP and bulk; persistent geo index rebuild and independent weather expiry", async () => {
    const id = await admitted('city\n"London,GB"\n');
    await processAll(id);
    const calls = fetcher.mock.calls.length;
    expect(
      (
        await request(app)
          .get("/weather?city=London,GB")
          .set("X-API-Key", r.cfg.API_KEY)
      ).status,
    ).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(calls);
    expect(await r.db.searchHistory.count()).toBe(1);
    const alias = (await r.resolver.lookup("London,GB", "bulk_unambiguous"))!;
    expect(
      await r.index.ttl(r.resolver.key("London,GB", "bulk_unambiguous")),
    ).toBe(-1);
    await r.index.del(r.resolver.key("London,GB", "bulk_unambiguous"));
    await r.resolver.rebuild();
    expect(
      await r.index.ttl(r.resolver.key("London,GB", "bulk_unambiguous")),
    ).toBe(-1);
    await r.index.del(r.fetcher.key(alias.city_id!));
    expect(await r.db.city.count()).toBe(1);
    const id2 = await admitted('city\n"London,GB"\n');
    await processAll(id2);
    expect(fetcher).toHaveBeenCalledTimes(calls + 1);
  });
  test("backup is provisional, expires by its own deadline, and never counts successful", async () => {
    const first = await admitted("city\nLondon\n");
    await processAll(first);
    const alias = (await r.resolver.lookup("London", "bulk_unambiguous"))!;
    await r.index.del(r.fetcher.key(alias.city_id!));
    const second = await admitted("city\nLondon\n");
    fetcher.mockResolvedValueOnce(response(503, {}));
    await processAll(second);
    const p = await r.repo.page(second, "entries", 20),
      value = Object.values(p.outcomes!)[0]!;
    expect(value.weather).toBeNull();
    expect(value.provisional_weather).toBeTruthy();
    expect((await invariant(second)).succeeded).toBe(0);
    await r.db.bulkResult.updateMany({
      where: { job_id: second },
      data: { provisional_expires_at: new Date(0) },
    });
    expect(
      Object.values((await r.repo.page(second, "entries", 20)).outcomes!)[0]!
        .provisional_weather,
    ).toBeNull();
  });
  test("quota continuity loss persists a hold; configuration mismatch fails closed", async () => {
    await r.guard.beforeAttempt();
    await r.store.reserve();
    await r.index.del("cityweather:quota-continuity:v1");
    await expect(r.guard.beforeAttempt()).rejects.toMatchObject({
      code: "QUOTA_RECOVERY_HOLD",
    });
    expect(
      (
        await r.db.quotaSafetyGuard.findUniqueOrThrow({
          where: { scope: "openweather" },
        })
      ).hold_until,
    ).toBeTruthy();
    await r.db.quotaSafetyGuard.update({
      where: { scope: "openweather" },
      data: { minute_budget: 1 },
    });
    await expect(r.guard.beforeAttempt()).rejects.toMatchObject({
      code: "QUOTA_CONFIGURATION_CONFLICT",
    });
  });
  test("provider auth blocks until configuration revision changes; restart does not repeatedly probe", async () => {
    const id = await admitted("city\nLondon\n");
    fetcher.mockResolvedValueOnce(response(401, {}));
    await processAll(id);
    const before = fetcher.mock.calls.length;
    expect((await invariant(id)).recovery_conditions[0]!.condition).toContain(
      "provider_configuration_repaired",
    );
    await r.reconciler.tick();
    expect(fetcher).toHaveBeenCalledTimes(before);
    // Simulate repaired deployment revision; use a new runtime to exercise the persisted guard.
    const repaired = await runtime(
      { ...r.cfg, PROVIDER_CONFIG_REVISION: "repaired" },
      { fetcher, random: () => 0 },
    );
    try {
      await repaired.reconciler.tick();
      const item = await repaired.db.bulkResult.findFirstOrThrow({
        where: { job_id: id },
      });
      await repaired.processor.process({
        result_id: item.id,
        generation: item.generation,
      });
      expect((await invariant(id)).succeeded).toBe(1);
    } finally {
      await repaired.close();
    }
  });
  test("job-bound, view-bound canonical cursors reject cross-use", async () => {
    const a = await admitted("city\nLondon\nParis\n"),
      b = await admitted("city\nLondon\nParis\n");
    const token = (await r.repo.page(a, "entries", 1)).next_cursor!;
    await expect(r.repo.page(b, "entries", 1, token)).rejects.toMatchObject({
      status: 400,
    });
    await expect(r.repo.page(a, "rejections", 1, token)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      r.repo.page(a, "entries", 1, token + "="),
    ).rejects.toMatchObject({ status: 400 });
  });
  test("terminal retention preserves shared cities/history and old active jobs", async () => {
    const old = await admitted("city\nLondon\n"),
      done = await admitted("city\nLondon\n");
    await processAll(done);
    await r.db.bulkJob.update({
      where: { job_id: old },
      data: { created_at: new Date(0) },
    });
    await r.db.bulkJob.update({
      where: { job_id: done },
      data: { expires_at: new Date() },
    });
    await expect(r.repo.status(done)).rejects.toMatchObject({ status: 404 });
    await r.reconciler.retention();
    expect(await r.db.bulkJob.count()).toBe(1);
    expect((await r.repo.status(old)).job_id).toBe(old);
    expect(await r.db.city.count()).toBe(1);
  });
  test("real BullMQ worker completes delivery and missing queued message is reconstructed", async () => {
    const id = await admitted("city\nLondon\n");
    await r.reconciler.tick();
    const deliveries = await r.queue.queue.getJobs(["waiting", "delayed"]);
    for (const d of deliveries) if (d.name === "process-city") await d.remove();
    await r.reconciler.tick();
    const w = startWorker(r);
    try {
      const deadline = Date.now() + 10000;
      while (
        (await r.repo.status(id)).status !== "done" &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect((await invariant(id)).succeeded).toBe(1);
    } finally {
      await w.close();
    }
  });
  test.each(["before-cache", "after-cache", "after-commit"])(
    "SIGKILL at %s: persisted finals survive and unfinished work resumes",
    async (stage) => {
      const id = await admitted("city\nLondon\n");
      const child = fork(
        join(process.cwd(), "scripts/test-crash-worker.cjs"),
        [],
        {
          env: {
            ...process.env,
            ...Object.fromEntries(
              Object.entries(r.cfg).map(([k, v]) => [k, String(v)]),
            ),
            TEST_CRASH_STAGE: stage,
          },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Crash barrier was not reached.")),
            10000,
          );
          child.on("message", (m: { barrier?: string; error?: string }) => {
            if (m.barrier === stage) {
              clearTimeout(timer);
              resolve();
            }
            if (m.error) {
              clearTimeout(timer);
              reject(new Error(m.error));
            }
          });
          child.once("error", reject);
        });
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        const item = await r.db.bulkResult.findFirstOrThrow({
          where: { job_id: id, status: { not: "merged" } },
        });
        expect(item.status).toBe(
          stage === "after-commit" ? "succeeded" : "in_flight",
        );
        if (item.status !== "succeeded") {
          await r.db.bulkResult.update({
            where: { id: item.id },
            data: { lease_expires_at: new Date(0) },
          });
          await r.repo.recover();
          await r.reconciler.tick();
          const w = startWorker(r);
          try {
            const until = Date.now() + 8000;
            while (
              (await r.repo.status(id)).status !== "done" &&
              Date.now() < until
            )
              await new Promise((resolve) => setTimeout(resolve, 25));
          } finally {
            await w.close();
          }
        }
        expect(await invariant(id)).toMatchObject({
          status: "done",
          processed: 1,
          succeeded: 1,
        });
        if (stage === "after-cache") expect(fetcher).not.toHaveBeenCalled();
        await r.processor.process({ result_id: item.id, generation: 1 });
        expect((await invariant(id)).processed).toBe(1);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      }
    },
  );
  test("all-city failure is done; job corruption is failed with unfinished work preserved", async () => {
    const id = await admitted("city\nLondon\nParis\n");
    const rows = await r.db.bulkResult.findMany({
      where: { job_id: id },
      orderBy: { initial_ordinal: "asc" },
    });
    await r.processor.process({ result_id: rows[0]!.id, generation: 1 });
    await r.db.bulkJob.update({
      where: { job_id: id },
      data: { admission_generation: 99 },
    });
    await r.processor.process({ result_id: rows[1]!.id, generation: 1 });
    expect(await invariant(id)).toMatchObject({
      status: "failed",
      succeeded: 1,
      unfinished: 1,
      job_error: { code: "INCOMPATIBLE_JOB_DATA" },
    });
  });
  test("quota-blocked misses remain pending while previously certified fresh hits complete", async () => {
    const initial = await admitted("city\nLondon\n");
    await processAll(initial);
    await r.store.cooldown(120);
    const next = await admitted("city\nLondon\nUnknown\n");
    await r.reconciler.tick();
    await processAll(next);
    expect(await invariant(next)).toMatchObject({
      status: "pending",
      succeeded: 1,
      pending: 1,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const blocked = await r.db.bulkResult.findFirstOrThrow({
      where: { job_id: next, status: "pending" },
    });
    expect((blocked.last_error as { code: string }).code).toBe(
      "PROVIDER_QUOTA_EXCEEDED",
    );
    await r.index.del("cityweather:cooldown");
    await r.db.bulkResult.update({
      where: { id: blocked.id },
      data: { resume_at: null },
    });
    await processAll(next);
    expect((await invariant(next)).status).toBe("done");
  });
  test("30-day due geo is retained and fresh hit schedules independent revalidation", async () => {
    const id = await admitted("city\nLondon\n");
    await processAll(id);
    await r.db.cityAlias.updateMany({
      data: { revalidate_after: new Date(0) },
    });
    const second = await admitted("city\nLondon\n");
    await processAll(second);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const dispatch = await r.db.bulkDispatch.findFirstOrThrow({
      where: { kind: "revalidate-alias" },
    });
    expect(dispatch.job_id).toBeNull();
    await r.reconciler.revalidate(dispatch.alias_id!, dispatch.generation);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      (await r.resolver.lookup("London", "bulk_unambiguous"))!.version,
    ).toBe(2);
  });
  test("declared non-UTF8 multipart charset is rejected", async () => {
    const boundary = "testboundary";
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.csv"\r\nContent-Type: text/csv; charset=windows-1252\r\n\r\ncity\nLondon\n\r\n--${boundary}--\r\n`;
    const res = await request(app)
      .post("/bulk/import")
      .set("X-API-Key", r.cfg.API_KEY)
      .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(res.status).toBe(415);
    expect(res.body.code).toBe("UNSUPPORTED_CSV_ENCODING");
    expect(await r.db.bulkJob.count()).toBe(0);
  });
  test("same reservation Lua has exact controlled rolling-window boundaries and concurrency", async () => {
    let time = 1000,
      sequence = 0;
    // Adapter lives only in the test; production always executes Redis TIME.
    const reserve = () =>
      r.redis.eval(
        reserveScript.replace(
          /local t = redis.call\('TIME'\)\s*local now = [^\n]+/,
          `local now = ${time}`,
        ),
        {
          keys: [
            "test-boundary:minute",
            "test-boundary:month",
            "test-boundary:cooldown",
          ],
          arguments: ["3", "4", String(++sequence)],
        },
      ) as Promise<number[]>;
    const start = await Promise.all(Array.from({ length: 20 }, reserve));
    expect(start.filter((x) => x[0] === 0)).toHaveLength(3);
    time = 60999;
    expect((await reserve())[0]).toBe(1);
    time = 61000;
    expect((await reserve())[0]).toBe(0); // minute exact boundary
    time = 121000;
    expect((await reserve())[0]).toBe(1); // month remains full
    time = 2678401000;
    expect((await reserve())[0]).toBe(0); // exact rolling month
    expect((await r.store.inspect()).available).toBe(
      r.cfg.PROVIDER_CALLS_PER_MINUTE,
    );
  });
  test("Redis cache outage fails weather closed while history and durable results stay readable", async () => {
    const id = await admitted("city\nLondon\n");
    r.index.disconnect();
    try {
      expect(
        (
          await request(app)
            .get("/weather?city=London")
            .set("X-API-Key", r.cfg.API_KEY)
        ).status,
      ).toBe(503);
      expect(
        (await request(app).get("/history").set("X-API-Key", r.cfg.API_KEY))
          .status,
      ).toBe(200);
      expect((await r.repo.status(id)).pending).toBe(1);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await r.index.connect();
    }
    await processAll(id);
    expect((await invariant(id)).succeeded).toBe(1);
  });
  test("DB commit interruption after cache write resumes from cache without duplicating success", async () => {
    const id = await admitted("city\nLondon\n");
    const spy = jest
      .spyOn(r.repo, "finish")
      .mockRejectedValueOnce(new Error("DB interrupted"));
    await processAll(id);
    spy.mockRestore();
    expect((await invariant(id)).succeeded).toBe(0);
    const calls = fetcher.mock.calls.length;
    await r.db.bulkResult.updateMany({
      where: { job_id: id },
      data: { resume_at: null },
    });
    await processAll(id);
    expect((await invariant(id)).succeeded).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });
  test("exact 10 MiB file is admitted; one extra file byte is rejected despite multipart overhead", async () => {
    const maximum = 10485760,
      line = "London" + " ".repeat(193) + "\n";
    const records = Math.floor((maximum - 5) / line.length);
    const exact = Buffer.from(
      "city\n" +
        line.repeat(records) +
        " ".repeat(maximum - 5 - records * line.length),
    );
    expect(exact.length).toBe(maximum);
    const good = await upload(exact);
    expect(good.status).toBe(202);
    expect((await r.repo.status(good.body.job_id)).admitted_entries).toBe(1);
    expect(
      (await upload(Buffer.concat([exact, Buffer.from("\n")]))).status,
    ).toBe(413);
    expect(await r.db.bulkJob.count()).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  }, 30000);
  test("compatible legacy query weather is reused only after strict identity and coordinate verification", async () => {
    const query = "London,GB",
      key = createHash("sha256").update(query.toLowerCase()).digest("hex");
    await r.resolver.resolve(query, "bulk_unambiguous");
    await r.store.set("geo:" + key, JSON.stringify(geo), 86400);
    await r.store.set("weather:v2:fresh:" + key, JSON.stringify(weather), 500);
    await r.store.set(
      "weather:v2:stale:" + key,
      JSON.stringify(weather),
      86000,
    );
    const id = await admitted('city\n"London,GB"\n');
    await processAll(id);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const result = await r.db.bulkResult.findFirstOrThrow({
      where: { job_id: id },
    });
    expect(result.source).toBe("cache");
    expect(
      await r.index.pttl(r.fetcher.key(result.city_id!)),
    ).toBeLessThanOrEqual(500000);
  });
  test("coordinate drift preserves UUID, invalidates older weather, and older rebuild cannot replace new index", async () => {
    const id = await admitted("city\nLondon\n");
    await processAll(id);
    const old = (await r.resolver.lookup("London", "bulk_unambiguous"))!;
    fetcher.mockResolvedValueOnce(response(200, [{ ...geo, lat: 51.6 }]));
    const changed = await r.resolver.resolve("London", "bulk_unambiguous", old);
    expect(changed.city_id).toBe(old.city_id);
    expect(changed.city!.verification_version).toBe(2);
    expect(await r.fetcher.cached(changed)).toBeUndefined();
    expect(await r.db.placeIdentityKey.count()).toBe(2);
    await r.resolver.mirror(old);
    const index = JSON.parse(
      (await r.index.get(r.resolver.key("London", "bulk_unambiguous")))!,
    );
    expect(index.version).toBe(changed.version);
    expect(index.city.lat).toBe(51.6);
  });
  test("identity conflict invalidates reuse and leaves work pending for mapping review", async () => {
    const old = await r.resolver.resolve("London", "bulk_unambiguous");
    fetcher.mockResolvedValueOnce(
      response(200, [{ name: "Other", country: "GB", lat: 50, lon: 1 }]),
    );
    await r.resolver.resolve("Other", "bulk_unambiguous");
    fetcher.mockResolvedValueOnce(
      response(200, [{ name: "Other", country: "GB", lat: 50, lon: 1 }]),
    );
    await expect(
      r.resolver.resolve("London", "bulk_unambiguous", old),
    ).rejects.toMatchObject({ code: "IDENTITY_REVIEW_REQUIRED" });
    await expect(
      r.resolver.lookup("London", "bulk_unambiguous"),
    ).rejects.toMatchObject({ code: "IDENTITY_REVIEW_REQUIRED" });
    const id = await admitted("city\nLondon\n");
    await processAll(id);
    expect((await invariant(id)).recovery_conditions[0]!.condition).toBe(
      "identity_mapping_repaired",
    );
  });
  test("full provider state names substantiate qualification and missing metadata fails explicitly", async () => {
    fetcher.mockResolvedValueOnce(
      response(200, [
        {
          name: "Portland",
          country: "US",
          state: "Oregon",
          lat: 45.5,
          lon: -122.6,
        },
      ]),
    );
    expect(
      (await r.resolver.resolve("Portland,OR,US", "bulk_unambiguous")).city!
        .country,
    ).toBe("US");
    fetcher.mockResolvedValueOnce(
      response(200, [
        { name: "Portland", country: "US", lat: 45.5, lon: -122.6 },
      ]),
    );
    await expect(
      r.resolver.resolve("Portland,ME,US", "bulk_unambiguous"),
    ).rejects.toMatchObject({ code: "CITY_QUALIFICATION_UNVERIFIABLE" });
  });
  test("invalid provider payload stays pending with a typed reason", async () => {
    const id = await admitted("city\nLondon\n");
    fetcher
      .mockResolvedValueOnce(response(200, [geo]))
      .mockResolvedValueOnce(response(200, { invalid: true }));
    await processAll(id);
    const item = await r.db.bulkResult.findFirstOrThrow({
      where: { job_id: id },
    });
    expect(item.status).toBe("pending");
    expect(item.last_error).toMatchObject({ code: "PROVIDER_INVALID_PAYLOAD" });
    expect((await invariant(id)).processed).toBe(0);
  });
  test("staging database errors are 503 and never mislabeled malformed CSV", async () => {
    const spy = jest
      .spyOn(r.repo, "stage")
      .mockRejectedValueOnce(new Error("DB interrupted"));
    try {
      const res = await upload("city\nLondon\n");
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("DEPENDENCY_UNAVAILABLE");
    } finally {
      spy.mockRestore();
    }
    expect(await r.db.bulkJob.count()).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  });
  test("slow multipart upload times out with 408 and removes its raw staging files", async () => {
    const slow = createApp(
      r.cfg.API_KEY,
      r.weather,
      r.history,
      bulkRoutes({ ...r.cfg, BULK_UPLOAD_TIMEOUT_MS: 40 }, r.repo, r.queue),
    );
    const server = slow.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: "127.0.0.1",
            port: address.port,
            method: "POST",
            path: "/bulk/import",
            headers: {
              "X-API-Key": r.cfg.API_KEY,
              "Content-Type": "multipart/form-data; boundary=slow",
            },
          },
          (res) => {
            res.resume();
            res.once("end", () => {
              resolve(res.statusCode!);
              req.destroy();
            });
          },
        );
        req.once("error", reject);
        req.write(
          '--slow\r\nContent-Disposition: form-data; name="file"; filename="slow.csv"\r\nContent-Type: text/csv\r\n\r\ncity\n',
        );
      });
      expect(status).toBe(408);
      expect(await readdir(dir)).toEqual([]);
      expect(await r.db.bulkJob.count()).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
