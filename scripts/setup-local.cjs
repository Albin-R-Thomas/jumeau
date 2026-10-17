const { randomBytes } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

// Never read existing configuration or display generated credentials.
const password = randomBytes(32).toString('hex');
const settings = [
  'NODE_ENV=production',
  'PORT=3000',
  `API_KEY=${randomBytes(32).toString('hex')}`,
  'POSTGRES_DB=cityweather',
  'POSTGRES_USER=cityweather',
  `POSTGRES_PASSWORD=${password}`,
  `DATABASE_URL=postgresql://cityweather:${password}@postgres:5432/cityweather`,
  'REDIS_URL=redis://redis:6379',
  'WEATHER_CACHE_TTL_SECONDS=900',
  'PROVIDER_TIMEOUT_MS=5000',
  'PROVIDER_MAX_RETRIES=2',
  'PROVIDER_CALLS_PER_MINUTE=55',
  'PROVIDER_CALLS_PER_MONTH=900000',
];
try {
  writeFileSync(resolve(__dirname, '../.env.runtime'), settings.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Local runtime configuration created. Existing .env preserved.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('Local runtime configuration already exists; preserved.');
  else { console.error('Could not create local runtime configuration.'); process.exitCode = 1; }
}
