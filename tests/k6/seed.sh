#!/bin/bash
set -e

BASE_URL="http://localhost:3000"

echo "1. Registering admin user..."
ADMIN_RES=$(curl -s -X POST "$BASE_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@loadtest.com","password":"AdminPass123!","role":"admin"}')

ADMIN_TOKEN=$(python3 -c "import json,sys; print(json.loads('''$ADMIN_RES''')['token'])" 2>/dev/null || echo "")

if [ -z "$ADMIN_TOKEN" ]; then
  echo "Admin registration failed or already exists, trying login instead..."
  ADMIN_RES=$(curl -s -X POST "$BASE_URL/api/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"email":"admin@loadtest.com","password":"AdminPass123!"}')
  ADMIN_TOKEN=$(python3 -c "import json,sys; print(json.loads('''$ADMIN_RES''')['token'])")
fi

echo "Admin token acquired."

echo "2. Creating product..."
PRODUCT_RES=$(curl -s -X POST "$BASE_URL/api/admin/products" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name":"K6 Load Test Product","basePrice":999.99,"description":"Seeded for k6 flash sale load test"}')

PRODUCT_ID=$(python3 -c "import json,sys; print(json.loads('''$PRODUCT_RES''')['data']['id'])")
echo "Product created: $PRODUCT_ID"

echo "3. Creating flash sale (stock=100)..."
START_TIME=$(python3 -c "from datetime import datetime, timedelta; print((datetime.utcnow() - timedelta(minutes=5)).isoformat() + 'Z')")
END_TIME=$(python3 -c "from datetime import datetime, timedelta; print((datetime.utcnow() + timedelta(hours=2)).isoformat() + 'Z')")

SALE_RES=$(curl -s -X POST "$BASE_URL/api/admin/sales" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d "{\"productId\":\"$PRODUCT_ID\",\"salePrice\":499.99,\"totalStock\":100,\"maxPerUser\":1,\"startTime\":\"$START_TIME\",\"endTime\":\"$END_TIME\"}")

SALE_ID=$(python3 -c "import json,sys; print(json.loads('''$SALE_RES''')['data']['id'])")
echo "Sale created: $SALE_ID"

echo "4. Registering 500 test users (this takes ~1-2 min)..."
for i in $(seq 0 499); do
  curl -s -X POST "$BASE_URL/api/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"k6user${i}@loadtest.com\",\"password\":\"Password123!\"}" > /dev/null
  if [ $((i % 50)) -eq 0 ]; then
    echo "  Registered $i/500 users..."
  fi
done

echo ""
echo "=========================================="
echo "SEED COMPLETE"
echo "SALE_ID=$SALE_ID"
echo "PRODUCT_ID=$PRODUCT_ID"
echo "=========================================="
echo ""
echo "export SALE_ID=$SALE_ID" > /workspaces/Flashsale-backend-monorepo/tests/k6/.seed-env
echo "export PRODUCT_ID=$PRODUCT_ID" >> /workspaces/Flashsale-backend-monorepo/tests/k6/.seed-env
