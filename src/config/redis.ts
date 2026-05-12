import Redis from 'ioredis';
import { logger } from '../utils/logger';

// ─── CLIENT 1: For regular commands ────────────────────────────────────────
export const redisClient = new Redis(process.env.REDIS_URL!, {
  tls: {},
  retryStrategy(times: number) {
    if (times > 10) {
      logger.error('Redis: max retries reached. Giving up.');
      return null;
    }
    const delay = Math.min(times * 200, 3000);
    logger.warn(`Redis: retry attempt ${times}, waiting ${delay}ms`);
    return delay;
  },
  lazyConnect: false,
  enableReadyCheck: true,
  maxRetriesPerRequest: 3,
});

// ─── CLIENT 2: Dedicated to pub/sub ────────────────────────────────────────
export const redisSub = new Redis(process.env.REDIS_URL!, {
  tls: {},
  retryStrategy(times: number) {
    if (times > 10) return null;
    return Math.min(times * 200, 3000);
  },
});

// ─── EVENT HANDLERS ──────────────────────────────────────────────────────────
redisClient.on('connect', () => logger.info('Redis (commands): connected'));
redisClient.on('ready', () => logger.info('Redis (commands): ready'));
redisClient.on('error', (err) => logger.error('Redis (commands) error', { err: err.message }));
redisClient.on('close', () => logger.warn('Redis (commands): connection closed'));

redisSub.on('connect', () => logger.info('Redis (pub/sub): connected'));
redisSub.on('error', (err) => logger.error('Redis (pub/sub) error', { err: err.message }));

// ─── REDIS KEY HELPERS ────────────────────────────────────────────────────────
// Centralise all key patterns. Never hardcode key strings in services.

/** Remaining inventory counter for a sale item */
export const stockKey = (saleId: string, productId: string): string =>
  `stock:${saleId}:${productId}`;

/** How many units this user has purchased in this sale (24h TTL) */
export const userLimitKey = (saleId: string, userId: string): string =>
  `userlimit:${saleId}:${userId}`;

/** Idempotency guard — prevents double-click or retry duplicates (5min TTL) */
export const idempotentKey = (userId: string, saleId: string): string =>
  `idempotent:${userId}:${saleId}`;

/** Cached sale metadata from PostgreSQL (60s TTL) */
export const saleMetaKey = (saleId: string): string =>
  `sale:meta:${saleId}`;

/** Redis HASH storing performance metrics per sale (7d TTL) */
export const metricsKey = (saleId: string): string =>
  `metrics:${saleId}`;

// ─── TTL CONSTANTS (in seconds) ──────────────────────────────────────────────
export const TTL = {
  IDEMPOTENCY: 300,        // 5 minutes
  USER_LIMIT: 86400,       // 24 hours
  SALE_META: 60,           // 60 seconds
  METRICS: 604800,         // 7 days
} as const;



// ─── LUA SCRIPTS ──────────────────────────────────────────────────────────────
// These are loaded at startup via SCRIPT LOAD, then called via EVALSHA.
// This avoids sending the full script text on every purchase call.

/**
 * Lua Purchase Script — runs 6 Redis operations atomically in a single round-trip
 *
 * KEYS[1]: idempotent:{userId}:{saleId}   — duplicate check key
 * KEYS[2]: stock:{saleId}:{productId}     — inventory counter
 * KEYS[3]: userlimit:{saleId}:{userId}    — per-user purchase counter
 *
 * ARGV[1]: qty          — quantity requested
 * ARGV[2]: maxPerUser   — max units allowed per user for this sale
 * ARGV[3]: ttl          — TTL for idempotency key (300 seconds)
 *
 * Returns: {qty, 'OK'} on success
 *          {-1, 'SOLD_OUT'} if stock < qty
 *          {-2, 'DUPLICATE'} if idempotency key exists
 *          {-3, 'USER_LIMIT'} if user already at max
 */
export const LUA_PURCHASE_SCRIPT = `
local qty = tonumber(ARGV[1])
local maxPerUser = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

-- Step 1: Check idempotency (prevents duplicate purchase on retry/double-click)
if redis.call('EXISTS', KEYS[1]) == 1 then
  return {-2, 'DUPLICATE'}
end

-- Step 2: Check per-user purchase limit
local bought = tonumber(redis.call('GET', KEYS[3]) or '0')
if bought + qty > maxPerUser then
  return {-3, 'USER_LIMIT'}
end

-- Step 3: Check stock availability
local stock = tonumber(redis.call('GET', KEYS[2]) or '0')
if stock < qty then
  return {-1, 'SOLD_OUT'}
end

-- Step 4: Decrement stock atomically
redis.call('DECRBY', KEYS[2], qty)

-- Step 5: Update user purchase counter (reset after 24h)
redis.call('SETEX', KEYS[3], 86400, tostring(bought + qty))

-- Step 6: Set idempotency key with TTL
redis.call('SETEX', KEYS[1], ttl, '1')

return {qty, 'OK'}
`;

/**
 * Lua Rollback Script — atomically restores stock on payment failure
 *
 * KEYS[1]: stock:{saleId}:{productId}   — inventory counter
 * KEYS[2]: userlimit:{saleId}:{userId}  — per-user counter
 *
 * ARGV[1]: qty     — quantity to restore
 */
export const LUA_ROLLBACK_SCRIPT = `
local qty = tonumber(ARGV[1])

-- Restore stock
redis.call('INCRBY', KEYS[1], qty)

-- Reduce user limit counter (but not below 0)
local current = tonumber(redis.call('GET', KEYS[2]) or '0')
local newVal = math.max(0, current - qty)
redis.call('SET', KEYS[2], tostring(newVal))

return {qty, 'ROLLED_BACK'}
`;

// SHA hashes — populated at startup by loadLuaScripts()
export let purchaseSha = '';
export let rollbackSha = '';

/**
 * Must be called once at application startup before any purchases are processed.
 * Loads both Lua scripts into Redis script cache and stores the SHA hashes.
 */
export async function loadLuaScripts(): Promise<void> {
  purchaseSha = await redisClient.script('LOAD', LUA_PURCHASE_SCRIPT) as string;
  rollbackSha = await redisClient.script('LOAD', LUA_ROLLBACK_SCRIPT) as string;
  logger.info('Lua scripts loaded', { purchaseSha, rollbackSha });
}

export const getSha = () => ({ purchaseSha, rollbackSha });

