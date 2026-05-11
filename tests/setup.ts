// tests/setup.ts
process.env.REDIS_URL = 'rediss://default:password@localhost:6379';
process.env.JWT_SECRET = 'test-secret';
process.env.DATABASE_URL = 'postgres://localhost/test';
process.env.NODE_ENV = 'test';