// No giant string/array: usable for the 100,000/+1 admission boundary tests.
const { createWriteStream } = require('node:fs');
const { once } = require('node:events');
async function main() {
  const count = Number(process.argv[2] ?? 100000);
  if (!Number.isSafeInteger(count) || count < 1 || count > 100001) throw new Error('Rows must be 1–100001.');
  const out = createWriteStream(process.argv[3] ?? 'data/generated-large.csv');
  out.write('city\n');
  for (let i=0;i<count;i++) if (!out.write(`City ${i}\n`)) await once(out,'drain');
  out.end(); await once(out,'finish');
  console.log(`Generated ${count} data records.`);
}
main().catch(() => { console.error('Fixture generation failed.'); process.exit(1); });
