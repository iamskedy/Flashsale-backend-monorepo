import { Router, Request, Response, NextFunction } from 'express';
import { body } from 'express-validator';
import { AppDataSource, Order } from '../config/database';
import { AppError } from '../utils/errors';
import { validateRequest } from '../middleware/validate';
import rateLimit from 'express-rate-limit';
import { processPurchase } from '../services/purchase.service';
import { ipKeyGenerator } from 'express-rate-limit'; 

const router = Router();
const orderRepo = () => AppDataSource.getRepository(Order);

const purchaseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
 
  keyGenerator: (req) => req.user?.sub ?? ipKeyGenerator(req),
  message: { error: 'Too many purchase attempts. Please wait a minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/purchase',
  purchaseLimiter,
  validateRequest([
    body('saleId').isUUID().withMessage('Valid saleId UUID required'),
    body('productId').isUUID().withMessage('Valid productId UUID required'),
    body('quantity').isInt({ min: 1, max: 10 }).withMessage('Quantity must be 1-10'),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const idempotencyKey = req.headers['x-idempotency-key'] as string;
      if (!idempotencyKey) throw new AppError(400, 'x-idempotency-key header is required');

      const { saleId, productId, quantity } = req.body;

      const result = await processPurchase(   // ← REPLACE stub with this
        req.user!.sub,
        saleId,
        productId,
        quantity,
        idempotencyKey,
      );

      res.status(202).json({ status: 'accepted', data: result });
    } catch (err) { next(err); }
  }
);

router.get('/my-orders', async (req, res, next) => {
  try {
    const orders = await orderRepo().find({ where: { userId: req.user!.sub }, order: { createdAt: 'DESC' }, take: 50 });
    res.json({ status: 'success', data: orders });
  } catch (err) { next(err); }
});

router.get('/:orderId', async (req, res, next) => {
  try {
    const order = await orderRepo().findOne({ where: { id: req.params.orderId } });
    if (!order) throw new AppError(404, 'Order not found');
    if (order.userId !== req.user!.sub) throw new AppError(403, 'Access denied');
    res.json({ status: 'success', data: order });
  } catch (err) { next(err); }
});

export default router;
