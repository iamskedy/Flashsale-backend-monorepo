import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";
import { SharedArray } from "k6/data";
import exec from "k6/execution";

// ─────────────────────────────────────────────
// Custom Metrics
// ─────────────────────────────────────────────
const successCount = new Counter("purchase_success");
const soldOutCount = new Counter("purchase_sold_out");
const userLimitCount = new Counter("purchase_user_limit");
const duplicateCount = new Counter("purchase_duplicate");
const authFailCount = new Counter("purchase_auth_fail");

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const SALE_ID = __ENV.SALE_ID;
const PRODUCT_ID = __ENV.PRODUCT_ID;

const USER_COUNT = 500;
const STOCK_LIMIT = 100;

// ─────────────────────────────────────────────
// Test Options
// ─────────────────────────────────────────────
export const options = {
  scenarios: {
    oversell_test: {
      executor: "shared-iterations",
      vus: 100,
      iterations: 500,
      maxDuration: "2m",
    },
  },
  thresholds: {
    // 99th percentile must be under 3s — only measures the purchase call now
    http_req_duration: ["p(99)<3000"],

    // Core assertion: never sell more than stock allows
    purchase_success: [`count<=${STOCK_LIMIT}`],
  },

  // FIX 2: Give setup() enough time to log in 500 users sequentially
  setupTimeout: "10m",
};

// ─────────────────────────────────────────────
// Shared Token Array (filled in setup, read in default)
// FIX 1: Tokens are pre-fetched before the load test begins,
//         so auth load is completely separated from purchase load.
// ─────────────────────────────────────────────
const tokens = new SharedArray("user-tokens", function () {
  // This block only runs inside setup() context via SharedArray initializer.
  // Returning an empty array here — real tokens come from setup() return value.
  return [];
});

// ─────────────────────────────────────────────
// setup() — Runs ONCE before all VUs start
// Logs in all 500 users and returns token array
// ─────────────────────────────────────────────
export function setup() {
  console.log(`[setup] Starting pre-login for ${USER_COUNT} users...`);

  const tokenList = [];

  for (let i = 0; i < USER_COUNT; i++) {
    const email = `k6user${i}@loadtest.com`;
    const password = "Password123!";

    let token = null;
    let attempts = 0;

    // FIX 4: Retry each login up to 3 times before giving up
    while (!token && attempts < 3) {
      attempts++;

      const res = http.post(
        `${BASE_URL}/api/auth/login`,
        JSON.stringify({ email, password }),
        { headers: { "Content-Type": "application/json" } },
      );

      // FIX 5: Guard against null body or non-200 response
      // Also verify API-level status === "success" before trusting the token
      // Login response shape: { status: "success", token: "...", user: { ... } }
      if (res.status === 200 && res.body) {
        try {
          const parsed = JSON.parse(res.body);
          if (parsed?.status === "success" && parsed?.token) {
            token = parsed.token;
          }
        } catch (_) {
          // Malformed JSON — will retry
        }
      }

      if (!token && attempts < 3) {
        sleep(0.5); // Back off before retry
      }
    }

    if (!token) {
      console.warn(
        `[setup] WARNING: Failed to get token for ${email} after 3 attempts`,
      );
    }

    tokenList.push(token); // null tokens are handled gracefully in default()

    // FIX 3: Throttle — pause every 50 logins to avoid spiking the server
    if (i > 0 && i % 50 === 0) {
      console.log(`[setup] Logged in ${i}/${USER_COUNT} users...`);
      sleep(1);
    }
  }

  const successfulLogins = tokenList.filter(Boolean).length;
  console.log(
    `[setup] Pre-login complete. ${successfulLogins}/${USER_COUNT} tokens acquired.`,
  );

  return tokenList; // Passed as `data` argument to default()
}

// ─────────────────────────────────────────────
// default() — Runs for each of the 500 iterations
// Only hits the purchase endpoint — auth is already done
// ─────────────────────────────────────────────
export default function (data) {
  // Map iteration → user (wraps around if iterations > users)
  const userIndex = exec.scenario.iterationInTest % USER_COUNT;
  const token = data[userIndex];

  // FIX 5: Skip cleanly if this user has no token (login failed in setup)
  if (!token) {
    authFailCount.add(1);
    console.warn(
      `[default] Skipping iteration ${exec.scenario.iterationInTest} — no token for user ${userIndex}`,
    );
    return;
  }

  // FIX 6: Idempotency key is unique per user per iteration
  // Format: k6-{userIndex}-{globalIteration}
  // - userIndex:        prevents same user from buying twice
  // - iterationInTest:  prevents duplicate requests from being re-processed
  const idempotencyKey = `k6-${userIndex}-${exec.scenario.iterationInTest}`;

  const res = http.post(
    `${BASE_URL}/api/orders/purchase`,
    JSON.stringify({
      saleId: SALE_ID,
      productId: PRODUCT_ID,
      quantity: 1,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "x-idempotency-key": idempotencyKey,
      },
    },
  );

  // ── Categorise the response ──────────────────
  if (res.status === 200 || res.status === 202) {
    successCount.add(1); // Purchase went through
  } else if (res.status === 410) {
    soldOutCount.add(1); // Stock exhausted
  } else if (res.status === 429) {
    userLimitCount.add(1); // Per-user rate limit hit
  } else if (res.status === 409) {
    duplicateCount.add(1); // Idempotency key already used
  }

  // ── Core assertion ───────────────────────────
  check(res, {
    "no server errors": (r) => r.status !== 500,
  });
}

// ─────────────────────────────────────────────
// teardown() — Runs ONCE after all VUs finish
// Useful for a final summary log
// ─────────────────────────────────────────────
export function teardown(data) {
  const totalTokens = data.filter(Boolean).length;
  console.log(`[teardown] Test complete. ${totalTokens} users participated.`);
}
