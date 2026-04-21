import { Router, Request, Response, NextFunction } from 'express';
import { body } from 'express-validator';
import { AppDataSource, FlashSale, Product } from '../config/database';
import { AppError } from '../utils/errors';
import { validateRequest } from '../middleware/validate';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();
const saleRepo = () => AppDataSource.getRepository(FlashSale);

router.get('/', async (_req, res, next) => {
  try {
    const sales = await saleRepo().find({ relations: ['product'], order: { startTime: 'DESC' }, take: 20 });
    res.json({ status: 'success', data: sales });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const sale = await saleRepo().findOne({ where: { id: req.params.id }, relations: ['product'] });
    if (!sale) throw new AppError(404, 'Sale not found');
    res.json({ status: 'success', data: sale });
  } catch (err) { next(err); }
});

router.post('/',
  authenticate, authorize('admin'),
  validateRequest([
    body('productId').isUUID().withMessage('Valid productId UUID required'),
    body('salePrice').isFloat({ min: 0.01 }).withMessage('salePrice must be positive'),
    body('totalStock').isInt({ min: 1 }).withMessage('totalStock must be at least 1'),
    body('maxPerUser').optional().isInt({ min: 1 }),
    body('startTime').isISO8601().withMessage('startTime must be ISO8601 date'),
    body('endTime').isISO8601().withMessage('endTime must be ISO8601 date'),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { productId, salePrice, totalStock, maxPerUser = 1, startTime, endTime } = req.body;
      const product = await AppDataSource.getRepository(Product).findOne({ where: { id: productId } });
      if (!product) throw new AppError(404, 'Product not found');
      if (new Date(startTime) >= new Date(endTime)) throw new AppError(400, 'startTime must be before endTime');
      const sale = saleRepo().create({ productId, salePrice, totalStock, maxPerUser, startTime: new Date(startTime), endTime: new Date(endTime), status: 'scheduled' });
      await saleRepo().save(sale);
      res.status(201).json({ status: 'success', data: sale });
    } catch (err) { next(err); }
  }
);

export default router;
