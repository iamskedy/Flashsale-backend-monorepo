import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt';
import { AppError } from '../utils/errors';

/**
 * authenticate — verifies JWT from Authorization header.
 * Attaches decoded payload to req.user.
 * Throws 401 if token is missing, invalid, or expired.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new AppError(401, 'Authorization header missing or malformed'));
  }

  const token = authHeader.split(' ')[1];

  try {
    req.user = verifyToken(token);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * authorize — checks req.user.role is in the allowed roles list.
 * Must be used AFTER authenticate middleware.
 * Throws 403 if user does not have the required role.
 */
export function authorize(...roles: Array<'user' | 'admin'>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new AppError(401, 'Not authenticated'));
    }
    if (!roles.includes(req.user.role)) {
      return next(new AppError(403, `Access denied. Required role: ${roles.join(' or ')}`));
    }
    next();
  };
}