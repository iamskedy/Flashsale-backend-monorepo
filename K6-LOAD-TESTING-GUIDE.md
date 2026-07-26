# Flash Sale System — Local Setup & k6 Load Testing Guide

This guide walks through running the Flash Sale backend monolith locally using Docker, and load testing the oversell-prevention logic end-to-end with k6.

---

## Prerequisites

- Docker installed and running (works out of the box in GitHub Codespaces)
- Node.js 20+
- A terminal with two tabs/panes (one for the app, one for commands)

---

## Part 1 — Start Local Infrastructure

### 1.1 Start Postgres + Redis via Docker Compose

```bash
docker-compose up -d
```

This starts two containers using your existing `docker-compose.yml`:
- `flashsale-postgres` (Postgres 16, port 5432)
- `flashsale-redis` (Redis 7, port 6379)

### 1.2 Confirm both are healthy

```bash
docker ps
```

You should see both containers listed as `Up (healthy)`.

---

## Part 2 — Configure the App for Local Docker

### 2.1 Set your `.env` to point at local services

```dotenv
NODE_ENV=development
PORT=3000

DATABASE_URL="postgresql://flashsale:localpassword123@localhost:5432/flashsale"
REDIS_URL="redis://localhost:6379"

JWT_SECRET=change-this-to-a-64-character-random-string-before-production
FRONTEND_URL=http://localhost:5173
```

> If you normally point this app at Supabase/Upstash for cloud dev, keep those lines commented out rather than deleted, so you can switch back easily.

### 2.2 Known compatibility fixes (already applied in this repo)

These fixes make the same codebase work against both cloud (Supabase/Upstash, which require TLS) and local Docker (which does not):

- `src/config/database.ts` — TypeORM's `ssl` option is conditional on whether `DATABASE_URL` contains `supabase.co`, instead of always-on.
- `src/config/redis.ts` — ioredis `tls` option is conditional on the URL starting with `rediss://`, instead of always-on.
- `src/workers/queue.worker.ts` and `src/services/purchase.service.ts` — the BullMQ connection parser now handles both `user:pass@host:port` (Upstash-style) and plain `host:port` (local Docker, no auth) `REDIS_URL` formats.

If you're setting this up fresh and hit `Invalid REDIS_URL format` or Redis `ETIMEDOUT` errors, these are the three files to check.

### 2.3 Start the app

```bash
npm run dev:tsnd
```

This runs `ts-node-dev --respawn --transpile-only src/server.ts` (the correct entry point — plain `npm run dev` uses `nodemon` which defaults to a `.js` file and will fail).

**Expected clean boot log:**
```
[INFO] Redis (commands): connected
[INFO] Redis (commands): ready
[INFO] PostgreSQL connected
[INFO] Lua scripts loaded {...}
[INFO] BullMQ workers started {...}
[INFO] Socket.IO initialized
[INFO] Server running on port 3000
```

**Leave this terminal running** for the rest of the guide.

### 2.4 Sanity check

In a second terminal:

```bash
curl http://localhost:3000/health
```

Expected: `{"status":"ok","timestamp":...,"uptime":...}`

---

## Part 3 — Temporarily Raise the Purchase Rate Limit

The purchase endpoint has a rate limiter (10 requests/minute per IP) meant for production. Since all k6 virtual users share one IP locally, this limiter must be relaxed in development or every load test will be crushed by 429s.

In `src/routes/order.routes.ts`, confirm this line:

```ts
const purchaseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100000 : 10,
  validate: false,
  standardHeaders: true,
  legacyHeaders: false,
});
```

This only relaxes the limit when `NODE_ENV=development` — production (`NODE_ENV=production`) keeps the strict 10/min limit.

---

## Part 4 — Install k6

```bash
curl https://github.com/grafana/k6/releases/download/v0.49.0/k6-v0.49.0-linux-amd64.tar.gz -L | tar xvz --strip-components 1
sudo mv k6 /usr/local/bin
k6 version
```

---

## Part 5 — Seed Test Data

The k6 script (`tests/k6/01-oversell-prevention.js`) expects:
- 500 pre-registered users (`k6user0@loadtest.com` … `k6user499@loadtest.com`, password `Password123!`)
- One flash sale with a known `SALE_ID` and `PRODUCT_ID`, with a fixed stock quantity

Run the seed script:

```bash
./tests/k6/seed.sh
```

This script:
1. Registers an admin user (`admin@loadtest.com`)
2. Creates a product via `/api/admin/products`
3. Creates a flash sale via `/api/admin/sales` with `totalStock: 100`, active from 5 minutes ago to 2 hours from now
4. Registers all 500 test users via `/api/auth/register`

**Output on success:**
```
==========================================
SEED COMPLETE
SALE_ID=<uuid>
PRODUCT_ID=<uuid>
==========================================
```

Save these two IDs — you'll need them for every k6 run. They're also written to `tests/k6/.seed-env`.

### 5.1 (Optional) Verify seed data

```bash
docker exec -it flashsale-postgres psql -U flashsale -d flashsale -c "SELECT count(*) FROM users;"
docker exec -it flashsale-postgres psql -U flashsale -d flashsale -c "SELECT id, \"totalStock\", status FROM flash_sales;"
```

---

## Part 6 — Run the Load Test

```bash
BASE_URL=http://localhost:3000 \
SALE_ID=<your-sale-id> \
PRODUCT_ID=<your-product-id> \
k6 run --summary-export=tests/k6/results.json tests/k6/01-oversell-prevention.js
```

**What this does:**
1. `setup()` phase — logs in all 500 users sequentially (~3 minutes), collects JWT tokens
2. Load phase — 100 virtual users fire 500 total purchase attempts against a flash sale with only 100 units of stock
3. Every response is categorized: success (202), sold out (410), duplicate (409), user limit (429)
4. A final assertion checks that successful purchases never exceed the stock limit

**Expected result:**
```
purchase_success...............: 100   ✓ (never exceeds stock)
purchase_sold_out..............: 400
checks.........................: 100.00% ✓ (zero server errors)
http_req_duration p(95)........: ~1.0-1.3s
```

This proves the Redis Lua atomic-decrement purchase logic prevents overselling even under high concurrency — the core design goal of this system.

---

## Part 7 — Reset Between Runs

Each run consumes the sale's stock. To re-run the test against the same sale, reset Redis state first:

```bash
docker exec -it flashsale-redis redis-cli SET "stock:<SALE_ID>:<PRODUCT_ID>" 100
docker exec -it flashsale-redis redis-cli --scan --pattern "userlimit:<SALE_ID>*" | xargs -r docker exec -i flashsale-redis redis-cli DEL
```

Then re-run the Part 6 command.

---

## Part 8 — Generate an HTML Report

k6-reporter's bundled HTML template isn't compatible with k6's built-in JS engine (goja), so this repo generates the report separately via Node after the fact, using the `--summary-export` JSON:

```bash
node tests/k6/generate-report.js
```

This reads `tests/k6/results.json` and writes a styled, standalone `tests/k6/report.html` — a dark-themed dashboard showing:
- Successful purchases / sold-out count / oversell count / server error count
- Latency table (avg, min, median, max, p90, p95)
- Test configuration summary (VUs, iterations, total requests)
- A plain-English summary sentence suitable for a portfolio writeup

**To view it:** right-click `tests/k6/report.html` in your editor's file explorer and choose **Download**, then open it in any browser. Or serve it locally:

```bash
cd tests/k6 && python3 -m http.server 8000
```

---

## Quick Reference — Full Command Sequence

```bash
# 1. Infra
docker-compose up -d

# 2. App (separate terminal, keep running)
npm run dev:tsnd

# 3. Install k6 (one-time)
curl https://github.com/grafana/k6/releases/download/v0.49.0/k6-v0.49.0-linux-amd64.tar.gz -L | tar xvz --strip-components 1
sudo mv k6 /usr/local/bin

# 4. Seed data (one-time, or after a full reset)
./tests/k6/seed.sh

# 5. Run load test (repeatable — reset stock between runs, see Part 7)
BASE_URL=http://localhost:3000 SALE_ID=<id> PRODUCT_ID=<id> \
  k6 run --summary-export=tests/k6/results.json tests/k6/01-oversell-prevention.js

# 6. Generate report
node tests/k6/generate-report.js
```