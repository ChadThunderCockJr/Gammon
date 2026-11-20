# TODOS

Deferred production-activation work after the audited verUSD cutover on 2026-11-17.

Free play is the only enabled mode until every high-priority item below has current,
versioned evidence. Credentials alone do not enable money routes.

## High Priority (required before real money)

### External program and legal approvals
- **What:** Obtain written Brale, wagering, jurisdiction, identity/age, geolocation, responsible-play, disclosure, support, and data-lifecycle approvals for the exact production program.
- **Why:** `FUNDS_MODE=verusd_production` intentionally fails closed when any approval ID, reviewed document, policy version, or expiry is missing or mismatched.
- **Acceptance:** The approved environment/account/capability/transfer tuple and every policy artifact are current, byte-for-byte pinned, and independently reviewed.

### Production asset and contract attestation
- **What:** Deploy reviewed production escrow/configuration, record the chain genesis identity, denom metadata, code checksum, admin, rake recipient, caps, timeout, finality depth, and settlement-authority tuple.
- **Why:** The runtime re-attests these identities before exposure and terminal chain transitions; an unreviewed tuple cannot safely move money.
- **Acceptance:** Independent RPC and contract queries match every approved value, and a mismatch disables entry without blocking settlement, refund, history, or legally allowed cash-out.

### HSM-backed settlement authorizer
- **What:** Operate the independent settlement authorizer with HSM/KMS-held keys, pinned URL/public key/signing-key ID, rotation procedures, and no mnemonic fallback.
- **Why:** Application instances must never possess a key that can choose a winner, redirect an active pot, or bypass delayed contract administration.
- **Acceptance:** Ambiguous broadcasts reconcile by query, key rotation is exercised, and application compromise alone cannot produce an accepted settlement.

### Testnet and operational qualification
- **What:** Exercise the complete Brale/Verona testnet path, process-kill boundaries, two-replica rolling restarts, DB/Redis/RPC/provider outages, missed webhooks, reversals, refunds, accessibility, and player-comprehension tasks.
- **Why:** Code-only and deterministic-fixture evidence cannot certify external provider capabilities or production operations.
- **Acceptance:** Every financial transition maps to its command key, balanced journal delta, provider/chain artifact, final state, recovery behavior, and independently reproduced conservation proof.

## Medium Priority (after an approved single-game launch)

### Paid matches and tournaments
- **What:** Design separate match-level and tournament escrow specifications before enabling any paid multi-game or bracket flow.
- **Why:** The current paid contract and quote model intentionally supports single-game cash backgammon only.
- **Acceptance:** The new design defines maximum exposure, elimination/refund rules, disconnects, terminal authority, conservation, and migration without weakening single-game recovery.

## Low Priority (future)

### PWA conversion of iOS app
- **What:** Evaluate whether a Progressive Web App replaces the Expo WebView wrapper
- **Why:** The iOS app is just a WebView loading gammon.nyc. A PWA would give the same experience with push notifications and offline support, without maintaining a native app.
- **Depends on:** Web app stability
- **Context:** backgammon-ios is 9 files, essentially just a WebView component.

