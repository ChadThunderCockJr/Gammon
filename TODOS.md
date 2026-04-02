# TODOS

Deferred items from /plan-eng-review on 2026-04-02.

## High Priority (do before real money)

### Multi-instance server clustering
- **What:** Add Redis pub/sub for cross-instance WebSocket communication, move matchmaking queue to Redis
- **Why:** Single instance is a single point of failure. One crash = all players disconnect. Fly.io auto-restart helps but there's still 5-10s of downtime.
- **Depends on:** PostgreSQL migration (completed), Fly.io deployment
- **Context:** Currently single-process, single-threaded Node.js. All game state in memory. PostgreSQL persistence handles data durability, but WebSocket connections can't survive a restart. The rejoin_game flow exists for client reconnection.

### Cloud KMS for admin mnemonic
- **What:** Move from Fly.io secrets (env var) to AWS KMS or GCP KMS. Signing happens in the HSM, mnemonic never in server memory.
- **Why:** The admin mnemonic can settle/cancel any game and move funds. Compromised server = compromised funds.
- **Depends on:** Fly.io deployment
- **Context:** Currently stored in process.env.ADMIN_MNEMONIC. Fly.io secrets encrypt at rest and inject at runtime, which is sufficient for launch but not for significant real money.

### useBalance client-side implementation
- **What:** Replace the hardcoded "0.00" stub in useBalance.ts with actual custodial balance queries from the server API
- **Why:** Users need to see their deposited balance. Currently the hook returns nothing useful.
- **Depends on:** Custodial balance system (server-side)
- **Context:** The hook exists but returns a hardcoded value. Need: GET /api/balance/:address endpoint on server, client hook that queries it, deposit/withdrawal UI.

### Gammon-redemption.ts integration
- **What:** Decide whether gammon-redemption.ts (307 lines, polls NFT contract, mints tokens) feeds into the custodial ledger or becomes dead code
- **Why:** This subsystem has its own admin mnemonic and Redis tracking. If custodial balances replace on-chain tokens, this service needs updating or removal.
- **Depends on:** Custodial balance system decision
- **Context:** Located at apps/backgammon-server/src/gammon-redemption.ts. Uses its own SigningCosmWasmClient instance.

## Medium Priority (after launch)

### On-chain escrow v2 (trustless game resolution)
- **What:** Move game resolution logic on-chain so the escrow contract doesn't depend on the server's admin mnemonic to call settle()
- **Why:** Current architecture requires trusting the server. True trustlessness requires on-chain game state verification or an oracle pattern.
- **Depends on:** Proven demand for wagering, legal review
- **Context:** The wager-escrow and backgammon-game contracts already exist. The gap is that settlement is server-initiated. Need either on-chain move verification or a dispute resolution mechanism.

### Tournament mode
- **What:** Add bracket-style tournaments with buy-in and prize pools
- **Why:** Tournaments create urgency (scheduled events), community, and are easier to market than 1v1 wagering
- **Depends on:** Custodial balance system, stable multiplayer
- **Context:** Considered as Approach C in the design doc. Not chosen for initial launch but worth revisiting once there's a player base.

## Low Priority (future)

### PWA conversion of iOS app
- **What:** Evaluate whether a Progressive Web App replaces the Expo WebView wrapper
- **Why:** The iOS app is just a WebView loading gammon.nyc. A PWA would give the same experience with push notifications and offline support, without maintaining a native app.
- **Depends on:** Web app stability
- **Context:** backgammon-ios is 9 files, essentially just a WebView component.

### Redis migration completeness
- **What:** Audit all 15+ Redis data structures in social-store.ts (768 lines) and determine which should move to PostgreSQL
- **Why:** Running Redis AND PostgreSQL adds operational complexity. Long-term, consolidating to PostgreSQL for durable data and Redis for caching/pub-sub only is cleaner.
- **Depends on:** PostgreSQL migration (initial)
- **Context:** Currently Redis stores: profiles, friends, friend requests, match history, ratings, leaderboard, usernames, game history, dice proofs, online presence, challenges, gammon redemption tracking.
