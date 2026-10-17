// Isolated integration harness, never used by the production worker command.
if (process.env.NODE_ENV !== "test" || !process.send) process.exit(2);
const { config } = require("../dist/src/config");
const { runtime } = require("../dist/src/runtime");
const { startWorker } = require("../dist/src/bulk/worker");
async function main() {
  const r = await runtime(config(process.env), {
    fetcher: async (input) => {
      const u = new URL(String(input));
      const body = u.pathname.includes("geo")
        ? [{ name: "London", country: "GB", lat: 51.5, lon: -0.12 }]
        : {
            name: "London",
            sys: { country: "GB" },
            main: { temp: 18.5, humidity: 72 },
            weather: [{ description: "clouds" }],
            dt: 1791964800,
          };
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });
  const stop = async () => {
    process.send({ barrier: process.env.TEST_CRASH_STAGE });
    await new Promise(() => {});
  };
  const write = r.fetcher.write.bind(r.fetcher);
  r.fetcher.write = async (...args) => {
    if (process.env.TEST_CRASH_STAGE === "before-cache") await stop();
    await write(...args);
    if (process.env.TEST_CRASH_STAGE === "after-cache") await stop();
  };
  const finish = r.repo.finish.bind(r.repo);
  r.repo.finish = async (...args) => {
    await finish(...args);
    if (args[1].snapshot && process.env.TEST_CRASH_STAGE === "after-commit")
      await stop();
  };
  await r.queue.queue.waitUntilReady();
  startWorker(r);
  process.send({ ready: true });
}
main().catch(() => {
  if (process.send) process.send({ error: "HARNESS_FAILED" });
  process.exit(1);
});
