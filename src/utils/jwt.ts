import jwt from 'jsonwebtoken';
import { AppError } from './errors';

export interface JwtPayload {
  sub: string;
  role: 'user' | 'admin';
  iat?: number;
  exp?: number;
}

const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_EXPIRES_IN = '24h';

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is not set');
}

export function signToken(userId: string, role: 'user' | 'admin'): string {
  return jwt.sign(
    { sub: userId, role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' }
  );
}

export function verifyToken(token: string): JwtPayload {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    return decoded as JwtPayload;
  } catch (err) {
    
    if (err instanceof Error && err.name === 'TokenExpiredError') {
      throw new AppError(401, 'Token has expired. Please log in again.');
    }
    if (err instanceof Error && err.name === 'JsonWebTokenError') {
      throw new AppError(401, 'Invalid token. Please log in again.');
    }
    if (err instanceof AppError) throw err;
    throw new AppError(401, 'Authentication failed.');
  }
}
