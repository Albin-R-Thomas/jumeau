const { PrismaClient } = require('@prisma/client');
const { createClient } = require('redis');
async function main() {
  const db = new PrismaClient();
  const redis = createClient({ url: process.env.REDIS_URL });
  redis.on('error', () => {});
  try {
    await db.$connect();
    await redis.connect();
    const history = await db.searchHistory.count();
    const quota = await redis.zCard('cityweather:month');
    console.log(`History rows: ${history}; retained provider attempts: ${quota}.`);
  } finally {
    await db.$disconnect();
    if (redis.isOpen) await redis.quit();
  }
}
main().catch(() => { console.error('Persistence check failed.'); process.exitCode = 1; });
