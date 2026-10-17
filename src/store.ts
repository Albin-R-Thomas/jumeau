import { randomUUID } from "node:crypto";
import { ApiError, unavailable } from "./errors";
import { Store } from "./types";
// Depend on the commands used, without coupling to Redis module/RESP generics.
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}
// Redis server time and one Lua transaction make both rolling windows atomic.
export const reserveScript = `
local t = redis.call('TIME')
local now = tonumber(t[1])*1000 + math.floor(tonumber(t[2])/1000)
local cooldown = redis.call('PTTL', KEYS[3])
if cooldown > 0 then return {2, math.ceil(cooldown/1000),3} end
local month = 2678400000
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now-60000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now-month)
local wait = 0
local window = 0
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  wait = math.max(wait, math.ceil((tonumber(oldest[2])+60000-now)/1000))
  window = 1
end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[2]) then
  local oldest = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
  local monthwait = math.ceil((tonumber(oldest[2])+month-now)/1000)
  if monthwait >= wait then wait=monthwait; window=2 end
end
if wait > 0 then return {1, wait,window} end
redis.call('ZADD', KEYS[1], now, ARGV[3])
redis.call('ZADD', KEYS[2], now, ARGV[3])
redis.call('PEXPIRE', KEYS[1], 60000)
redis.call('PEXPIRE', KEYS[2], month)
return {0,0}
`;
export class RedisStore implements Store {
  constructor(
    private redis: RedisClient,
    private minute: number,
    private month: number,
    private prefix = "cityweather:",
  ) {}
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw unavailable();
    }
  }
  get(key: string) {
    return this.run(() => this.redis.get(this.prefix + key));
  }
  async set(key: string, value: string, ttl: number) {
    await this.run(() => this.redis.set(this.prefix + key, value, { EX: ttl }));
  }
  async reserve() {
    await this.run(async () => {
      const result = (await this.redis.eval(reserveScript, {
        keys: ["minute", "month", "cooldown"].map((k) => this.prefix + k),
        arguments: [String(this.minute), String(this.month), randomUUID()],
      })) as number[];
      if (result[0] !== 0) {
        const error = new ApiError(
          429,
          result[0] === 2 ? "PROVIDER_QUOTA_EXCEEDED" : "LOCAL_QUOTA_EXCEEDED",
          "Provider call budget is unavailable.",
          result[1],
        );
        error.workerWindow =
          result[2] === 2 ? "month" : result[0] === 2 ? "cooldown" : "minute";
        throw error;
      }
    });
  }
  async cooldown(seconds: number) {
    await this.run(() =>
      this.redis.eval(
        `local ttl=redis.call('PTTL',KEYS[1]); if ttl<tonumber(ARGV[1]) then redis.call('PSETEX',KEYS[1],ARGV[1],'1') end; return 1`,
        {
          keys: [this.prefix + "cooldown"],
          arguments: [String(seconds * 1000)],
        },
      ),
    );
  }
  async inspect(): Promise<{
    available: number;
    retry_after: number;
    reason: string | null;
    now: number;
    resume_at: number | null;
  }> {
    return this.run(async () => {
      const values = (await this.redis.eval(
        `
        local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
        redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now-60000)
        redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',now-2678400000)
        local m=tonumber(ARGV[1])-redis.call('ZCARD',KEYS[1]); local mo=tonumber(ARGV[2])-redis.call('ZCARD',KEYS[2])
        local wait=0; local reason=0
        if m<=0 then local x=redis.call('ZRANGE',KEYS[1],0,0,'WITHSCORES'); wait=tonumber(x[2])+60000-now; reason=1 end
        if mo<=0 then local x=redis.call('ZRANGE',KEYS[2],0,0,'WITHSCORES'); local w=tonumber(x[2])+2678400000-now; if w>wait then wait=w; reason=2 end end
        local cooldown=redis.call('PTTL',KEYS[3]); if cooldown>wait then wait=cooldown; reason=3 end
        return {now,math.max(0,math.min(m,mo)),math.ceil(wait/1000),reason}
      `,
        {
          keys: ["minute", "month", "cooldown"].map((k) => this.prefix + k),
          arguments: [String(this.minute), String(this.month)],
        },
      )) as number[];
      const [now, available, retry, reason] = values as [
        number,
        number,
        number,
        number,
      ];
      return {
        now,
        available: reason ? 0 : available,
        retry_after: retry,
        reason: [null, "minute", "month", "cooldown"][reason] ?? null,
        resume_at: retry ? now + retry * 1000 : null,
      };
    });
  }
}
