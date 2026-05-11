import 'dotenv/config';
import 'reflect-metadata';
import express, { Application, Request, Response } from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { startWorkers } from './workers/queue.worker';
import rateLimit from 'express-rate-limit'; 
import { AppDataSource } from './config/database';
import { loadLuaScripts, redisClient } from './config/redis';
import { errorHandler } from './middleware/errorHandler';
import { logger } from './utils/logger';
import authRoutes from './routes/auth.routes';
import saleRoutes from './routes/sale.routes';
import orderRoutes from './routes/order.routes';
import inventoryRoutes from './routes/inventory.routes';
import metricsRoutes from './routes/metrics.routes';
import adminRoutes from './routes/admin.routes';
import swaggerUi from 'swagger-ui-express';
import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import path from 'path';

import { authenticate, authorize } from './middleware/auth';
import { initSocketServer } from './websocket/socket.handler';

const app: Application = express();
export const httpServer = createServer(app);

// Swagger setup
const swaggerDoc = load(
  readFileSync(path.join(__dirname, '../docs/swagger.yaml'), 'utf8')
) as object;

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));

app.set('trust proxy', 1);
// ─── MIDDLEWARE (ORDER MATTERS) ──────────────────────────────────────────────

// 1. Security headers — must be first
app.use(helmet());

// 2. CORS — allow only your frontend origin
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:5173',
    'http://localhost:3000',
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-idempotency-key'],
}));

// 3. Gzip compression for responses
app.use(compression());

// 4. Body parsing — limit to 10kb to prevent payload attacks
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// 5. Global rate limiter — 200 req/min per IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 2000, // ← raised during load testing (k6 = 1 IP, 500 requests)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use(globalLimiter);

// ─── HEALTH CHECK (must be before auth middleware) ───────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: Date.now(),
    uptime: process.uptime(),
  });
});

// ─── ROUTES (uncomment as you build them in Day 3) ───────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/sales', saleRoutes);
app.use('/api/orders', authenticate, orderRoutes);
app.use('/api/inventory', authenticate, inventoryRoutes);
app.use('/api/metrics', authenticate, authorize('admin'), metricsRoutes);
app.use('/api/admin', adminRoutes);

// ─── GLOBAL ERROR HANDLER (must be LAST middleware) ──────────────────────────
app.use(errorHandler);

// ─── BOOTSTRAP FUNCTION ──────────────────────────────────────────────────────
async function bootstrap(): Promise<void> {
  // 1. Connect to PostgreSQL
  await AppDataSource.initialize();
  logger.info('PostgreSQL connected');

  // 2. Load Lua scripts into Redis
  await loadLuaScripts();
  startWorkers();  
  initSocketServer(httpServer);
  logger.info('Socket.IO initialized');

  // 3. Start HTTP server
  const PORT = parseInt(process.env.PORT || '3000');
  httpServer.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });

  // 4. Graceful shutdown handlers
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}

async function gracefulShutdown(): Promise<void> {
  logger.info('Shutting down gracefully...');
  httpServer.close(async () => {
    await AppDataSource.destroy();
    await redisClient.quit();
    logger.info('Shutdown complete');
    process.exit(0);
  });
}

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error('🔥 Bootstrap failed! Raw error below:');
    console.error(err);
    process.exit(1);
  });
}

export default app;