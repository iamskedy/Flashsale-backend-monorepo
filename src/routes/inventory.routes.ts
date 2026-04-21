import { Router, Request, Response, NextFunction } from 'express';
import { redisClient, stockKey } from '../config/redis';
import { AppDataSource, FlashSale } from '../config/database';
import { AppError } from '../utils/errors';

const router = Router();

router.get('/:saleId/stock', async (req, res, next) => {
  try {
    const { saleId } = req.params;
    const sale = await AppDataSource.getRepository(FlashSale).findOne({ where: { id: saleId } });
    if (!sale) throw new AppError(404, 'Sale not found');
    const stock = await redisClient.get(stockKey(saleId, sale.productId));
    res.json({ status: 'success', data: { saleId, productId: sale.productId, stock: stock !== null ? parseInt(stock) : 0, source: 'redis' } });
  } catch (err) { next(err); }
});

export default router;
