# Gammon finance improvement and activation plan

## 1. Make activation blockers actionable

Add an offline operator preflight using the existing funds gate. Report blockers by action so operators can distinguish player entry (onboarding, bank linking, deposits, wagering) from recovery (cash-out, settlement, refund) and history. Support an explicit target mode to prevent a free-play environment from being mistaken for a valid testnet or production configuration. Use exit statuses suitable for CI; never print config values or perform network calls or writes to financial systems. A clean static check is not production readiness.

After building the server (`pnpm --filter @xion-beginner/backgammon-server build`), run from the repository root with the intended deployment environment injected:

```sh
pnpm --filter @xion-beginner/backgammon-server --silent funds:preflight verusd_production
```

Use `verusd_testnet` for testnet. The command does not automatically load `.env` files or change `FUNDS_MODE`. Exit `0` means configuration passed, `1` means blocked or invalid environment, and `2` means invalid command usage. The JSON report distinguishes static blockers from live attestation, which this command never performs.

## 2. Qualify the complete single-game flow on testnet

Use dedicated Brale/Plaid and Verona testnet credentials, two app replicas, and isolated PostgreSQL/Redis. Verify account creation, bank linking, pending and available deposit balances, quote disclosure, escrow funding, settlement/refund, cash-out, and transaction history. Reconcile each movement against the balanced journal, provider references, and finalized chain evidence. Exercise duplicate/missed webhooks, ACH returns, ambiguous broadcasts, worker restarts, and dependency outages. Capture sanitized evidence and obtain independent sign-off. Do not substitute mock evidence for live provider qualification.

Run the credential-free connected finance sandbox from the repository root:

```sh
bash apps/backgammon-server/scripts/finance-sandbox.sh
```

Requires Docker, pnpm, and Cargo. One scenario links a bank over HTTP, reconciles the linked address, deposits through the finance worker, and waits for the deposit to become spendable. It passes those balances into the actual CosmWasm escrow contract in MultiTest, executes funded settlement and refund, then cashes out the resulting balance through the HTTP routes and worker. The scenario checks wallet history, simulated money conservation (including rake), and balanced PostgreSQL journal batches. Provider and chain network responses, initial enrollment, and wallet step-up are fixtures. The escrow segment executes the contract directly, not the multiplayer UI or cash-game server routes. This does not qualify live providers or move real funds.

The separate loopback browser harness (`pnpm sandbox:browser-finance` from the server package with a fresh migrated PostgreSQL database, and `next dev` with `NEXT_PUBLIC_E2E_SANDBOX=1` and the matching testnet configuration) was verified in WebKit and Chromium on one fresh database. Both players enrolled, linked one bank, deposited 5.00 test verUSD each, and funded a wager. A resignation using the game menu settled the first wager; the dev-only refund recovery control refunded the second through the same finance worker. The winner cashed out 5.10, the other wallet retained 4.90, and all PostgreSQL journal batches balanced. The wallet/payment and gameplay routes are real application code; the wallet, payment provider, chain, settlement authorizer, and refund operator input are sandbox fixtures. No live money capability is implied.

Cash-game bootstrap runs in the shared `GameManager.joinCashGame` path: the funded quote is locked while the waiting game, participant reservations, and owner lease are published in one PostgreSQL transaction. A player who has acknowledged the funded start may enter the waiting game without waiting for the opponent's acknowledgement; play requires both participants. In one fresh WebKit and Chromium run, both join orders reached the board without a manual reconnect, both games settled, a third wager refunded, the winner cashed out 5.20 test verUSD, and the other wallet retained 4.80. All journal batches balanced.

## 3. Approve and launch production single-game finance

Use [TODOS.md](TODOS.md) as the evidence checklist: signed provider and legal approvals, reviewed identity/age and jurisdiction controls, responsible-play and recovery policies, pinned asset/contract and provider tuples, and an independently operated HSM/KMS settlement authorizer. Rotate previously exposed local credentials. Run static preflight against the intended production configuration and confirm live attestations in the deployment. Maintain separate entry and recovery approvals; test the entry kill switch and recovery continuity before enabling bounded real-money entry. Monitor exception queues, reconciliation lag, and conservation; stop new exposure on unexplained divergence. Do not activate production in the absence of that evidence.

## 4. Expand beyond single games

Design and review separate escrow and settlement contracts for paid matches and tournaments after a qualified single-game launch. Specify maximum exposure, cancellation, elimination, disconnects, refunds, and settlement authority before accepting funds. Keep free play independent throughout.
