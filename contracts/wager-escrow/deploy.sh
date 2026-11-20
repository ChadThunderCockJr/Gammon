#!/bin/bash
set -euo pipefail

# Deliberately no default values: a cash-game deployment must be explicitly configured.
required=(
  VERUSD_CHAIN_ID VERUSD_RPC_URL WALLET_ADDRESS VERUSD_DENOM
  SETTLEMENT_AUTHORITY_CONTRACT VERUSD_RAKE_RECIPIENT
  VERUSD_MIN_STAKE_MICRO_USD VERUSD_MAX_STAKE_MICRO_USD
  VERUSD_FUNDING_TIMEOUT_SECONDS ESCROW_CODE_ID
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
done

if [[ "${VERUSD_DENOM}" != factory/xion1*/verusd ]]; then
  echo "VERUSD_DENOM must be the explicitly approved factory/xion.../verusd denom" >&2
  exit 1
fi
if [[ "${VERUSD_RAKE_BPS:-0}" != "0" ]]; then
  echo "This cash-game rules version requires VERUSD_RAKE_BPS=0" >&2
  exit 1
fi

INIT_MSG=$(cat <<EOF
{"wager_denom":"${VERUSD_DENOM}","settlement_authority":"${SETTLEMENT_AUTHORITY_CONTRACT}","rake_bps":0,"rake_recipient":"${VERUSD_RAKE_RECIPIENT}","min_stake_per_point":"${VERUSD_MIN_STAKE_MICRO_USD}","max_stake_per_point":"${VERUSD_MAX_STAKE_MICRO_USD}","funding_timeout_seconds":${VERUSD_FUNDING_TIMEOUT_SECONDS},"cube_cap":8,"rules_version":"cash-v1"}
EOF
)

echo "Instantiating verUSD cash-game escrow on ${VERUSD_CHAIN_ID}."
echo "Confirm the code checksum, independent settlement authority, legal approvals, Brale program setup, and production funds gate before signing."
echo ""
echo "xiond tx wasm instantiate ${ESCROW_CODE_ID} '${INIT_MSG}' \\
  --from ${WALLET_ADDRESS} \\
  --label wager-escrow-cash-v1 \\
  --chain-id ${VERUSD_CHAIN_ID} \\
  --node ${VERUSD_RPC_URL} \\
  --admin ${WALLET_ADDRESS} \\
  --gas auto --gas-adjustment 1.5 --gas-prices 0.025uxion -y"
echo ""
echo "After finality, set VERUSD_ESCROW_CONTRACT and VERUSD_ESCROW_CODE_CHECKSUM in the server environment, restart the attestation worker, and confirm /api/funds/config reports zero blockers before any test transaction."
