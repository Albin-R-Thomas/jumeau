const { createHash } = require('node:crypto');
const { createClient } = require('redis');

async function main() {
  const redis = createClient({ url: process.env.REDIS_URL });
  redis.on('error', () => {});
  try {
    await redis.connect();
    const key = createHash('sha256').update('london,gb').digest('hex');
    const fresh = await redis.ttl('cityweather:weather:v2:fresh:' + key);
    const backup = await redis.ttl('cityweather:weather:v2:stale:' + key);
    if (process.env.WEATHER_CACHE_TTL_SECONDS !== '900' || fresh <= 0 || fresh > 900 || backup <= fresh || backup > 86400) {
      throw new Error('Cache TTL check failed.');
    }
    console.log(`Fresh cache policy: 900 seconds; remaining fresh TTL: ${fresh}; remaining backup TTL: ${backup}.`);
  } finally {
    if (redis.isOpen) await redis.quit();
  }
}
main().catch(() => { console.error('Cache verification failed.'); process.exitCode = 1; });
