#!/usr/bin/env bash
set -euo pipefail
if [[ ${GAMMON_SANDBOX_CLEAN_ENV:-} != 1 ]]; then
  exec env -i PATH="$PATH" HOME="$HOME" GAMMON_SANDBOX_CLEAN_ENV=1 bash "$0" "$@"
fi
cd "$(dirname "$0")/.."
db=$(docker run --rm -d -e POSTGRES_PASSWORD=sandbox -p 127.0.0.1::5432 postgres:16-alpine)
trap 'docker stop "$db" >/dev/null' EXIT
for ((i=0; i<50; i++)); do
  if docker exec "$db" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep .2
done
docker exec "$db" pg_isready -h 127.0.0.1 -U postgres >/dev/null
export DATABASE_URL="postgres://postgres:sandbox@$(docker port "$db" 5432/tcp)/postgres"
export NODE_ENV=test FUNDS_MODE=verusd_testnet
export ACH_AVAILABILITY_DELAY_SECONDS=60 ACH_RETURN_RECONCILIATION_HORIZON_SECONDS=3600
export GAMMON_FINANCE_SANDBOX=1 DOTENV_CONFIG_PATH=/dev/null
export FINANCE_DATA_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
pnpm migrate:dev
test -f src/__tests__/sandbox-wallet.test.ts
pnpm exec vitest run --no-file-parallelism src/__tests__/sandbox-ledger.test.ts src/__tests__/sandbox-wallet.test.ts
cargo test --locked --manifest-path ../../contracts/wager-escrow/Cargo.toml
cargo test --locked --manifest-path ../../contracts/cash-out-router/Cargo.toml
