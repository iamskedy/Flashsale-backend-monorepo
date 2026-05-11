import { Router, Request, Response, NextFunction } from 'express';
import { body, param } from 'express-validator';
import { AppDataSource, FlashSale, Product } from '../config/database';
import { AppError } from '../utils/errors';
import { validateRequest } from '../middleware/validate';
import { authenticate, authorize } from '../middleware/auth';
import { redisClient, stockKey } from '../config/redis';

const router = Router();

// All admin routes require authentication + admin role
router.use(authenticate, authorize('admin'));

const saleRepo = () => AppDataSource.getRepository(FlashSale);
const productRepo = () => AppDataSource.getRepository(Product);

// ─── PRODUCT ROUTES ───────────────────────────────────────────────────────────

/**
 * GET /api/admin/products
 * List all products (paginated)
 */
router.get('/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const search = (req.query.search as string) || '';

    const qb = productRepo()
      .createQueryBuilder('product')
      .orderBy('product.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (search) {
      qb.where('product.name ILIKE :search OR product.description ILIKE :search', {
        search: `%${search}%`,
      });
    }

    const [products, total] = await qb.getManyAndCount();

    res.json({
      status: 'success',
      data: products,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/products/:id
 * Get a single product
 */
router.get(
  '/products/:id',
  validateRequest([param('id').isUUID()]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const product = await productRepo().findOne({ where: { id: req.params.id } });
      if (!product) throw new AppError(404, 'Product not found');
      res.json({ status: 'success', data: product });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/admin/products
 * Create a new product
 */
router.post(
  '/products',
  validateRequest([
    body('name').notEmpty().trim().withMessage('Product name is required'),
    body('basePrice').isFloat({ min: 0.01 }).withMessage('basePrice must be a positive number'),
    body('description').optional().isString(),
    body('imageUrl').optional().isURL().withMessage('imageUrl must be a valid URL'),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, basePrice, description, imageUrl } = req.body;

      const existing = await productRepo().findOne({ where: { name } });
      if (existing) throw new AppError(409, `Product with name "${name}" already exists`);

      const product = productRepo().create({ name, basePrice, description, imageUrl });
      await productRepo().save(product);

      res.status(201).json({ status: 'success', data: product });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /api/admin/products/:id
 * Update an existing product
 */
router.put(
  '/products/:id',
  validateRequest([
    param('id').isUUID(),
    body('name').optional().notEmpty().trim(),
    body('basePrice').optional().isFloat({ min: 0.01 }),
    body('description').optional().isString(),
    body('imageUrl').optional().isURL().withMessage('imageUrl must be a valid URL'),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const product = await productRepo().findOne({ where: { id: req.params.id } });
      if (!product) throw new AppError(404, 'Product not found');

      const { name, basePrice, description, imageUrl } = req.body;
      if (name !== undefined) product.name = name;
      if (basePrice !== undefined) product.basePrice = basePrice;
      if (description !== undefined) product.description = description;
      if (imageUrl !== undefined) product.imageUrl = imageUrl;

      await productRepo().save(product);
      res.json({ status: 'success', data: product });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /api/admin/products/:id
 * Delete a product (only if no active/scheduled flash sales reference it)
 */
router.delete(
  '/products/:id',
  validateRequest([param('id').isUUID()]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const product = await productRepo().findOne({ where: { id: req.params.id } });
      if (!product) throw new AppError(404, 'Product not found');

      // Guard: prevent deletion if active/scheduled sales exist
      const activeSales = await saleRepo()
        .createQueryBuilder('sale')
        .where('sale.productId = :id AND sale.status IN (:...statuses)', {
          id: req.params.id,
          statuses: ['scheduled', 'active'],
        })
        .getCount();

      if (activeSales > 0) {
        throw new AppError(
          409,
          'Cannot delete product with active or scheduled flash sales. Cancel those sales first.'
        );
      }

      await productRepo().remove(product);
      res.json({ status: 'success', message: 'Product deleted' });
    } catch (err) {
      next(err);
    }
  }
);

// ─── FLASH SALE ROUTES ────────────────────────────────────────────────────────

/**
 * GET /api/admin/sales
 * List all flash sales with product info (paginated, filterable by status)
 */
router.get('/sales', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const status = req.query.status as string;

    const qb = saleRepo()
      .createQueryBuilder('sale')
      .leftJoinAndSelect('sale.product', 'product')
      .orderBy('sale.startTime', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (status && ['scheduled', 'active', 'ended', 'cancelled'].includes(status)) {
      qb.where('sale.status = :status', { status });
    }

    const [sales, total] = await qb.getManyAndCount();

    // Enrich each sale with live Redis stock level
    const enriched = await Promise.all(
      sales.map(async (sale) => {
        const redisStock = await redisClient.get(stockKey(sale.id, sale.productId));
        return {
          ...sale,
          remainingStock: redisStock !== null ? parseInt(redisStock) : null,
        };
      })
    );

    res.json({
      status: 'success',
      data: enriched,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/sales
 * Create a new flash sale
 */
router.post(
  '/sales',
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

      const product = await productRepo().findOne({ where: { id: productId } });
      if (!product) throw new AppError(404, 'Product not found');

      if (new Date(startTime) >= new Date(endTime))
        throw new AppError(400, 'startTime must be before endTime');

      // Check for overlapping active/scheduled sale for the same product
      const overlap = await saleRepo()
        .createQueryBuilder('sale')
        .where(
          `sale.productId = :productId
          AND sale.status IN ('scheduled','active')
          AND tstzrange(sale."startTime", sale."endTime") && tstzrange(:start, :end)`,
          { productId, start: startTime, end: endTime }
        )
        .getOne();

      if (overlap) throw new AppError(409, 'Another sale for this product overlaps the chosen time window');

      const sale = saleRepo().create({
        productId,
        salePrice,
        totalStock,
        maxPerUser,
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        status: 'scheduled',
      });
      await saleRepo().save(sale);

      await redisClient.set(stockKey(sale.id, sale.productId), sale.totalStock.toString());

      res.status(201).json({ status: 'success', data: { ...sale, product } });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /api/admin/sales/:id
 * Update a flash sale (only if still scheduled)
 */
router.put(
  '/sales/:id',
  validateRequest([
    param('id').isUUID(),
    body('salePrice').optional().isFloat({ min: 0.01 }),
    body('totalStock').optional().isInt({ min: 1 }),
    body('maxPerUser').optional().isInt({ min: 1 }),
    body('startTime').optional().isISO8601(),
    body('endTime').optional().isISO8601(),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sale = await saleRepo().findOne({
        where: { id: req.params.id },
        relations: ['product'],
      });
      if (!sale) throw new AppError(404, 'Sale not found');
      if (sale.status !== 'scheduled')
        throw new AppError(400, `Cannot edit a sale that is ${sale.status}`);

      const { salePrice, totalStock, maxPerUser, startTime, endTime } = req.body;

      const newStart = startTime ? new Date(startTime) : sale.startTime;
      const newEnd = endTime ? new Date(endTime) : sale.endTime;
      if (newStart >= newEnd) throw new AppError(400, 'startTime must be before endTime');

      if (salePrice !== undefined) sale.salePrice = salePrice;
      if (maxPerUser !== undefined) sale.maxPerUser = maxPerUser;
      if (startTime) sale.startTime = newStart;
      if (endTime) sale.endTime = newEnd;

      if (totalStock !== undefined) {
        sale.totalStock = totalStock;
        // Sync Redis stock
        await redisClient.set(stockKey(sale.id, sale.productId), totalStock.toString());
      }

      await saleRepo().save(sale);
      res.json({ status: 'success', data: sale });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /api/admin/sales/:id/cancel
 * Cancel a scheduled or active flash sale
 */
router.patch(
  '/sales/:id/cancel',
  validateRequest([param('id').isUUID()]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sale = await saleRepo().findOne({ where: { id: req.params.id } });
      if (!sale) throw new AppError(404, 'Sale not found');
      if (sale.status === 'ended' || sale.status === 'cancelled')
        throw new AppError(400, `Sale is already ${sale.status}`);

      sale.status = 'cancelled';
      await saleRepo().save(sale);

      // Zero out Redis stock so no further purchases go through
      await redisClient.set(stockKey(sale.id, sale.productId), '0');

      res.json({ status: 'success', data: sale });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/admin/dashboard
 * Quick stats overview for the admin dashboard
 */
router.get('/dashboard', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [totalProducts, totalSales, activeSales, scheduledSales] = await Promise.all([
      productRepo().count(),
      saleRepo().count(),
      saleRepo().count({ where: { status: 'active' } }),
      saleRepo().count({ where: { status: 'scheduled' } }),
    ]);

    const recentSales = await saleRepo().find({
      relations: ['product'],
      order: { createdAt: 'DESC' },
      take: 5,
    });

    res.json({
      status: 'success',
      data: {
        stats: { totalProducts, totalSales, activeSales, scheduledSales },
        recentSales,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
