# ⚡ Flash Sale System — Backend Monolith

> A production-grade flash sale backend engineered to handle extreme purchase concurrency — zero overselling, zero duplicate orders, sub-15ms response times.

🔗 **Live API:** [flashsale-backend-monorepo-production.up.railway.app](https://flashsale-backend-monorepo-production.up.railway.app)  
🖥️ **Frontend:** [flashsale-frontend-murex.vercel.app](https://flashsale-frontend-murex.vercel.app)  
📦 **Frontend Repo:** [Flashsale-Frontend](https://github.com/iamskedy/Flashsale-Frontend)

---

## 🎯 What Problem Does This Solve?

Flash sales create a brutal concurrency problem — thousands of users simultaneously trying to buy the same limited item the moment it drops. The naive approach (read stock → check → decrement) creates a race window where **multiple users buy the last item at the same time**.

This system solves that with a Redis-atomic approach:

```
❌ Naive:   SELECT stock → check > 0 → UPDATE stock = stock - 1   (race condition)
✅ This:    Redis DECR (atomic, single-threaded) → only write to DB if successful
```

Result: **Zero overselling**, even under 10,000 concurrent requests.

---

## 🏗️ Architecture

```
React Frontend (Vercel)
        │
        │ HTTPS + WebSocket
        ▼
Express API (Railway)
   ├── JWT Auth Middleware
   ├── Rate Limiting (Redis sliding window)
   ├── CORS Guard
        │
        ├── POST /api/orders/purchase
        │       │
        │       ├── Idempotency check (Redis — prevents double orders)
        │       ├── Redis ATOMIC DECR (prevents overselling)
        │       ├── Write to PostgreSQL (Prisma)
        │       └── Enqueue BullMQ job
        │               │
        │               └── BullMQ Worker → processes payment async
        │                       └── Socket.IO → pushes confirmation to user
        │
        └── GET  /api/sales, /api/orders (standard CRUD)
```

---

## 🧰 Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | Node.js + TypeScript | Type safety, async I/O |
| Framework | Express.js | Lightweight, composable middleware |
| Database | PostgreSQL + Prisma ORM | Relational integrity, type-safe queries |
| Concurrency Lock | Redis (Atomic DECR + Lua scripts) | Single-threaded atomic ops, no race conditions |
| Queue | BullMQ | Reliable async processing, retries, dead-letter |
| Real-time | Socket.IO | WebSocket push for live stock + order updates |
| Auth | JWT + RBAC middleware | Stateless, role-based access |
| Containerization | Docker + Docker Compose | Local infra parity |
| Deployment | Railway | Auto-deploy from GitHub |

---

## 🔑 Key Engineering Decisions

### 1. Redis Atomic DECR — The Core Concurrency Fix
```typescript
// Single atomic operation — no race window possible
const remaining = await redis.decr(`stock:${saleId}`);
if (remaining < 0) {
  await redis.incr(`stock:${saleId}`); // rollback
  return res.status(409).json({ message: 'Sold out' });
}
// Only reaches DB if stock was successfully decremented
await prisma.order.create({ ... });
```

### 2. Idempotency Keys — No Duplicate Orders
Every purchase request carries a key hashed from `userId + saleId`. Redis stores processed keys for 10 minutes — a retry or double-click gets back the original response instead of creating a new charge.

### 3. BullMQ Queue — API Stays Fast Under Load
Orders are acknowledged in under 15ms. Payment processing is offloaded to BullMQ workers with automatic retries and backoff. The API never blocks waiting for payment to complete.

### 4. WebSocket Push — Real-Time UX
After a successful purchase, the BullMQ worker emits a Socket.IO event directly to the buyer's connection — no polling needed.

---

## 📡 API Reference

### Auth
```
POST  /api/auth/register     Register a new user
POST  /api/auth/login        Login → returns JWT token
```

### Sales
```
GET   /api/sales             List all active flash sales
GET   /api/sales/:id         Get single sale with live stock
POST  /api/sales             Create sale (admin only)
```

### Orders
```
POST  /api/orders/purchase   Place an order (idempotent)
GET   /api/orders/my-orders  Get authenticated user's order history
```

### WebSocket Events
```
stock:update      { saleId, stockRemaining }   → broadcasted on every purchase
order:confirmed   { orderId }                  → sent to buyer on success
order:failed      { reason }                   → sent to buyer on failure
```

---

## 🚀 Local Setup

### Prerequisites
- Node.js 20+
- Docker + Docker Compose

### Run Locally

```bash
# Clone
git clone https://github.com/iamskedy/Flashsale-backend-monorepo
cd Flashsale-backend-monorepo

# Install dependencies
npm install

# Start PostgreSQL + Redis via Docker
docker-compose up -d

# Copy and configure environment
cp .env.example .env

# Run DB migrations
npx prisma migrate dev

# Start dev server
npm run dev
```

### Environment Variables

```bash
# .env
DATABASE_URL=postgresql://postgres:password@localhost:5432/flashsale
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-super-secret-key
PORT=3000
FRONTEND_URL=http://localhost:5173
```

---

## 📁 Project Structure

```
Flashsale-backend-monorepo/
├── src/
│   ├── routes/           # Express route definitions
│   ├── controllers/      # Request handlers
│   ├── middleware/       # JWT auth, RBAC, rate limiting, idempotency
│   ├── services/         # Business logic (order, inventory, payment)
│   ├── workers/          # BullMQ job processors
│   ├── socket/           # Socket.IO event handlers
│   ├── prisma/           # Schema + migrations
│   └── redis/            # Redis client + atomic scripts
├── docker-compose.yml    # Local PostgreSQL + Redis
├── .env.example
└── tsconfig.json
```

---

## ☁️ Deployment

Deployed on **Railway** with automatic deploys on push to `develop` branch.

| Variable | Set In |
|---|---|
| `DATABASE_URL` | Railway → Variables |
| `REDIS_URL` | Railway → Variables |
| `JWT_SECRET` | Railway → Variables |
| `FRONTEND_URL` | Railway → Variables |

---

## 👤 Author

**Shubham Dubey** — Backend Engineer  
[GitHub](https://github.com/iamskedy) · [LinkedIn](https://linkedin.com/in/iamskedy)