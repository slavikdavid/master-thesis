#!/usr/bin/env bash
set -euo pipefail

echo "Waiting for Postgres to be ready..."
# wait until pg_isready
MAX=15
count=0
while true; do
  if python - <<'PYTHON'
import os, sys, asyncio, asyncpg
from dotenv import load_dotenv
load_dotenv(dotenv_path=os.path.join("/app", ".env"))
dsn = os.getenv("DATABASE_DSN")
try:
    asyncio.run(asyncpg.connect(dsn))
    print("DB reachable")
    sys.exit(0)
except Exception:
    sys.exit(1)
PYTHON
  then
    break
  fi
  count=$((count + 1))
  if [ "$count" -ge "$MAX" ]; then
    echo "Postgres did not become ready in time" >&2
    exit 1
  fi
  echo "Still waiting... ($count/$MAX)"
  sleep 2
done

# databas emigrations
echo "Running migrations..."
python /app/db/migrations/db_migrate.py

# starting fastapi
echo "Starting FastAPI via uvicorn..."
exec python /app/backend/pipeline/run.py