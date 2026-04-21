import { Request, Response, NextFunction } from 'express';
import { validationResult, ValidationChain } from 'express-validator';
import { AppError } from '../utils/errors';

/**
 * Runs express-validator chains and throws 400 if any fail.
 * Usage: router.post('/route', [...validators], validate, handler)
 */
export const validate = (
  _req: Request,
  _res: Response,
  next: NextFunction
): void => {
  const errors = validationResult(_req);
  if (!errors.isEmpty()) {
    const messages = errors.array().map((e) => e.msg).join(', ');
    return next(new AppError(400, `Validation failed: ${messages}`));
  }
  next();
};

/**
 * Helper to wrap validation chains + validate into a single middleware array.
 * Usage: router.post('/route', validateRequest([body('email').isEmail()]), handler)
 */
export const validateRequest = (chains: ValidationChain[]) => [
  ...chains,
  validate,
];