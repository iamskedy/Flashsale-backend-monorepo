import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction  // Must have 4 parameters for Express to recognize as error middleware
): void {
  if ((err as any).type === 'validation' || (err as any).array) {
    const messages = typeof (err as any).array === 'function'
      ? (err as any).array().map((e: any) => e.msg).join(', ')
      : err.message;
    res.status(422).json({
      status: 'error',
      message: `Validation failed: ${messages}`,
    });
    return;
  }
  if (err instanceof AppError) {
    // Operational error — expected, return the message to client
    res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
    return;
  }

  // Programmer error — unexpected, log full stack, return generic 500
  logger.error('Unhandled error', {
    message: err.message,
    stack: err.stack,
  });

  res.status(500).json({
    status: 'error',
    message: 'Internal server error',
  });
}