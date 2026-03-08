#!/bin/sh
set -e

# Run Prisma migration/push on first run (creates SQLite db if missing)
mkdir -p /app/data

if [ ! -f "/app/data/siftly.db" ]; then
  echo "[entrypoint] First run — initialising database..."
  /app/node_modules/.bin/prisma db push --schema=/app/prisma/schema.prisma
  echo "[entrypoint] Database ready."
fi

exec node server.js
