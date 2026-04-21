import { Router, Request, Response, NextFunction } from 'express';
import { body } from 'express-validator';
import bcrypt from 'bcryptjs';
import { AppDataSource, User } from '../config/database';
import { signToken } from '../utils/jwt';
import { AppError } from '../utils/errors';
import { validateRequest } from '../middleware/validate';

const router = Router();
const userRepo = () => AppDataSource.getRepository(User);

router.post(
  '/register',
  validateRequest([
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('role').optional().isIn(['user', 'admin']).withMessage('Role must be user or admin'),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password, role = 'user' } = req.body;
      const existing = await userRepo().findOne({ where: { email } });
      if (existing) throw new AppError(409, 'Email already registered');
      const passwordHash = await bcrypt.hash(password, 12);
      const user = userRepo().create({ email, passwordHash, role });
      await userRepo().save(user);
      const token = signToken(user.id, user.role);
      res.status(201).json({ status: 'success', token, user: { id: user.id, email: user.email, role: user.role } });
    } catch (err) { next(err); }
  }
);

router.post(
  '/login',
  validateRequest([
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body;
      const user = await userRepo().findOne({ where: { email } });
      if (!user) throw new AppError(401, 'Invalid email or password');
      const isValid = await bcrypt.compare(password, user.passwordHash);
      if (!isValid) throw new AppError(401, 'Invalid email or password');
      const token = signToken(user.id, user.role);
      res.json({ status: 'success', token, user: { id: user.id, email: user.email, role: user.role } });
    } catch (err) { next(err); }
  }
);

export default router;
