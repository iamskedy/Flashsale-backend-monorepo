# ⚡ Flash Sale System

A production-grade Flash Sale platform engineered to handle extreme purchase concurrency without overselling, duplicate orders, or race conditions. The system was built in two phases — starting with a well-structured monolith and evolving into a fully decoupled microservices architecture deployed on AWS.

> 🔗 **Live Demo:** [live-link-here](https://flashsale-frontend.shubhamkumar-dubey02-813.workers.dev/login)  
> 📦 **Tech Stack:** Node.js · TypeScript · PostgreSQL · Redis · Kafka · BullMQ · Docker · AWS ECS Fargate

---

## 📋 Table of Contents

- [Problem Statement](#-problem-statement)
- [Architecture Overview](#-architecture-overview)
- [Phase 1 — Monolith](#-phase-1--monolith)
- [Phase 2 — Microservices](#-phase-2--microservices)
- [Frontend](#-frontend)
- [Key Design Decisions](#-key-design-decisions)
- [Performance Benchmarks](#-performance-benchmarks)
- [Project Structure](#-project-structure)
- [Local Setup](#-local-setup)
- [AWS Deployment](#-aws-deployment)
- [API Reference](#-api-reference)

---

## 🎯 Problem Statement

Flash sales generate massive concurrent order bursts in seconds. The core engineering challenges are:

- **Overselling** — multiple requests reading the same inventory count simultaneously
- **Race conditions** — concurrent writes corrupting stock levels
- **Duplicate orders** — retries or double-clicks creating multiple charges
- **System overload** — database melting under sudden 10x traffic spikes
- **Payment failures** — distributed transactions failing mid-flight with no rollback

---

## 🏗️ Architecture Overview

The project follows an evolutionary architecture path:

```
Phase 1: Monolith (Single deployable, shared DB, Redis for concurrency)
    ↓
Phase 2: Microservices (Independent services, Kafka event bus, Saga pattern)
```

### High-Level Microservices Diagram

```
                        ┌──────────────────┐
                        │   React Frontend │
                        └────────┬─────────┘
                                 │ HTTPS
                        ┌────────▼─────────┐
                        │   API Gateway    │
                        │  (Rate Limiting) │
                        └────────┬─────────┘
                                 │
          ┌──────────────────────┼───────────────────────┐
          │                      │                       │
 ┌────────▼───────┐     ┌────────▼───────┐    ┌──────────▼──────┐
 │  Order Service  │    │ Inventory Svc  │    │  Payment Service│
 │  (BullMQ Queue) │    │ (Redis Atomic) │    │  (Saga Coord.)  │
 └────────┬────────┘    └─────────┬──────┘    └──────────┬──────┘
          │                       │                       │
          └───────────────────────┼───────────────────────┘
                                  │
                        ┌─────────▼───────┐
                        │  Kafka Event Bus│
                        └─────────┬───────┘
                                  │
                        ┌─────────▼───────┐
                        │Notification Svc │
                        │  (Email/WS)     │
                        └─────────────────┘
```

---

## 🧱 Phase 1 — Monolith

### Overview

A single Node.js/TypeScript Express application handling all concerns — authentication, order placement, inventory management, and notifications. Redis is used as the concurrency layer to prevent race conditions at the DB level.

### Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + TypeScript |
| Framework | Express.js |
| Database | PostgreSQL (via Prisma ORM) |
| Cache / Lock | Redis (Atomic DECR + Lua scripts) |
| Queue | BullMQ |
| Auth | JWT + RBAC middleware |
| Containerization | Docker + Docker Compose |

### Key Flows

**Order Placement (Race-condition safe)**
```
1. User hits POST /api/orders
2. JWT middleware validates token
3. Redis DECR on inventory key (atomic — prevents overselling)
4. If DECR >= 0 → write order to PostgreSQL + enqueue BullMQ job
5. If DECR < 0  → INCR back + return 409 Sold Out
6. BullMQ worker processes payment async
7. WebSocket pushes confirmation to user
```

**Idempotency**
```
Each request carries an idempotency key (userId + saleId).
Redis checks for duplicate keys before processing — prevents double-orders on retries.
```

### Limitations That Motivated the Split

- Single point of failure — one crash takes down all features
- Cannot scale order processing independently from inventory reads
- Payment failures had no clean rollback path
- Database becomes a bottleneck under extreme load

---

## 🚀 Phase 2 — Microservices

### Services

| Service | Responsibility | Port |
|---|---|---|
| API Gateway | Auth, rate limiting, request routing | 3000 |
| Order Service | Order creation, status tracking, BullMQ queue | 3001 |
| Inventory Service | Stock management, Redis atomic ops | 3002 |
| Payment Service | Payment processing, Saga coordination | 3003 |
| Notification Service | Email + WebSocket push notifications | 3004 |

### Kafka Event Schema

Each service communicates asynchronously via Kafka topics:

```
Topic: order.created
{
  "orderId": "uuid",
  "userId": "uuid",
  "saleId": "uuid",
  "quantity": 1,
  "timestamp": "ISO8601"
}

Topic: inventory.reserved
{
  "orderId": "uuid",
  "saleId": "uuid",
  "reserved": true
}

Topic: payment.completed
{
  "orderId": "uuid",
  "status": "SUCCESS" | "FAILED",
  "amount": 999.00
}

Topic: order.confirmed | order.cancelled
{
  "orderId": "uuid",
  "userId": "uuid",
  "reason": "string | null"
}
```

### Saga Pattern (Distributed Transaction)

The Choreography-based Saga ensures atomicity across services without a 2PC lock:

```
Order Service        Inventory Service      Payment Service
     │                      │                      │
     │── order.created ─────▶│                      │
     │                      │── inventory.reserved ─▶│
     │                      │                      │── payment.completed
     │                      │                      │
     │   (on payment FAILED) │                      │
     │◀─────────────── order.cancelled ─────────────│
     │                      │◀─ inventory.released ──│
```

**Compensating transactions** are triggered on any failure — inventory is released, order status set to `CANCELLED`, user notified via WebSocket.

### Inter-Service Communication

- **Async (default):** Kafka for all state-changing events
- **Sync (reads only):** HTTP/REST between services for non-critical reads
- **Real-time:** Socket.IO in Notification Service, connected to API Gateway via Redis pub/sub

---

## 🖥️ Frontend

Built with **React + TypeScript**, deployed on **Vercel**.

> 🔗 **Live Link:** [your-vercel-link-here](https://your-vercel-link-here)

### Features

- Product listing with real-time stock counter (WebSocket)
- Flash sale countdown timer
- Single-click order placement with loading + confirmation state
- Order history dashboard
- Toast notifications for order status updates

### Environment Setup

```bash
cd apps/frontend
cp .env.example .env.local
# Set VITE_API_BASE_URL to your API Gateway URL
npm install && npm run dev
```

---

## 🧠 Key Design Decisions

### 1. Redis Atomic DECR for Inventory
Using `DECR` instead of a `SELECT → check → UPDATE` pattern in PostgreSQL eliminates the race window entirely. Redis single-threaded model guarantees atomicity without locks.

### 2. BullMQ for Order Queue
Orders are acknowledged instantly and processed via BullMQ workers — keeping the API response time under 100ms even under heavy load. Workers handle retries, backoff, and dead-letter queues.

### 3. Idempotency Keys
Every order request is hashed with `userId + saleId + timestamp(minute)`. Redis stores processed keys for 10 minutes — preventing duplicate charges from retries or network blips.

### 4. Saga over 2PC
Two-phase commit creates distributed locks that kill throughput. The Saga pattern via Kafka allows each service to own its data and emit compensating events on failure — no global locks.

### 5. Rate Limiting at Gateway
Redis sliding window rate limiter at the API Gateway prevents a single user from hammering the system during flash sale start. Limits: 10 req/s per IP, 3 orders/minute per user.

---

## 📊 Performance Benchmarks

| Metric | Value |
|---|---|
| Peak concurrent users handled | ~X,XXX |
| Order API p99 latency | < XX ms |
| Inventory decrement throughput | ~X,XXX ops/sec |
| Kafka consumer lag at peak | < XXX ms |
| Oversell incidents under load | 0 |

> Replace X values with actual load test results from k6 or Artillery.

---

## 📁 Project Structure

```
flash-sale/
├── apps/
│   ├── frontend/              # React + TypeScript (Vercel)
│   ├── api-gateway/           # Express — auth, rate limiting, routing
│   ├── order-service/         # Order creation + BullMQ workers
│   ├── inventory-service/     # Redis atomic stock management
│   ├── payment-service/       # Payment + Saga coordinator
│   └── notification-service/  # Socket.IO + email
├── packages/
│   ├── shared-types/          # Shared TypeScript interfaces + Kafka schemas
│   ├── logger/                # Pino structured logger
│   └── config/                # Shared env config
├── infra/
│   ├── docker-compose.yml     # Local full-stack setup
│   └── aws/                   # ECS task definitions + CloudFormation
└── README.md
```

---

## 🛠️ Local Setup

### Prerequisites

- Docker + Docker Compose
- Node.js 20+
- npm 9+

### Run Everything Locally

```bash
# Clone the repo
git clone https://github.com/your-username/flash-sale.git
cd flash-sale

# Install all workspace dependencies
npm install

# Start infrastructure (PostgreSQL, Redis, Kafka, Zookeeper)
docker-compose up -d

# Run database migrations
npm run db:migrate --workspace=apps/order-service

# Start all services in development mode
npm run dev --workspaces

# Frontend runs on http://localhost:5173
# API Gateway on http://localhost:3000
```

### Environment Variables

Each service has its own `.env.example`. Copy and configure:

```bash
cp apps/api-gateway/.env.example apps/api-gateway/.env
cp apps/order-service/.env.example apps/order-service/.env
# ... repeat for each service
```

Key variables:

```env
DATABASE_URL=postgresql://postgres:password@localhost:5432/flashsale
REDIS_URL=redis://localhost:6379
KAFKA_BROKERS=localhost:9092
JWT_SECRET=your-secret-key
```

---

## ☁️ AWS Deployment

### Infrastructure

| Component | AWS Service |
|---|---|
| Compute | ECS Fargate (per service task) |
| Database | RDS PostgreSQL (Multi-AZ) |
| Cache | ElastiCache Redis (Cluster mode) |
| Message Bus | MSK (Managed Kafka) |
| Load Balancer | Application Load Balancer |
| Container Registry | ECR |
| Secrets | AWS Secrets Manager |

### Deploy a Service

```bash
# Build and push image to ECR
./infra/aws/push.sh order-service

# Update ECS service
aws ecs update-service \
  --cluster flash-sale-cluster \
  --service order-service \
  --force-new-deployment
```

---

## 📡 API Reference

### Order Service

```
POST   /api/orders              # Place order (idempotent)
GET    /api/orders/:id          # Get order status
GET    /api/orders/user/:userId # Get user's order history
```

### Inventory Service

```
GET    /api/inventory/:saleId   # Get current stock level
POST   /api/inventory/reserve   # Reserve stock (internal)
POST   /api/inventory/release   # Release stock on failure (internal)
```

### Auth (via API Gateway)

```
POST   /api/auth/register       # Register user
POST   /api/auth/login          # Login → returns JWT
POST   /api/auth/refresh        # Refresh access token
```

---

## 👤 Author

**Shubham** — Backend Engineer  
[LinkedIn](https://linkedin.com/in/iamskedy) · [GitHub](https://github.com/iamskedy)

---

## 📄 License

MIT
