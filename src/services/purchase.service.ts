import { AppDataSource, FlashSale, Order, InventoryLog } from '../config/database';
import {
  redisClient,
  stockKey,
  userLimitKey,
  idempotentKey,
  saleMetaKey,
  TTL,
  purchaseSha,
  rollbackSha,
} from '../config/redis';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { incrementPurchase, incrementError, recordLatency, incrementRollback } from './metrics.service';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';

// ─── BULLMQ CONNECTION (Upstash-compatible) ───────────────────────────────────
// BullMQ requires host/port/password separately — parse from REDIS_URL
function parseBullMQConnection() {
  const url = process.env.REDIS_URL!;
  // rediss://default:PASSWORD@HOST:PORT
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

const BULL_CONNECTION = parseBullMQConnection();

export const ordersQueue = new Queue('orders', {
  connection: BULL_CONNECTION,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

export const lifecycleQueue = new Queue('sale-lifecycle', {
  connection: BULL_CONNECTION,
});

export const notificationsQueue = new Queue('notifications', {
  connection: BULL_CONNECTION,
});

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface SaleMeta {
  id: string;
  productId: string;
  salePrice: number;
  totalStock: number;
  maxPerUser: number;
  startTime: number;
  endTime: number;
}

type LuaResult = [number, string];

// ─── STEP 1: GET SALE METADATA (cache-aside) ──────────────────────────────────
export async function getSaleMeta(saleId: string): Promise<SaleMeta> {
  const cached = await redisClient.get(saleMetaKey(saleId));
  if (cached) return JSON.parse(cached) as SaleMeta;

  const sale = await AppDataSource.getRepository(FlashSale).findOne({ where: { id: saleId } });
  if (!sale) throw new AppError(404, 'Sale not found');

  const meta: SaleMeta = {
    id: sale.id,
    productId: sale.productId,
    salePrice: Number(sale.salePrice),
    totalStock: sale.totalStock,
    maxPerUser: sale.maxPerUser,
    startTime: sale.startTime.getTime(),
    endTime: sale.endTime.getTime(),
  };

  await redisClient.setex(saleMetaKey(saleId), TTL.SALE_META, JSON.stringify(meta));
  return meta;
}

// ─── STEP 2: VALIDATE TIMING ──────────────────────────────────────────────────
export function validateTiming(sale: SaleMeta): void {
  const now = Date.now();
  if (now < sale.startTime) throw new AppError(400, 'Sale has not started yet');
  if (now > sale.endTime) throw new AppError(400, 'Sale has ended');
}

// ─── STEP 3: RUN LUA PURCHASE SCRIPT (ATOMIC) ────────────────────────────────
export async function runLuaPurchase(
  saleId: string,
  productId: string,
  userId: string,
  qty: number,
  maxPerUser: number,
  idempKey: string,
): Promise<void> {
  const result = await redisClient.evalsha(
    purchaseSha, 3,
    idempotentKey(userId, saleId),
    stockKey(saleId, productId),
    userLimitKey(saleId, userId),
    qty.toString(),
    maxPerUser.toString(),
    TTL.IDEMPOTENCY.toString(),
  ) as LuaResult;

  const [code, status] = result;

  if (status === 'DUPLICATE') {
    await incrementError(saleId, 'DUPLICATE');
    throw new AppError(409, 'Duplicate purchase — your order is already being processed');
  }
  if (status === 'USER_LIMIT') {
    await incrementError(saleId, 'USER_LIMIT');
    throw new AppError(429, `You have reached the maximum purchase limit for this sale`);
  }
  if (status === 'SOLD_OUT') {
    await incrementError(saleId, 'SOLD_OUT');
    throw new AppError(410, 'Sorry, this item is sold out');
  }
  if (status !== 'OK') {
    throw new AppError(500, 'Purchase failed. Please try again.');
  }
}

// ─── STEP 4: CREATE PENDING ORDER IN POSTGRESQL ───────────────────────────────
export async function createPendingOrder(
  userId: string,
  sale: SaleMeta,
  qty: number,
): Promise<Order> {
  const order = AppDataSource.getRepository(Order).create({
    userId,
    saleId: sale.id,
    productId: sale.productId,
    quantity: qty,
    unitPrice: sale.salePrice,
    totalAmount: sale.salePrice * qty,
    status: 'pending',
  });
  return AppDataSource.getRepository(Order).save(order);
}

// ─── STEP 5: LOG INVENTORY CHANGE ────────────────────────────────────────────
export async function logInventory(
  saleId: string,
  productId: string,
  qty: number,
  orderId: string,
  reason: string,
): Promise<void> {
  const log = AppDataSource.getRepository(InventoryLog).create({
    saleId, productId,
    delta: -qty,
    reason,
    orderId,
  });
  await AppDataSource.getRepository(InventoryLog).save(log);
}

// ─── STEP 6: ENQUEUE PAYMENT JOB ─────────────────────────────────────────────
export async function enqueuePaymentJob(order: Order, sale: SaleMeta): Promise<void> {
  await ordersQueue.add('process-payment', {
    orderId: order.id,
    userId: order.userId,
    saleId: sale.id,
    productId: sale.productId,
    quantity: order.quantity,
    totalAmount: order.totalAmount,
  });
}

// ─── STEP 7: PUBLISH STOCK UPDATE ────────────────────────────────────────────
export async function publishStockUpdate(
  saleId: string,
  productId: string,
): Promise<void> {
  const stock = await redisClient.get(stockKey(saleId, productId));
  await redisClient.publish('stock-updates', JSON.stringify({
    type: 'stock:decremented',
    saleId, productId,
    remaining: stock ? parseInt(stock) : 0,
  }));
}

// ─── MAIN PURCHASE FUNCTION (orchestrates all 7 steps) ───────────────────────
export async function processPurchase(
  userId: string,
  saleId: string,
  productId: string,
  qty: number,
  idempKey: string,
): Promise<{ orderId: string; status: string }> {
  const start = Date.now();

  // Step 1: Get sale metadata
  const sale = await getSaleMeta(saleId);

  // Step 2: Validate timing (no I/O)
  validateTiming(sale);

  // Step 3: Atomic Lua (single Redis round-trip)
  await runLuaPurchase(saleId, productId, userId, qty, sale.maxPerUser, idempKey);

  // Step 4: Create pending order in DB
  const order = await createPendingOrder(userId, sale, qty);

  // Steps 5-7: FIRE AND FORGET — do NOT await
  // These run after 202 is already sent to client
  setImmediate(() => {
    Promise.all([
      logInventory(saleId, productId, qty, order.id, 'purchase'),
      enqueuePaymentJob(order, sale),
      publishStockUpdate(saleId, productId),
      incrementPurchase(saleId),
    ]).catch(err => logger.error('Post-purchase async error', { err: err.message }));
  });

  await recordLatency(saleId, Date.now() - start);

  return { orderId: order.id, status: 'pending' };
}