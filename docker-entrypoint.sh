#!/bin/sh
set -e

# Run Prisma migration/push on first run (creates SQLite db if missing)
if [ ! -f "/app/data/siftly.db" ]; then
  echo "[entrypoint] First run — initialising database..."
  # prisma is bundled in the standalone server node_modules
  node /app/node_modules/.bin/prisma db push --schema=/app/prisma/schema.prisma --skip-generate
  echo "[entrypoint] Database ready."
fi

exec node server.js
