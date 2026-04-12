import 'reflect-metadata';
import { AppDataSource } from './config/database';
import { logger } from './utils/logger';
import { AppError } from './utils/errors';

async function bootstrap() {
  logger.info('Starting Flash Sale backend...');
  // Full implementation comes Day 2
}

bootstrap().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});