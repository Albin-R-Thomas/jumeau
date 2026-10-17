// Run against disposable test services. API RSS is measured in a separate child.
if (process.env.NODE_ENV !== "test")
  throw new Error("Use isolated test dependencies.");
const { createWriteStream, openAsBlob } = require("node:fs");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { once } = require("node:events");
const { fork } = require("node:child_process");
const assert = require("node:assert/strict");
async function main() {
  const directory = await mkdtemp(join(tmpdir(), "large-admission-")),
    key = "large-test-placeholder";
  const child = fork(join(__dirname, "test-large-server.cjs"), [], {
    execArgv: ["--max-old-space-size=128"],
    env: {
      ...process.env,
      API_KEY: key,
      OPENWEATHER_API_KEY: "unused-placeholder",
      BULK_STAGING_DIR: join(directory, "staging"),
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const ready = await new Promise((resolve, reject) => {
    child.on("message", (m) => {
      if (m.ready) resolve(m);
      if (m.error) reject(new Error(m.error));
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code) reject(new Error("API harness exited."));
    });
  });
  let sequence = 0;
  const jobs = [];
  const rpc = (command, extra = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const listener = (m) => {
        if (m.request === id) {
          child.off("message", listener);
          m.error ? reject(new Error(m.error)) : resolve(m);
        }
      };
      child.on("message", listener);
      child.send({ request: id, command, ...extra });
    });
  const headers = { "X-API-Key": key },
    base = `http://127.0.0.1:${ready.port}`,
    started = Date.now();
  try {
    for (const count of [100000, 100001]) {
      const path = join(directory, "cities.csv"),
        out = createWriteStream(path);
      for (let i = 0; i < count; i++)
        if (!out.write(`City ${i}\n`)) await once(out, "drain");
      out.end();
      await once(out, "finish");
      const form = new FormData();
      form.append(
        "file",
        await openAsBlob(path, { type: "text/csv" }),
        "cities.csv",
      );
      const res = await fetch(base + "/bulk/import", {
          method: "POST",
          headers,
          body: form,
        }),
        body = await res.json();
      if (count === 100000) {
        assert.equal(res.status, 202, JSON.stringify(body));
        jobs.push(body.job_id);
        const s = await (
          await fetch(`${base}/bulk/jobs/${body.job_id}`, { headers })
        ).json();
        assert.equal(s.admitted_entries, 100000);
        assert.equal(s.total, 100000);
      } else {
        assert.equal(res.status, 413, JSON.stringify(body));
        assert.equal(body.code, "TOO_MANY_ROWS");
      }
    }
    const { metrics } = await rpc("measure");
    console.log(
      JSON.stringify({
        rows_accepted: 100000,
        rows_rejected: 100001,
        ...metrics,
        elapsed_seconds: +((Date.now() - started) / 1000).toFixed(2),
      }),
    );
    assert.equal(metrics.provider_attempts, 0);
    assert.ok(metrics.max_batch <= 500);
    assert.ok(metrics.peak_rss_mib < 256, "API RSS exceeds 256 MiB target.");
  } finally {
    try {
      await rpc("cleanup", { jobs });
    } finally {
      if (child.connected) child.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
