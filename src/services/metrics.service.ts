import { redisClient, metricsKey, TTL } from '../config/redis';

export async function incrementPurchase(saleId: string): Promise<void> {
  const key = metricsKey(saleId);
  await redisClient.hincrby(key, 'totalPurchases', 1);
  await redisClient.expire(key, TTL.METRICS);
}

export async function incrementError(saleId: string, reason: string): Promise<void> {
  const key = metricsKey(saleId);
  await redisClient.hincrby(key, `error_${reason}`, 1);
  await redisClient.expire(key, TTL.METRICS);
}

export async function recordLatency(saleId: string, ms: number): Promise<void> {
  const key = metricsKey(saleId);
  await redisClient.hincrbyfloat(key, 'totalLatencyMs', ms);
  await redisClient.hincrby(key, 'requestCount', 1);
  await redisClient.expire(key, TTL.METRICS);
}

export async function incrementRollback(saleId: string): Promise<void> {
  const key = metricsKey(saleId);
  await redisClient.hincrby(key, 'totalRollbacks', 1);
  await redisClient.expire(key, TTL.METRICS);
}
