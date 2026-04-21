import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import { redisSub, redisClient, stockKey } from '../config/redis';
import { verifyToken, JwtPayload } from '../utils/jwt';
import { logger } from '../utils/logger';
import { AppDataSource, FlashSale } from '../config/database';

interface AuthenticatedSocket extends Socket {
  data: {
    userId: string;
    role: 'user' | 'admin';
  };
}

let io: SocketServer;

// ─── HELPER: get productId for a sale ────────────────────────────────────────
async function getSaleProductId(saleId: string): Promise<{ productId: string } | null> {
  try {
    return await AppDataSource.getRepository(FlashSale).findOne({
      where: { id: saleId },
      select: ['productId'],
    });
  } catch {
    return null;
  }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
export function initSocketServer(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: {
      origin: [
        process.env.FRONTEND_URL || 'http://localhost:5173',
        'http://localhost:3000',
      ],
      credentials: true,
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 20000,
    pingInterval: 25000,
    path: '/socket.io/',
  });

  setupAuthMiddleware();
  setupConnectionHandlers();
  setupRedisBridge();

  logger.info('Socket.IO server initialized');
  return io;
}

// ─── TASK 3: JWT AUTH MIDDLEWARE ──────────────────────────────────────────────
function setupAuthMiddleware(): void {
  io.use((socket: AuthenticatedSocket, next) => {
    const rawToken = socket.handshake.auth?.token as string
      || socket.handshake.headers?.authorization as string
      || (socket.handshake.query?.token as string);

    if (!rawToken) {
      logger.warn('WebSocket rejected: no token', { ip: socket.handshake.address });
      return next(new Error('Authentication required'));
    }

    const token = rawToken.startsWith('Bearer ') ? rawToken.slice(7) : rawToken;

    try {
      const payload = verifyToken(token) as JwtPayload;
      socket.data.userId = payload.sub;
      socket.data.role = payload.role;
      next();
    } catch {
      logger.warn('WebSocket rejected: invalid token');
      next(new Error('Invalid or expired token'));
    }
  });
}

// ─── TASK 4: CONNECTION HANDLERS ─────────────────────────────────────────────
function setupConnectionHandlers(): void {
  io.on('connection', (socket: AuthenticatedSocket) => {
    const { userId } = socket.data;
    logger.info('WebSocket connected', { userId, socketId: socket.id });

    // Join private user room for order confirmations
    const userRoom = `user-${userId}`;
    socket.join(userRoom);

    // Subscribe to sale room + send current stock
    socket.on('subscribe:sale', async (saleId: string) => {
      if (!saleId || typeof saleId !== 'string') return;

      socket.join(`sale-${saleId}`);

      try {
        const sale = await getSaleProductId(saleId);
        if (sale) {
          const stock = await redisClient.get(stockKey(saleId, sale.productId));
          socket.emit('stock:update', {
            saleId,
            stockRemaining: stock !== null ? parseInt(stock) : 0,
          });
        }
      } catch {
        logger.warn('Could not send initial stock', { saleId });
      }

      logger.debug('Subscribed to sale', { userId, saleId });
    });

    // Leave sale room
    socket.on('unsubscribe:sale', (saleId: string) => {
      if (!saleId || typeof saleId !== 'string') return;
      socket.leave(`sale-${saleId}`);
      logger.debug('Unsubscribed from sale', { userId, saleId });
    });

    // Disconnection cleanup
    socket.on('disconnect', (reason) => {
      logger.info('WebSocket disconnected', { userId, socketId: socket.id, reason });
    });
  });
}

// ─── TASK 5: REDIS PUB/SUB BRIDGE ────────────────────────────────────────────
function setupRedisBridge(): void {
  redisSub.subscribe('stock-updates', 'order-updates', (err, count) => {
    if (err) {
      logger.error('Redis pub/sub subscribe failed', { err: err.message });
      return;
    }
    logger.info(`Redis pub/sub: subscribed to ${count} channels`);
  });

  redisSub.on('message', (channel: string, message: string) => {
    try {
      const data = JSON.parse(message);

      if (channel === 'stock-updates') {
        const { type, saleId, productId, remaining, totalStock, finalStockRemaining } = data;

        if (type === 'stock:decremented') {
          // Broadcast stock update to everyone in the sale room
          io.to(`sale-${saleId}`).emit('stock:update', {
            saleId, productId,
            stockRemaining: remaining,
          });
        }

        if (type === 'sale:started') {
          io.to(`sale-${saleId}`).emit('sale:started', {
            saleId, productId, totalStock,
          });
        }

        if (type === 'sale:ended') {
          io.to(`sale-${saleId}`).emit('sale:ended', {
            saleId, finalStockRemaining,
          });
        }
      }

      if (channel === 'order-updates') {
        const { type, orderId, userId, paymentId, reason } = data;

        if (type === 'order:confirmed') {
          // Push ONLY to the buyer's private room
          io.to(`user-${userId}`).emit('order:confirmed', {
            orderId, paymentId,
            message: 'Your purchase was successful!',
          });
          logger.debug('Emitted order:confirmed', { orderId, userId });
        }

        if (type === 'order:failed') {
          io.to(`user-${userId}`).emit('order:failed', {
            orderId, reason,
            message: 'Payment failed. Your stock has been released.',
          });
          logger.debug('Emitted order:failed', { orderId, userId });
        }
      }
    } catch (err) {
      logger.error('Redis bridge parse error', { channel, message });
    }
  });
}

export function getSocketServer(): SocketServer {
  if (!io) throw new Error('Socket.IO server not initialized');
  return io;
}
