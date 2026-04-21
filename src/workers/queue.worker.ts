import { Worker, Job } from 'bullmq';
import { AppDataSource, Order, FlashSale } from '../config/database';
import { redisClient, stockKey, rollbackSha, userLimitKey } from '../config/redis';
import { logger } from '../utils/logger';
import { incrementRollback } from '../services/metrics.service';

// ─── BULLMQ CONNECTION (same Upstash TLS config) ─────────────────────────────
function parseBullMQConnection() {
  const url = process.env.REDIS_URL!;
  const match = url.match(/rediss?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)/);
  if (!match) throw new Error('Invalid REDIS_URL format');
  return {
    username: match[1],
    password: match[2],
    host: match[3],
    port: parseInt(match[4]),
    tls: {},
  };
}

const REDIS_CONNECTION = parseBullMQConnection();

// ─── MOCK PAYMENT GATEWAY (5% failure rate) ───────────────────────────────────
async function callPaymentGateway(amount: number): Promise<string> {
  await new Promise(r => setTimeout(r, 200 + Math.random() * 300)); // 200-500ms
  if (Math.random() < 0.05) throw new Error('Payment gateway timeout');
  return `pay_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// ─── ORDER WORKER (concurrency: 50) ──────────────────────────────────────────
export const orderWorker = new Worker(
  'orders',
  async (job: Job) => {
    const { orderId, userId, saleId, productId, quantity, totalAmount } = job.data;
    logger.info('Processing payment', { orderId, attempt: job.attemptsMade + 1 });

    try {
      const paymentId = await callPaymentGateway(totalAmount);

      // Confirm order in DB
      await AppDataSource.getRepository(Order).update(
        { id: orderId },
        { status: 'confirmed', paymentId }
      );

      // Notify user via pub/sub (WebSocket layer picks this up in Day 5)
      await redisClient.publish('order-updates', JSON.stringify({
        type: 'order:confirmed',
        orderId, userId, paymentId,
      }));

      logger.info('Payment confirmed', { orderId, paymentId });

    } catch (err) {
      // Only rollback on final attempt
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 3)) {
        logger.error('Payment failed — rolling back', { orderId });

        // Rollback stock via Lua
        await redisClient.evalsha(
          rollbackSha, 2,
          stockKey(saleId, productId),
          userLimitKey(saleId, userId),
          quantity.toString(),
        );

        // Mark order failed
        await AppDataSource.getRepository(Order).update(
          { id: orderId },
          { status: 'failed' }
        );

        await incrementRollback(saleId);

        await redisClient.publish('order-updates', JSON.stringify({
          type: 'order:failed',
          orderId, userId,
          reason: 'Payment processing failed',
        }));
      }

      throw err; // Re-throw so BullMQ retries
    }
  },
  { connection: REDIS_CONNECTION, concurrency: 50 }
);

// ─── SALE LIFECYCLE WORKER (concurrency: 5) ───────────────────────────────────
export const lifecycleWorker = new Worker(
  'sale-lifecycle',
  async (job: Job) => {
    const { type, saleId, productId, totalStock } = job.data;

    if (type === 'start-sale') {
      await redisClient.set(stockKey(saleId, productId), totalStock.toString());
      await AppDataSource.getRepository(FlashSale).update({ id: saleId }, { status: 'active' });
      await redisClient.publish('stock-updates', JSON.stringify({ type: 'sale:started', saleId, productId, totalStock }));
      logger.info('Sale started', { saleId });
    }

    if (type === 'end-sale') {
      await AppDataSource.getRepository(FlashSale).update({ id: saleId }, { status: 'ended' });
      const finalStock = await redisClient.get(stockKey(saleId, productId));
      await redisClient.publish('stock-updates', JSON.stringify({ type: 'sale:ended', saleId, finalStockRemaining: finalStock ? parseInt(finalStock) : 0 }));
      logger.info('Sale ended', { saleId });
    }
  },
  { connection: REDIS_CONNECTION, concurrency: 5 }
);

// ─── NOTIFICATION WORKER (concurrency: 100) ───────────────────────────────────
export const notificationWorker = new Worker(
  'notifications',
  async (job: Job) => {
    const { type, userId, orderId } = job.data;
    logger.info(`[NOTIFICATION] ${type} → userId:${userId} orderId:${orderId}`);
    // TODO: await sendEmail / sendPush
  },
  { connection: REDIS_CONNECTION, concurrency: 100 }
);

export function startWorkers(): void {
  logger.info('BullMQ workers started', {
    orderConcurrency: 50,
    lifecycleConcurrency: 5,
    notificationConcurrency: 100,
  });
}
