/**
 * Flash Sale System — Comprehensive Unit Test Suite
 *
 * Framework : Jest + ts-jest
 * Mocking   : jest.mock() for TypeORM, ioredis, BullMQ, bcryptjs, jsonwebtoken
 *
 * Install deps:
 *   npm install --save-dev jest ts-jest @types/jest supertest @types/supertest
 *
 * tsconfig additions (jest section in package.json):
 *   "jest": {
 *     "preset": "ts-jest",
 *     "testEnvironment": "node",
 *     "moduleNameMapper": { "^@/(.*)$": "<rootDir>/src/$1" }
 *   }
 *
 * Run: npx jest --coverage
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ─── MOCK SETUP ──────────────────────────────────────────────────────────────

// Mock ioredis before any import
jest.mock('ioredis', () => {
  const mockRedis = {
    get: jest.fn(),
    set: jest.fn(),
    setex: jest.fn(),
    evalsha: jest.fn(),
    publish: jest.fn(),
    hgetall: jest.fn(),
    hincrby: jest.fn(),
    hincrbyfloat: jest.fn(),
    expire: jest.fn(),
    script: jest.fn(),
    on: jest.fn(),
    quit: jest.fn(),
  };
  return jest.fn(() => mockRedis);
});

// Mock TypeORM DataSource
jest.mock('../src/config/database', () => {
  const mockRepository = {
    findOne: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    remove: jest.fn(),
    update: jest.fn(),
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
      getManyAndCount: jest.fn(),
      getCount: jest.fn(),
    })),
  };

  return {
    AppDataSource: {
      initialize: jest.fn(),
      destroy: jest.fn(),
      getRepository: jest.fn(() => mockRepository),
    },
    User: class User {},
    Product: class Product {},
    FlashSale: class FlashSale {},
    Order: class Order {},
    InventoryLog: class InventoryLog {},
    mockRepository,
  };
});

// Mock BullMQ
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue({ id: 'job-123' }),
  })),
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
  })),
}));

// Mock bcryptjs
jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('$2b$12$hashedpassword'),
  compare: jest.fn().mockResolvedValue(true),
}));

// Mock jsonwebtoken
jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('mock.jwt.token'),
  verify: jest.fn().mockReturnValue({ sub: '550e8400-e29b-41d4-a716-446655440001', role: 'user', iat: 1000, exp: 9999999999 }),
}));

// ─── IMPORTS (after mocks) ────────────────────────────────────────────────────

import supertest from 'supertest';
import app from '../src/server';

const request = supertest(app);

// Shorthand for mock redis client
const getRedisMock = () => {
  const Redis = require('ioredis');
  return Redis.mock.results[0]?.value ?? Redis();
};

// ─── TEST DATA FIXTURES ───────────────────────────────────────────────────────

const mockUser = {
  id: '550e8400-e29b-41d4-a716-446655440001',
  email: 'user@example.com',
  passwordHash: '$2b$12$hashedpassword',
  role: 'user' as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockAdmin = {
  ...mockUser,
  id: '550e8400-e29b-41d4-a716-446655440002',
  email: 'admin@example.com',
  role: 'admin' as const,
};

const mockProduct = {
  id: '550e8400-e29b-41d4-a716-446655440003',
  name: 'iPhone 16 Pro',
  description: 'Latest flagship',
  basePrice: 1099.00,
  imageUrl: 'https://example.com/iphone.jpg',
  createdAt: new Date(),
};

const mockSale = {
  id: '550e8400-e29b-41d4-a716-446655440004',
  productId: '550e8400-e29b-41d4-a716-446655440003',
  product: mockProduct,
  salePrice: 799.00,
  totalStock: 200,
  maxPerUser: 1,
  startTime: new Date(Date.now() - 3600000), // 1 hour ago (active)
  endTime: new Date(Date.now() + 3600000),   // 1 hour from now
  status: 'active' as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockOrder = {
  id: '550e8400-e29b-41d4-a716-446655440005',
  userId: '550e8400-e29b-41d4-a716-446655440001',
  saleId: '550e8400-e29b-41d4-a716-446655440004',
  productId: '550e8400-e29b-41d4-a716-446655440003',
  quantity: 1,
  unitPrice: 799.00,
  totalAmount: 799.00,
  status: 'pending' as const,
  paymentId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// JWT for a regular user (Authorization: Bearer ...)
const USER_TOKEN = 'Bearer mock.jwt.token';

// JWT for admin — we re-mock verify for admin routes
const getAdminToken = () => {
  const jwt = require('jsonwebtoken');
  jwt.verify.mockReturnValue({ sub: '550e8400-e29b-41d4-a716-446655440002', role: 'admin', iat: 1000, exp: 9999999999 });
  return 'Bearer mock.jwt.token';
};

// ─── HEALTH ───────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request.get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.timestamp).toBe('number');
    expect(typeof res.body.uptime).toBe('number');
  });
});

// ─── AUTH — REGISTER ──────────────────────────────────────────────────────────

describe('POST /api/auth/register', () => {
  let repo: any;

  beforeEach(() => {
    const { AppDataSource } = require('../src/config/database');
    repo = AppDataSource.getRepository();
    jest.clearAllMocks();
  });

  it('creates a user and returns a JWT', async () => {
    repo.findOne.mockResolvedValue(null);     // no existing user
    repo.create.mockReturnValue(mockUser);
    repo.save.mockResolvedValue(mockUser);

    const res = await request.post('/api/auth/register').send({
      email: 'newuser@example.com',
      password: 'SecurePass1!',
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.email).toBeDefined();
    expect(res.body.user.passwordHash).toBeUndefined(); // never expose hash
  });

  it('returns 409 when email already exists', async () => {
    repo.findOne.mockResolvedValue(mockUser);

    const res = await request.post('/api/auth/register').send({
      email: 'user@example.com',
      password: 'SecurePass1!',
    });

    expect(res.status).toBe(409);
    expect(res.body.message).toContain('already registered');
  });

  it('returns 422 for invalid email', async () => {
    const res = await request.post('/api/auth/register').send({
      email: 'not-an-email',
      password: 'SecurePass1!',
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 for short password', async () => {
    const res = await request.post('/api/auth/register').send({
      email: 'user@example.com',
      password: 'short',
    });
    expect(res.status).toBe(422);
  });
});

// ─── AUTH — LOGIN ─────────────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
  let repo: any;

  beforeEach(() => {
    const { AppDataSource } = require('../src/config/database');
    repo = AppDataSource.getRepository();
    jest.clearAllMocks();
  });

  it('returns JWT on valid credentials', async () => {
    repo.findOne.mockResolvedValue(mockUser);
    const bcrypt = require('bcryptjs');
    bcrypt.compare.mockResolvedValue(true);

    const res = await request.post('/api/auth/login').send({
      email: 'user@example.com',
      password: 'MyPassword1!',
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('returns 401 for wrong password', async () => {
    repo.findOne.mockResolvedValue(mockUser);
    const bcrypt = require('bcryptjs');
    bcrypt.compare.mockResolvedValue(false);

    const res = await request.post('/api/auth/login').send({
      email: 'user@example.com',
      password: 'wrongpassword',
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for non-existent email', async () => {
    repo.findOne.mockResolvedValue(null);

    const res = await request.post('/api/auth/login').send({
      email: 'ghost@example.com',
      password: 'SomePass1!',
    });
    expect(res.status).toBe(401);
  });
});

// ─── SALES — PUBLIC ───────────────────────────────────────────────────────────

describe('GET /api/sales', () => {
  let repo: any;

  beforeEach(() => {
    const { AppDataSource } = require('../src/config/database');
    repo = AppDataSource.getRepository();
    jest.clearAllMocks();
  });

  it('returns list of flash sales', async () => {
    repo.find.mockResolvedValue([mockSale]);

    const res = await request.get('/api/sales');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('GET /api/sales/:id', () => {
  let repo: any;

  beforeEach(() => {
    const { AppDataSource } = require('../src/config/database');
    repo = AppDataSource.getRepository();
    jest.clearAllMocks();
  });

  it('returns a sale by ID', async () => {
    repo.findOne.mockResolvedValue(mockSale);

    const res = await request.get(`/api/sales/${mockSale.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(mockSale.id);
  });

  it('returns 404 for unknown sale', async () => {
    repo.findOne.mockResolvedValue(null);

    const res = await request.get('/api/sales/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });
});

// ─── ORDERS — PURCHASE ────────────────────────────────────────────────────────

describe('POST /api/orders/purchase', () => {
  let repo: any;
  let redis: any;

  beforeEach(() => {
    const { AppDataSource } = require('../src/config/database');
    repo = AppDataSource.getRepository();
    redis = getRedisMock();
    jest.clearAllMocks();

    // Default: authenticated user
    const jwt = require('jsonwebtoken');
    jwt.verify.mockReturnValue({ sub: '550e8400-e29b-41d4-a716-446655440001', role: 'user', iat: 1000, exp: 9999999999 });
  });

  it('returns 202 on successful purchase', async () => {
    // getSaleMeta — Redis miss, then DB hit
    redis.get.mockResolvedValueOnce(null);              // cache miss
    repo.findOne.mockResolvedValueOnce(mockSale);       // DB lookup
    redis.setex.mockResolvedValue('OK');                // cache set

    // Lua returns OK
    redis.evalsha.mockResolvedValue([1, 'OK']);

    // Create pending order
    repo.create.mockReturnValue(mockOrder);
    repo.save.mockResolvedValue(mockOrder);

    // Metrics + publish (fire-and-forget)
    redis.hincrbyfloat.mockResolvedValue(1);
    redis.hincrby.mockResolvedValue(1);
    redis.expire.mockResolvedValue(1);

    const res = await request
      .post('/api/orders/purchase')
      .set('Authorization', USER_TOKEN)
      .set('x-idempotency-key', '550e8400-e29b-41d4-a716-446655440000')
      .send({ saleId: mockSale.id, productId: mockProduct.id, quantity: 1 });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('accepted');
    expect(res.body.data.orderId).toBeDefined();
    expect(res.body.data.status).toBe('pending');
  });

  it('returns 400 when x-idempotency-key is missing', async () => {
    const res = await request
      .post('/api/orders/purchase')
      .set('Authorization', USER_TOKEN)
      .send({ saleId: mockSale.id, productId: mockProduct.id, quantity: 1 });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('idempotency-key');
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request
      .post('/api/orders/purchase')
      .set('x-idempotency-key', '550e8400-e29b-41d4-a716-446655440000')
      .send({ saleId: mockSale.id, productId: mockProduct.id, quantity: 1 });

    expect(res.status).toBe(401);
  });

  it('returns 410 when Lua returns SOLD_OUT', async () => {
    redis.get.mockResolvedValueOnce(JSON.stringify({
      id: mockSale.id,
      productId: mockProduct.id,
      salePrice: 799,
      totalStock: 200,
      maxPerUser: 1,
      startTime: Date.now() - 3600000,
      endTime: Date.now() + 3600000,
    }));
    redis.evalsha.mockResolvedValue([-1, 'SOLD_OUT']);

    const res = await request
      .post('/api/orders/purchase')
      .set('Authorization', USER_TOKEN)
      .set('x-idempotency-key', '550e8400-e29b-41d4-a716-446655440001')
      .send({ saleId: mockSale.id, productId: mockProduct.id, quantity: 1 });

    expect(res.status).toBe(410);
    expect(res.body.message).toContain('sold out');
  });

  it('returns 409 when Lua returns DUPLICATE', async () => {
    redis.get.mockResolvedValueOnce(JSON.stringify({
      ...mockSale,
      startTime: Date.now() - 3600000,
      endTime: Date.now() + 3600000,
    }));
    redis.evalsha.mockResolvedValue([-2, 'DUPLICATE']);

    const res = await request
      .post('/api/orders/purchase')
      .set('Authorization', USER_TOKEN)
      .set('x-idempotency-key', '550e8400-e29b-41d4-a716-446655440002')
      .send({ saleId: mockSale.id, productId: mockProduct.id, quantity: 1 });

    expect(res.status).toBe(409);
    expect(res.body.message).toContain('Duplicate');
  });

  it('returns 429 when Lua returns USER_LIMIT', async () => {
    redis.get.mockResolvedValueOnce(JSON.stringify({
      ...mockSale,
      startTime: Date.now() - 3600000,
      endTime: Date.now() + 3600000,
    }));
    redis.evalsha.mockResolvedValue([-3, 'USER_LIMIT']);

    const res = await request
      .post('/api/orders/purchase')
      .set('Authorization', USER_TOKEN)
      .set('x-idempotency-key', '550e8400-e29b-41d4-a716-446655440003')
      .send({ saleId: mockSale.id, productId: mockProduct.id, quantity: 1 });

    expect(res.status).toBe(429);
  });

  it('returns 400 when sale has not started', async () => {
    redis.get.mockResolvedValueOnce(JSON.stringify({
      ...mockSale,
      startTime: Date.now() + 7200000, // future
      endTime: Date.now() + 10800000,
    }));

    const res = await request
      .post('/api/orders/purchase')
      .set('Authorization', USER_TOKEN)
      .set('x-idempotency-key', '550e8400-e29b-41d4-a716-446655440004')
      .send({ saleId: mockSale.id, productId: mockProduct.id, quantity: 1 });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('not started');
  });

  it('returns 422 for invalid quantity (0)', async () => {
    const res = await request
      .post('/api/orders/purchase')
      .set('Authorization', USER_TOKEN)
      .set('x-idempotency-key', '550e8400-e29b-41d4-a716-446655440005')
      .send({ saleId: mockSale.id, productId: mockProduct.id, quantity: 0 });

    expect(res.status).toBe(422);
  });
});

// ─── ORDERS — MY ORDERS ───────────────────────────────────────────────────────

describe('GET /api/orders/my-orders', () => {
  let repo: any;

  beforeEach(() => {
    const { AppDataSource } = require('../src/config/database');
    repo = AppDataSource.getRepository();
    jest.clearAllMocks();
    const jwt = require('jsonwebtoken');
    jwt.verify.mockReturnValue({ sub: '550e8400-e29b-41d4-a716-446655440001', role: 'user', iat: 1000, exp: 9999999999 });
  });

  it('returns orders for authenticated user', async () => {
    repo.find.mockResolvedValue([mockOrder]);

    const res = await request
      .get('/api/orders/my-orders')
      .set('Authorization', USER_TOKEN);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('returns 401 without auth', async () => {
    const res = await request.get('/api/orders/my-orders');
    expect(res.status).toBe(401);
  });
});

// ─── INVENTORY ────────────────────────────────────────────────────────────────

describe('GET /api/inventory/:saleId/stock', () => {
  let repo: any;
  let redis: any;

  beforeEach(() => {
    const { AppDataSource } = require('../src/config/database');
    repo = AppDataSource.getRepository();
    redis = getRedisMock();
    jest.clearAllMocks();
    const jwt = require('jsonwebtoken');
    jwt.verify.mockReturnValue({ sub: '550e8400-e29b-41d4-a716-446655440001', role: 'user', iat: 1000, exp: 9999999999 });
  });

  it('returns stock from Redis', async () => {
    repo.findOne.mockResolvedValue(mockSale);
    redis.get.mockResolvedValue('43');

    const res = await request
      .get(`/api/inventory/${mockSale.id}/stock`)
      .set('Authorization', USER_TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.data.stock).toBe(43);
    expect(res.body.data.source).toBe('redis');
  });

  it('returns 0 when Redis key is null', async () => {
    repo.findOne.mockResolvedValue(mockSale);
    redis.get.mockResolvedValue(null);

    const res = await request
      .get(`/api/inventory/${mockSale.id}/stock`)
      .set('Authorization', USER_TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.data.stock).toBe(0);
  });

  it('returns 404 for unknown sale', async () => {
    repo.findOne.mockResolvedValue(null);

    const res = await request
      .get('/api/inventory/00000000-0000-0000-0000-000000000000/stock')
      .set('Authorization', USER_TOKEN);

    expect(res.status).toBe(404);
  });
});

// ─── ADMIN — PRODUCTS ─────────────────────────────────────────────────────────

describe('Admin Products', () => {
  let repo: any;

  beforeEach(() => {
    const { AppDataSource } = require('../src/config/database');
    repo = AppDataSource.getRepository();
    jest.clearAllMocks();
    // All admin calls use admin token
    const jwt = require('jsonwebtoken');
    jwt.verify.mockReturnValue({ sub: '550e8400-e29b-41d4-a716-446655440002', role: 'admin', iat: 1000, exp: 9999999999 });
  });

  describe('GET /api/admin/products', () => {
        it('returns paginated products for admin', async () => {
      const qb = repo.createQueryBuilder();
      qb.getManyAndCount.mockResolvedValue([[mockProduct], 1]);  // ← already there but stale

      // ADD THIS — reset the mock so createQueryBuilder always returns the same qb
      repo.createQueryBuilder.mockReturnValue(qb);

      const res = await request
        .get('/api/admin/products')
        .set('Authorization', getAdminToken());

      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(1);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('returns 403 for non-admin user', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockReturnValue({ sub: '550e8400-e29b-41d4-a716-446655440001', role: 'user', iat: 1000, exp: 9999999999 });

      const res = await request
        .get('/api/admin/products')
        .set('Authorization', USER_TOKEN);

      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/admin/products', () => {
    it('creates a product', async () => {
      repo.findOne.mockResolvedValue(null);
      repo.create.mockReturnValue(mockProduct);
      repo.save.mockResolvedValue(mockProduct);

      const res = await request
        .post('/api/admin/products')
        .set('Authorization', getAdminToken())
        .send({ name: 'iPhone 16 Pro', basePrice: 1099 });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe('iPhone 16 Pro');
    });

    it('returns 409 when product name already exists', async () => {
      repo.findOne.mockResolvedValue(mockProduct);

      const res = await request
        .post('/api/admin/products')
        .set('Authorization', getAdminToken())
        .send({ name: 'iPhone 16 Pro', basePrice: 1099 });

      expect(res.status).toBe(409);
    });

    it('returns 422 when name is missing', async () => {
      const res = await request
        .post('/api/admin/products')
        .set('Authorization', getAdminToken())
        .send({ basePrice: 1099 });

      expect(res.status).toBe(422);
    });

    it('returns 422 when basePrice is negative', async () => {
      const res = await request
        .post('/api/admin/products')
        .set('Authorization', getAdminToken())
        .send({ name: 'Test Product', basePrice: -10 });

      expect(res.status).toBe(422);
    });
  });

  describe('PUT /api/admin/products/:id', () => {
    it('updates a product', async () => {
      const updated = { ...mockProduct, name: 'iPhone 17' };
      repo.findOne.mockResolvedValue({ ...mockProduct });
      repo.save.mockResolvedValue(updated);

      const res = await request
        .put(`/api/admin/products/${mockProduct.id}`)
        .set('Authorization', getAdminToken())
        .send({ name: 'iPhone 17' });

      expect(res.status).toBe(200);
    });

    it('returns 404 for unknown product', async () => {
      repo.findOne.mockResolvedValue(null);

      const res = await request
        .put('/api/admin/products/00000000-0000-0000-0000-000000000000')
        .set('Authorization', getAdminToken())
        .send({ name: 'New Name' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/admin/products/:id', () => {
    it('deletes a product with no active sales', async () => {
      repo.findOne.mockResolvedValue(mockProduct);
      const qb = repo.createQueryBuilder();
      qb.getCount.mockResolvedValue(0); // no active sales
      repo.remove.mockResolvedValue(mockProduct);

      const res = await request
        .delete(`/api/admin/products/${mockProduct.id}`)
        .set('Authorization', getAdminToken());

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Product deleted');
    });

    it('returns 409 when product has active sales', async () => {
      repo.findOne.mockResolvedValue(mockProduct);
      const qb = repo.createQueryBuilder();
      qb.getCount.mockResolvedValue(2); // 2 active/scheduled sales

      const res = await request
        .delete(`/api/admin/products/${mockProduct.id}`)
        .set('Authorization', getAdminToken());

      expect(res.status).toBe(409);
      expect(res.body.message).toContain('Cannot delete');
    });
  });
});

// ─── ADMIN — SALES ────────────────────────────────────────────────────────────

describe('Admin Flash Sales', () => {
  let repo: any;
  let redis: any;

  beforeEach(() => {
    const { AppDataSource } = require('../src/config/database');
    repo = AppDataSource.getRepository();
    redis = getRedisMock();
    jest.clearAllMocks();
    const jwt = require('jsonwebtoken');
    jwt.verify.mockReturnValue({ sub: '550e8400-e29b-41d4-a716-446655440002', role: 'admin', iat: 1000, exp: 9999999999 });
  });

  describe('GET /api/admin/sales', () => {
    it('returns paginated sales with Redis stock enrichment', async () => {
  const qb = repo.createQueryBuilder();
  qb.getManyAndCount.mockResolvedValue([[mockSale], 1]);

  // ADD THIS
  repo.createQueryBuilder.mockReturnValue(qb);

  redis.get.mockResolvedValue('43');

  const res = await request
    .get('/api/admin/sales')
    .set('Authorization', getAdminToken());

  expect(res.status).toBe(200);
  expect(res.body.data[0].remainingStock).toBe(43);
});
  });

  describe('POST /api/admin/sales', () => {
    it('creates a flash sale and seeds Redis stock', async () => {
      repo.findOne.mockResolvedValueOnce(mockProduct);
      const qb = repo.createQueryBuilder();
      qb.getOne.mockResolvedValue(null); // no overlap
      repo.create.mockReturnValue({ ...mockSale, status: 'scheduled' });
      repo.save.mockResolvedValue({ ...mockSale, status: 'scheduled' });
      redis.set.mockResolvedValue('OK');

      const res = await request
        .post('/api/admin/sales')
        .set('Authorization', getAdminToken())
        .send({
          productId: mockProduct.id,
          salePrice: 799,
          totalStock: 200,
          maxPerUser: 1,
          startTime: new Date(Date.now() + 3600000).toISOString(),
          endTime: new Date(Date.now() + 7200000).toISOString(),
        });

      expect(res.status).toBe(201);
      expect(redis.set).toHaveBeenCalled();
    });

    it('returns 400 when startTime >= endTime', async () => {
      const now = new Date();
      const res = await request
        .post('/api/admin/sales')
        .set('Authorization', getAdminToken())
        .send({
          productId: mockProduct.id,
          salePrice: 799,
          totalStock: 100,
          startTime: now.toISOString(),
          endTime: new Date(now.getTime() - 1000).toISOString(),
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('startTime');
    });

    it('returns 404 when product does not exist', async () => {
      repo.findOne.mockResolvedValue(null);

      const res = await request
        .post('/api/admin/sales')
        .set('Authorization', getAdminToken())
        .send({
          productId: '00000000-0000-0000-0000-000000000000',
          salePrice: 799,
          totalStock: 100,
          startTime: new Date(Date.now() + 3600000).toISOString(),
          endTime: new Date(Date.now() + 7200000).toISOString(),
        });

      expect(res.status).toBe(404);
    });

    it('returns 409 when overlapping sale exists', async () => {
      repo.findOne.mockResolvedValueOnce(mockProduct);
      const qb = repo.createQueryBuilder();
      qb.getOne.mockResolvedValue(mockSale); // overlap found

      const res = await request
        .post('/api/admin/sales')
        .set('Authorization', getAdminToken())
        .send({
          productId: mockProduct.id,
          salePrice: 799,
          totalStock: 100,
          startTime: new Date(Date.now() + 3600000).toISOString(),
          endTime: new Date(Date.now() + 7200000).toISOString(),
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain('overlaps');
    });
  });

  describe('PUT /api/admin/sales/:id', () => {
    it('updates a scheduled sale', async () => {
      const scheduledSale = { ...mockSale, status: 'scheduled' };
      repo.findOne.mockResolvedValue(scheduledSale);
      repo.save.mockResolvedValue({ ...scheduledSale, salePrice: 699 });
      redis.set.mockResolvedValue('OK');

      const res = await request
        .put(`/api/admin/sales/${mockSale.id}`)
        .set('Authorization', getAdminToken())
        .send({ salePrice: 699, totalStock: 150 });

      expect(res.status).toBe(200);
    });

    it('returns 400 when sale is active (cannot edit)', async () => {
      repo.findOne.mockResolvedValue({ ...mockSale, status: 'active' });

      const res = await request
        .put(`/api/admin/sales/${mockSale.id}`)
        .set('Authorization', getAdminToken())
        .send({ salePrice: 699 });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('active');
    });
  });

  describe('PATCH /api/admin/sales/:id/cancel', () => {
    it('cancels a scheduled sale and zeroes Redis stock', async () => {
      repo.findOne.mockResolvedValue({ ...mockSale, status: 'scheduled' });
      repo.save.mockResolvedValue({ ...mockSale, status: 'cancelled' });
      redis.set.mockResolvedValue('OK');

      const res = await request
        .patch(`/api/admin/sales/${mockSale.id}/cancel`)
        .set('Authorization', getAdminToken());

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('cancelled');
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining('stock:'),
        '0'
      );
    });

    it('cancels an active sale', async () => {
      repo.findOne.mockResolvedValue({ ...mockSale, status: 'active' });
      repo.save.mockResolvedValue({ ...mockSale, status: 'cancelled' });
      redis.set.mockResolvedValue('OK');

      const res = await request
        .patch(`/api/admin/sales/${mockSale.id}/cancel`)
        .set('Authorization', getAdminToken());

      expect(res.status).toBe(200);
    });

    it('returns 400 when sale is already ended', async () => {
      repo.findOne.mockResolvedValue({ ...mockSale, status: 'ended' });

      const res = await request
        .patch(`/api/admin/sales/${mockSale.id}/cancel`)
        .set('Authorization', getAdminToken());

      expect(res.status).toBe(400);
    });

    it('returns 400 when sale is already cancelled', async () => {
      repo.findOne.mockResolvedValue({ ...mockSale, status: 'cancelled' });

      const res = await request
        .patch(`/api/admin/sales/${mockSale.id}/cancel`)
        .set('Authorization', getAdminToken());

      expect(res.status).toBe(400);
    });
  });
});

// ─── ADMIN — DASHBOARD ────────────────────────────────────────────────────────

describe('GET /api/admin/dashboard', () => {
  let repo: any;

  beforeEach(() => {
    const { AppDataSource } = require('../src/config/database');
    repo = AppDataSource.getRepository();
    jest.clearAllMocks();
    const jwt = require('jsonwebtoken');
    jwt.verify.mockReturnValue({ sub: '550e8400-e29b-41d4-a716-446655440002', role: 'admin', iat: 1000, exp: 9999999999 });
  });

  it('returns aggregate stats and recent sales', async () => {
    repo.count
      .mockResolvedValueOnce(12)   // totalProducts
      .mockResolvedValueOnce(48)   // totalSales
      .mockResolvedValueOnce(2)    // activeSales
      .mockResolvedValueOnce(5);   // scheduledSales
    repo.find.mockResolvedValue([mockSale]);

    const res = await request
      .get('/api/admin/dashboard')
      .set('Authorization', getAdminToken());

    expect(res.status).toBe(200);
    expect(res.body.data.stats.totalProducts).toBe(12);
    expect(res.body.data.stats.activeSales).toBe(2);
    expect(Array.isArray(res.body.data.recentSales)).toBe(true);
  });

  it('returns 403 for non-admin', async () => {
    const jwt = require('jsonwebtoken');
    jwt.verify.mockReturnValue({ sub: '550e8400-e29b-41d4-a716-446655440001', role: 'user', iat: 1000, exp: 9999999999 });

    const res = await request
      .get('/api/admin/dashboard')
      .set('Authorization', USER_TOKEN);

    expect(res.status).toBe(403);
  });
});

// ─── METRICS ─────────────────────────────────────────────────────────────────

describe('GET /api/metrics/:saleId', () => {
  let redis: any;

  beforeEach(() => {
    redis = getRedisMock();
    jest.clearAllMocks();
    const jwt = require('jsonwebtoken');
    jwt.verify.mockReturnValue({ sub: '550e8400-e29b-41d4-a716-446655440002', role: 'admin', iat: 1000, exp: 9999999999 });
  });

  it('returns parsed metrics hash', async () => {
    redis.hgetall.mockResolvedValue({
      totalPurchases: '157',
      error_SOLD_OUT: '2803',
      totalRollbacks: '8',
      totalLatencyMs: '1884',
      requestCount: '157',
    });

    const res = await request
      .get(`/api/metrics/${mockSale.id}`)
      .set('Authorization', getAdminToken());

    expect(res.status).toBe(200);
    expect(res.body.data.metrics.totalPurchases).toBe(157); // numeric
    expect(res.body.data.saleId).toBe(mockSale.id);
  });

  it('returns 404 when no metrics exist', async () => {
    redis.hgetall.mockResolvedValue({});

    const res = await request
      .get('/api/metrics/00000000-0000-0000-0000-000000000000')
      .set('Authorization', getAdminToken());

    expect(res.status).toBe(404);
  });
});

// ─── PURCHASE SERVICE — UNIT TESTS ───────────────────────────────────────────

describe('Purchase service unit tests', () => {
  let redis: any;

  beforeEach(() => {
    redis = getRedisMock();
    jest.clearAllMocks();
  });

  
describe('getSaleMeta', () => {
  beforeEach(() => {
    // mockReset wipes return values too, unlike clearAllMocks
    redis.get.mockReset();
    redis.setex.mockReset();
  });

  it('returns cached meta from Redis on hit', async () => {
    const { getSaleMeta } = await import('../src/services/purchase.service');
    const cachedMeta = {
      id: mockSale.id,
      productId: mockProduct.id,
      salePrice: 799,
      totalStock: 200,
      maxPerUser: 1,
      startTime: Date.now() - 3600000,
      endTime: Date.now() + 3600000,
    };
    redis.get.mockResolvedValue(JSON.stringify(cachedMeta));

    const result = await getSaleMeta(mockSale.id);
    expect(result.id).toBe(mockSale.id);
    expect(redis.get).toHaveBeenCalledTimes(1);
  });

  it('fetches from DB on Redis miss and caches result', async () => {
    const { getSaleMeta } = await import('../src/services/purchase.service');
    const { AppDataSource } = require('../src/config/database');
    const repo = AppDataSource.getRepository();

    redis.get.mockResolvedValue(null);        // ← now guaranteed null, no bleed
    redis.setex.mockResolvedValue('OK');
        repo.findOne.mockResolvedValue({
      ...mockSale,
      startTime: new Date(Date.now() - 3600000),
      endTime: new Date(Date.now() + 3600000),
    });

    await getSaleMeta(mockSale.id);
    expect(repo.findOne).toHaveBeenCalledTimes(1);
    expect(redis.setex).toHaveBeenCalledWith(
      expect.stringContaining('sale:meta:'),
      expect.any(Number),
      expect.any(String)
    );
  });

  it('throws 404 when sale not in DB', async () => {
    const { getSaleMeta } = await import('../src/services/purchase.service');
    const { AppDataSource } = require('../src/config/database');
    const repo = AppDataSource.getRepository();

    redis.get.mockResolvedValue(null);        
    repo.findOne.mockResolvedValue(null);    
    await expect(getSaleMeta('nonexistent-id')).rejects.toMatchObject({ statusCode: 404 });
  });
});
  describe('validateTiming', () => {
    it('does not throw for an active sale', () => {
      const { validateTiming } = require('../src/services/purchase.service');
      const meta = {
        id: '1', productId: '2', salePrice: 100, totalStock: 100, maxPerUser: 1,
        startTime: Date.now() - 1000,
        endTime: Date.now() + 1000,
      };
      expect(() => validateTiming(meta)).not.toThrow();
    });

    it('throws 400 for a future sale', () => {
      const { validateTiming } = require('../src/services/purchase.service');
      const meta = {
        id: '1', productId: '2', salePrice: 100, totalStock: 100, maxPerUser: 1,
        startTime: Date.now() + 10000,
        endTime: Date.now() + 20000,
      };
      expect(() => validateTiming(meta)).toThrow();
    });

    it('throws 400 for an ended sale', () => {
      const { validateTiming } = require('../src/services/purchase.service');
      const meta = {
        id: '1', productId: '2', salePrice: 100, totalStock: 100, maxPerUser: 1,
        startTime: Date.now() - 20000,
        endTime: Date.now() - 10000,
      };
      expect(() => validateTiming(meta)).toThrow();
    });
  });
});

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

describe('Auth middleware', () => {
  it('passes with valid Bearer token', async () => {
    const jwt = require('jsonwebtoken');
    jwt.verify.mockReturnValue({ sub: '550e8400-e29b-41d4-a716-446655440001', role: 'user', iat: 1000, exp: 9999999999 });

    const { AppDataSource } = require('../src/config/database');
    const repo = AppDataSource.getRepository();
    repo.find.mockResolvedValue([]);

    const res = await request
      .get('/api/orders/my-orders')
      .set('Authorization', 'Bearer valid.token.here');

    expect(res.status).toBe(200);
  });

  it('returns 401 with malformed Authorization header', async () => {
    const res = await request
      .get('/api/orders/my-orders')
      .set('Authorization', 'Token notabearer');

    expect(res.status).toBe(401);
    expect(res.body.message).toContain('malformed');
  });

  it('returns 401 when JWT is expired', async () => {
    const jwt = require('jsonwebtoken');
    jwt.verify.mockImplementation(() => {
      const err: any = new Error('TokenExpiredError');
      err.name = 'TokenExpiredError';
      throw err;
    });

    const res = await request
      .get('/api/orders/my-orders')
      .set('Authorization', 'Bearer expired.token.here');

    expect(res.status).toBe(401);
  });
});

describe('Global rate limiter', () => {
  it('returns 200 for normal request volume', async () => {
    const res = await request.get('/health');
    expect(res.status).toBe(200);
  });
});
