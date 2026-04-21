import { Router, Request, Response, NextFunction } from 'express';
import { redisClient, metricsKey } from '../config/redis';
import { AppError } from '../utils/errors';

const router = Router();

router.get('/:saleId', async (req, res, next) => {
  try {
    const { saleId } = req.params;
    const metrics = await redisClient.hgetall(metricsKey(saleId));
    if (!metrics || Object.keys(metrics).length === 0) throw new AppError(404, 'No metrics found for this sale');
    const parsed = Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, isNaN(Number(v)) ? v : Number(v)]));
    res.json({ status: 'success', data: { saleId, metrics: parsed } });
  } catch (err) { next(err); }
});

export default router;
