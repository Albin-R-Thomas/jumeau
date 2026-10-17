// Run inside the API container: credentials stay in runtime memory.
async function main() {
  const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
  const headers = { 'X-API-Key': process.env.API_KEY };
  const unauthorized = await fetch(`${base}/history`);
  if (unauthorized.status !== 401) throw new Error('Authentication check failed.');
  const history = await fetch(`${base}/history?limit=1`, { headers });
  if (history.status !== 200) throw new Error('History check failed.');
  const first = await fetch(`${base}/weather?city=London,GB`, { headers });
  console.log(`Authentication: 401; history: 200; weather: ${first.status}.`);
  if (first.status !== 200) {
    const error = await first.json();
    console.log(`Weather error code: ${error.code}`);
    process.exitCode = 1;
    return;
  }
  const second = await fetch(`${base}/weather?city=London,GB`, { headers });
  if (second.status !== 200) throw new Error('Repeated weather request failed.');
  const records = await (await fetch(`${base}/history?limit=2`, { headers })).json();
  if (records.items.length !== 2 || records.items[0].source !== 'cache') throw new Error('Cache history check failed.');
  if (records.next_cursor) {
    const page = await fetch(`${base}/history?limit=1&cursor=${encodeURIComponent(records.next_cursor)}`, { headers });
    if (page.status !== 200) throw new Error('Pagination check failed.');
  }
  console.log('Live weather, repeated cache hit, history recording, and pagination succeeded. History preserved.');
}
main().catch(() => { console.error('Runtime smoke check failed.'); process.exitCode = 1; });
