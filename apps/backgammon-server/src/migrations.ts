import type pg from "pg";
import { backfillLegacyReportNarratives } from "./legacy-report-narrative-backfill.js";


export interface DatabaseMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly apply?: (client: pg.PoolClient) => Promise<void>;
}

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  {
    version: 1,
    name: "legacy_game_and_social_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        player_white TEXT,
        player_black TEXT,
        wager_amount BIGINT NOT NULL DEFAULT 0 CHECK (wager_amount >= 0),
        status TEXT NOT NULL DEFAULT 'waiting',
        escrow_status TEXT NOT NULL DEFAULT 'none',
        game_state JSONB,
        turn_time_limit INTEGER NOT NULL DEFAULT 60 CHECK (turn_time_limit > 0),
        revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
        phase TEXT NOT NULL DEFAULT 'await_roll',
        deadline_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS moves (
        id BIGSERIAL PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id),
        turn_number INTEGER NOT NULL CHECK (turn_number >= 0),
        player TEXT NOT NULL,
        move_from INTEGER NOT NULL,
        move_to INTEGER NOT NULL,
        game_state_after JSONB,
        command_id TEXT,
        revision BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (game_id, command_id)
      );

      CREATE TABLE IF NOT EXISTS dice_rolls (
        id BIGSERIAL PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id),
        turn_number INTEGER NOT NULL CHECK (turn_number >= 0),
        player TEXT NOT NULL,
        die1 INTEGER CHECK (die1 BETWEEN 1 AND 6),
        die2 INTEGER CHECK (die2 BETWEEN 1 AND 6),
        drand_round BIGINT,
        drand_randomness TEXT,
        drand_signature TEXT,
        drand_failed BOOLEAN NOT NULL DEFAULT FALSE,
        context_hex TEXT,
        committed_at TIMESTAMPTZ,
        revealed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (game_id, turn_number)
      );

      CREATE TABLE IF NOT EXISTS player_profiles (
        address TEXT PRIMARY KEY,
        display_name TEXT NOT NULL DEFAULT '',
        username TEXT UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS player_ratings (
        address TEXT PRIMARY KEY,
        rating INTEGER NOT NULL DEFAULT 1500,
        rating_change INTEGER NOT NULL DEFAULT 0,
        total_games INTEGER NOT NULL DEFAULT 0 CHECK (total_games >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS player_stats (
        address TEXT PRIMARY KEY,
        wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
        losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
        current_streak INTEGER NOT NULL DEFAULT 0,
        current_streak_type TEXT NOT NULL DEFAULT '',
        best_streak INTEGER NOT NULL DEFAULT 0 CHECK (best_streak >= 0),
        total_gammons INTEGER NOT NULL DEFAULT 0 CHECK (total_gammons >= 0),
        total_backgammons INTEGER NOT NULL DEFAULT 0 CHECK (total_backgammons >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS match_results (
        id BIGSERIAL PRIMARY KEY,
        address TEXT NOT NULL,
        game_id TEXT NOT NULL,
        opponent TEXT NOT NULL,
        opponent_name TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL,
        result_type TEXT NOT NULL DEFAULT 'normal',
        wager_amount BIGINT NOT NULL DEFAULT 0 CHECK (wager_amount >= 0),
        rating_change INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (address, game_id)
      );
      CREATE TABLE IF NOT EXISTS friendships (
        player_a TEXT NOT NULL,
        player_b TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (player_a <> player_b),
        PRIMARY KEY (player_a, player_b)
      );
      CREATE TABLE IF NOT EXISTS friend_requests (
        from_address TEXT NOT NULL,
        to_address TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (from_address <> to_address),
        PRIMARY KEY (from_address, to_address)
      );
      CREATE TABLE IF NOT EXISTS tournaments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        entry_fee BIGINT NOT NULL DEFAULT 0 CHECK (entry_fee = 0),
        max_players INTEGER NOT NULL DEFAULT 8 CHECK (max_players BETWEEN 2 AND 256),
        status TEXT NOT NULL DEFAULT 'registration',
        bracket JSONB,
        current_round INTEGER NOT NULL DEFAULT 0,
        total_rounds INTEGER NOT NULL DEFAULT 0,
        winner TEXT,
        prize_pool BIGINT NOT NULL DEFAULT 0 CHECK (prize_pool = 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        start_at TIMESTAMPTZ NOT NULL,
        finished_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS tournament_players (
        tournament_id TEXT NOT NULL REFERENCES tournaments(id),
        address TEXT NOT NULL,
        seed INTEGER,
        eliminated_round INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tournament_id, address)
      );
      CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
      CREATE INDEX IF NOT EXISTS idx_moves_game_id ON moves(game_id);
      CREATE INDEX IF NOT EXISTS idx_dice_rolls_game_id ON dice_rolls(game_id);
      CREATE INDEX IF NOT EXISTS idx_match_results_address_created ON match_results(address, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_address);
    `,
  },
  {
    version: 2,
    name: "verusd_finance_sessions_and_event_store",
    sql: `
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id_hash TEXT PRIMARY KEY,
        principal TEXT NOT NULL,
        signer TEXT NOT NULL,
        chain_id TEXT NOT NULL,
        csrf_hash TEXT NOT NULL,
        grant_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_principal ON auth_sessions(principal);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at) WHERE revoked_at IS NULL;

      CREATE TABLE IF NOT EXISTS consumed_auth_challenges (
        challenge_hash TEXT PRIMARY KEY,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS game_commands (
        command_id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        principal TEXT NOT NULL,
        expected_revision BIGINT NOT NULL,
        committed_revision BIGINT,
        result JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_game_commands_game ON game_commands(game_id, created_at);

      CREATE TABLE IF NOT EXISTS game_events (
        game_id TEXT NOT NULL,
        revision BIGINT NOT NULL CHECK (revision > 0),
        command_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        actor TEXT,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (game_id, revision)
      );

      CREATE TABLE IF NOT EXISTS payment_profiles (
        principal TEXT PRIMARY KEY,
        provider_account_id TEXT NOT NULL,
        wallet_address TEXT NOT NULL UNIQUE,
        external_wallet_address_id TEXT,
        internal_address_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'restricted', 'closed')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS payment_methods (
        id TEXT PRIMARY KEY,
        principal TEXT NOT NULL REFERENCES payment_profiles(principal),
        provider_address_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('bank')),
        state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'relink_required', 'disabled')),
        display_label TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS money_operations (
        id TEXT PRIMARY KEY,
        principal TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('enroll', 'link_bank', 'deposit', 'cash_out', 'wager_reserve', 'wager_settlement', 'refund')),
        state TEXT NOT NULL CHECK (state IN ('created', 'awaiting_user', 'queued', 'processing', 'pending', 'complete', 'canceled', 'failed', 'refunding', 'refunded', 'review')),
        amount_micro_usd BIGINT CHECK (amount_micro_usd IS NULL OR amount_micro_usd > 0),
        asset_denom TEXT,
        request_hash TEXT NOT NULL,
        client_idempotency_key TEXT NOT NULL,
        quote_snapshot JSONB,
        consent_snapshot JSONB,
        provider_transfer_id TEXT UNIQUE,
        failure_code TEXT,
        version BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (principal, client_idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_money_operations_principal_created ON money_operations(principal, created_at DESC);

      CREATE TABLE IF NOT EXISTS external_effects (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES money_operations(id),
        provider TEXT NOT NULL CHECK (provider IN ('brale', 'verona', 'settlement_authorizer')),
        effect_type TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'sent', 'confirmed', 'ambiguous', 'retry', 'failed')),
        request_payload JSONB NOT NULL,
        request_hash TEXT NOT NULL,
        provider_idempotency_key TEXT NOT NULL UNIQUE,
        provider_reference TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_error_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (operation_id, effect_type)
      );
      CREATE INDEX IF NOT EXISTS idx_external_effects_queue ON external_effects(state, next_attempt_at);

      CREATE TABLE IF NOT EXISTS webhook_events (
        subscription_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        processing_error TEXT,
        PRIMARY KEY (subscription_id, environment, event_id, event_type)
      );

      CREATE TABLE IF NOT EXISTS eligibility_decisions (
        id TEXT PRIMARY KEY,
        principal TEXT NOT NULL,
        action TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'review')),
        policy_version TEXT NOT NULL,
        jurisdiction TEXT,
        reason_codes TEXT[] NOT NULL DEFAULT '{}',
        evidence_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_eligibility_principal_action ON eligibility_decisions(principal, action, created_at DESC);

      CREATE TABLE IF NOT EXISTS consent_records (
        id TEXT PRIMARY KEY,
        principal TEXT NOT NULL,
        consent_type TEXT NOT NULL,
        document_version TEXT NOT NULL,
        accepted BOOLEAN NOT NULL,
        context JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS play_restrictions (
        principal TEXT PRIMARY KEY,
        self_excluded_until TIMESTAMPTZ,
        cooling_off_until TIMESTAMPTZ,
        deposit_limit_micro_usd BIGINT CHECK (deposit_limit_micro_usd IS NULL OR deposit_limit_micro_usd >= 0),
        wager_limit_micro_usd BIGINT CHECK (wager_limit_micro_usd IS NULL OR wager_limit_micro_usd >= 0),
        pending_increase JSONB,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS cash_game_quotes (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL UNIQUE,
        rules_hash TEXT NOT NULL,
        rules_snapshot JSONB NOT NULL,
        stake_micro_usd BIGINT NOT NULL CHECK (stake_micro_usd > 0),
        cube_cap INTEGER NOT NULL CHECK (cube_cap IN (1, 2, 4, 8)),
        reserve_per_player_micro_usd BIGINT NOT NULL CHECK (reserve_per_player_micro_usd > 0),
        rake_bps INTEGER NOT NULL CHECK (rake_bps BETWEEN 0 AND 10000),
        state TEXT NOT NULL CHECK (state IN ('offered', 'accepted', 'reserving', 'active', 'settlement_pending', 'settled', 'refunded', 'review', 'expired')),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS cash_game_acceptances (
        quote_id TEXT NOT NULL REFERENCES cash_game_quotes(id),
        principal TEXT NOT NULL,
        quote_hash TEXT NOT NULL,
        accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (quote_id, principal)
      );

      CREATE TABLE IF NOT EXISTS cash_game_reserves (
        quote_id TEXT NOT NULL REFERENCES cash_game_quotes(id),
        principal TEXT NOT NULL,
        amount_micro_usd BIGINT NOT NULL CHECK (amount_micro_usd > 0),
        chain_tx_hash TEXT UNIQUE,
        chain_height BIGINT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'final', 'released', 'settled', 'refunded', 'review')),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (quote_id, principal)
      );

      CREATE TABLE IF NOT EXISTS journal_batches (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE REFERENCES money_operations(id),
        asset_denom TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS journal_lines (
        id BIGSERIAL PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES journal_batches(id),
        account_code TEXT NOT NULL,
        principal TEXT,
        direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
        amount_micro_usd BIGINT NOT NULL CHECK (amount_micro_usd > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE OR REPLACE FUNCTION assert_journal_batch_balanced() RETURNS TRIGGER AS $$
      DECLARE
        affected_batch TEXT;
        difference BIGINT;
      BEGIN
        affected_batch := COALESCE(NEW.batch_id, OLD.batch_id);
        SELECT COALESCE(SUM(CASE direction WHEN 'debit' THEN amount_micro_usd ELSE -amount_micro_usd END), 0)
          INTO difference FROM journal_lines WHERE batch_id = affected_batch;
        IF difference <> 0 THEN
          RAISE EXCEPTION 'journal batch % is not balanced', affected_batch;
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS journal_batch_balanced ON journal_lines;
      CREATE CONSTRAINT TRIGGER journal_batch_balanced
        AFTER INSERT OR UPDATE OR DELETE ON journal_lines
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION assert_journal_batch_balanced();
    `,
  },
  {
    version: 3,
    name: "existing_install_hardening_and_finance_results",
    sql: `
      ALTER TABLE games ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE games ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'await_roll';
      ALTER TABLE games ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;
      ALTER TABLE moves ADD COLUMN IF NOT EXISTS command_id TEXT;
      ALTER TABLE moves ADD COLUMN IF NOT EXISTS revision BIGINT;
      ALTER TABLE dice_rolls ADD COLUMN IF NOT EXISTS context_hex TEXT;
      ALTER TABLE dice_rolls ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ;
      ALTER TABLE dice_rolls ADD COLUMN IF NOT EXISTS revealed_at TIMESTAMPTZ;
      ALTER TABLE payment_profiles ADD COLUMN IF NOT EXISTS internal_wallet_address TEXT;
      ALTER TABLE payment_profiles ADD COLUMN IF NOT EXISTS external_wallet_address_id TEXT;
      ALTER TABLE external_effects ADD COLUMN IF NOT EXISTS response_payload JSONB;
      ALTER TABLE money_operations ADD COLUMN IF NOT EXISTS chain_tx_hash TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_money_operations_chain_tx
        ON money_operations(chain_tx_hash) WHERE chain_tx_hash IS NOT NULL;

      CREATE TABLE IF NOT EXISTS provider_state_history (
        provider_transfer_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        state TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (provider_transfer_id, event_id)
      );
      ALTER TABLE cash_game_quotes ADD COLUMN IF NOT EXISTS quote_hash TEXT;
      ALTER TABLE cash_game_quotes ADD COLUMN IF NOT EXISTS player_a TEXT;
      ALTER TABLE cash_game_quotes ADD COLUMN IF NOT EXISTS player_b TEXT;
      ALTER TABLE cash_game_quotes ADD COLUMN IF NOT EXISTS asset_denom TEXT;
      ALTER TABLE cash_game_quotes ADD COLUMN IF NOT EXISTS escrow_game_id TEXT;
      ALTER TABLE cash_game_quotes ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE cash_game_quotes ADD COLUMN IF NOT EXISTS funding_deadline TIMESTAMPTZ;
      ALTER TABLE cash_game_quotes ADD COLUMN IF NOT EXISTS terminal_id TEXT;
      ALTER TABLE cash_game_quotes ADD COLUMN IF NOT EXISTS settlement_tx_hash TEXT;
      ALTER TABLE cash_game_quotes ADD COLUMN IF NOT EXISTS terminal_snapshot JSONB;
      ALTER TABLE cash_game_acceptances ADD COLUMN IF NOT EXISTS consent_snapshot JSONB;
      ALTER TABLE cash_game_acceptances ADD COLUMN IF NOT EXISTS eligibility_decision_id TEXT;

      CREATE TABLE IF NOT EXISTS connection_leases (
        principal TEXT NOT NULL,
        session_hash TEXT NOT NULL,
        purpose TEXT NOT NULL,
        game_id TEXT,
        instance_id TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (principal, session_hash, purpose)
      );
      CREATE INDEX IF NOT EXISTS idx_connection_leases_expiry ON connection_leases(expires_at);

      CREATE TABLE IF NOT EXISTS support_cases (
        id TEXT PRIMARY KEY,
        principal TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('missing_deposit', 'returned_payment', 'failed_cash_out', 'incorrect_settlement', 'account_access', 'location_error', 'responsible_play')),
        operation_id TEXT REFERENCES money_operations(id),
        game_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('open', 'investigating', 'resolved', 'closed')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sensitive_access_audit (
        id BIGSERIAL PRIMARY KEY,
        operator_id TEXT NOT NULL,
        purpose TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id_hash TEXT NOT NULL,
        break_glass BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    version: 4,
    name: "cash_quote_idempotency_and_lookup_indexes",
    sql: `
      ALTER TABLE cash_game_quotes ADD COLUMN IF NOT EXISTS creator_idempotency_key TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_quote_creator_idempotency
        ON cash_game_quotes(player_a, creator_idempotency_key)
        WHERE creator_idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_cash_quote_game_state
        ON cash_game_quotes(game_id, state);
      CREATE INDEX IF NOT EXISTS idx_cash_reserve_principal_state
        ON cash_game_reserves(principal, state);
    `,
  },
  {
    version: 5,
    name: "journal_reversals",
    sql: `
      ALTER TABLE journal_batches ADD COLUMN IF NOT EXISTS entry_key TEXT NOT NULL DEFAULT 'initial';
      ALTER TABLE journal_batches DROP CONSTRAINT IF EXISTS journal_batches_operation_id_key;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_operation_entry
        ON journal_batches(operation_id, entry_key);
    `,
  },
  {
    version: 6,
    name: "durable_game_aggregate_and_review_reason",
    sql: `
      ALTER TABLE games ADD COLUMN IF NOT EXISTS server_state JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE cash_game_quotes ADD COLUMN IF NOT EXISTS review_reason TEXT;
      CREATE INDEX IF NOT EXISTS idx_games_active_deadline
        ON games(deadline_at)
        WHERE status IN ('waiting', 'depositing', 'playing');
    `,
  },
  {
    version: 7,
    name: "idempotent_social_game_effects",
    sql: `
      CREATE TABLE IF NOT EXISTS social_game_effects (
        game_id TEXT PRIMARY KEY,
        winner TEXT NOT NULL,
        result_type TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    version: 8,
    name: "case_insensitive_username_uniqueness",
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_player_profiles_username_normalized
        ON player_profiles (LOWER(username))
        WHERE username IS NOT NULL;
    `,
  },
  {
    version: 9,
    name: "durable_dice_proofs",
    sql: `
      ALTER TABLE dice_rolls
        ADD COLUMN IF NOT EXISTS proof_json JSONB;
    `,
  },
  {
    version: 10,
    name: "durable_match_state",
    sql: `
      CREATE TABLE IF NOT EXISTS backgammon_matches (
        id TEXT PRIMARY KEY,
        match_state JSONB NOT NULL,
        current_game_id TEXT NOT NULL,
        player_white_address TEXT NOT NULL,
        player_black_address TEXT NOT NULL,
        wager_amount BIGINT NOT NULL DEFAULT 0 CHECK (wager_amount = 0),
        status TEXT NOT NULL CHECK (status IN ('playing', 'finished')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS backgammon_match_games (
        game_id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL REFERENCES backgammon_matches(id),
        score_result JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_backgammon_match_games_match
        ON backgammon_match_games (match_id);
    `,
  },
  {
    version: 11,
    name: "cash_ownership_and_evidence_constraints",
    sql: `
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM cash_game_quotes
           WHERE quote_hash IS NULL OR player_a IS NULL OR player_b IS NULL
              OR asset_denom IS NULL OR escrow_game_id IS NULL
        ) THEN
          RAISE EXCEPTION 'Legacy cash quotes require signed reconciliation before migration 11';
        END IF;
      END
      $$;

      ALTER TABLE cash_game_quotes
        ALTER COLUMN quote_hash SET NOT NULL,
        ALTER COLUMN player_a SET NOT NULL,
        ALTER COLUMN player_b SET NOT NULL,
        ALTER COLUMN asset_denom SET NOT NULL,
        ALTER COLUMN escrow_game_id SET NOT NULL,
        ADD CONSTRAINT cash_quote_distinct_players CHECK (player_a <> player_b),
        ADD CONSTRAINT cash_quote_hash_format CHECK (quote_hash ~ '^[0-9a-f]{64}$'),
        ADD CONSTRAINT cash_quote_player_a_format CHECK (player_a ~ '^xion1[023456789acdefghjklmnpqrstuvwxyz]{38,64}$'),
        ADD CONSTRAINT cash_quote_player_b_format CHECK (player_b ~ '^xion1[023456789acdefghjklmnpqrstuvwxyz]{38,64}$');

      ALTER TABLE cash_game_reserves
        ADD CONSTRAINT cash_reserve_final_evidence CHECK (
          state <> 'final' OR (
            chain_tx_hash ~ '^[0-9A-F]{64}$'
            AND chain_height IS NOT NULL
            AND chain_height > 0
          )
        );

      ALTER TABLE money_operations
        ADD CONSTRAINT money_operation_chain_hash_format CHECK (
          chain_tx_hash IS NULL OR chain_tx_hash ~ '^[0-9A-F]{64}$'
        );

      CREATE INDEX idx_cash_quotes_player_a_state
        ON cash_game_quotes(player_a, state, created_at DESC);
      CREATE INDEX idx_cash_quotes_player_b_state
        ON cash_game_quotes(player_b, state, created_at DESC);
    `,
  },
  {
    version: 12,
    name: "responsible_play_daily_limits",
    sql: `
      ALTER TABLE play_restrictions
        ADD COLUMN IF NOT EXISTS daily_wager_limit_micro_usd BIGINT
          CHECK (daily_wager_limit_micro_usd IS NULL OR daily_wager_limit_micro_usd >= 0),
        ADD COLUMN IF NOT EXISTS daily_loss_limit_micro_usd BIGINT
          CHECK (daily_loss_limit_micro_usd IS NULL OR daily_loss_limit_micro_usd >= 0);

      CREATE INDEX IF NOT EXISTS idx_cash_acceptances_principal_time
        ON cash_game_acceptances(principal, accepted_at DESC);
      CREATE INDEX IF NOT EXISTS idx_money_operations_principal_kind_time
        ON money_operations(principal, kind, created_at DESC);
    `,
  },
  {
    version: 13,
    name: "trust_safety_support_and_cash_sessions",
    sql: `
      CREATE TABLE IF NOT EXISTS user_blocks (
        blocker TEXT NOT NULL,
        blocked TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (blocker <> blocked),
        PRIMARY KEY (blocker, blocked)
      );
      CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked, blocker);

      CREATE TABLE IF NOT EXISTS user_reports (
        id TEXT PRIMARY KEY,
        reporter TEXT NOT NULL,
        target TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('cheating', 'harassment', 'inappropriate_name', 'other')),
        description TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'investigating', 'resolved', 'closed')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (reporter <> target)
      );
      CREATE INDEX IF NOT EXISTS idx_user_reports_reporter_created
        ON user_reports(reporter, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_user_reports_target_state
        ON user_reports(target, state, created_at DESC);

      ALTER TABLE support_cases
        ALTER COLUMN principal DROP NOT NULL,
        ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS contact_email TEXT,
        ADD COLUMN IF NOT EXISTS reference TEXT,
        ADD COLUMN IF NOT EXISTS access_token_hash TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_support_cases_access_token
        ON support_cases(access_token_hash)
        WHERE access_token_hash IS NOT NULL;

      ALTER TABLE cash_game_quotes
        ADD COLUMN IF NOT EXISTS cash_session_started_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS reality_check_acknowledged_at TIMESTAMPTZ;
    `,
  },
  {
    version: 14,
    name: "cash_commitments_and_recovery_deadlines",
    sql: `
      ALTER TABLE cash_game_quotes
        ADD COLUMN IF NOT EXISTS funded_start_deadline TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS review_deadline TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS resolution_state TEXT NOT NULL DEFAULT 'none'
          CHECK (resolution_state IN ('none', 'resume', 'adjudicated_settlement', 'refund', 'operator_resolution_required')),
        ADD COLUMN IF NOT EXISTS resolution_reason TEXT,
        ADD COLUMN IF NOT EXISTS recovery_round INTEGER NOT NULL DEFAULT 0
          CHECK (recovery_round >= 0);

      CREATE TABLE IF NOT EXISTS cash_game_commitments (
        quote_id TEXT NOT NULL REFERENCES cash_game_quotes(id),
        principal TEXT NOT NULL,
        amount_micro_usd BIGINT NOT NULL CHECK (amount_micro_usd > 0),
        state TEXT NOT NULL CHECK (state IN ('pending', 'funded', 'released', 'settled', 'refunded')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        released_at TIMESTAMPTZ,
        PRIMARY KEY (quote_id, principal)
      );
      CREATE INDEX IF NOT EXISTS idx_cash_game_commitments_live_principal
        ON cash_game_commitments(principal, created_at DESC)
        WHERE state IN ('pending', 'funded');

      CREATE TABLE IF NOT EXISTS cash_game_recovery_consents (
        quote_id TEXT NOT NULL REFERENCES cash_game_quotes(id),
        principal TEXT NOT NULL,
        recovery_round INTEGER NOT NULL CHECK (recovery_round > 0),
        action TEXT NOT NULL CHECK (action = 'resume'),
        acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (quote_id, principal, recovery_round)
      );
      CREATE INDEX IF NOT EXISTS idx_cash_game_recovery_consents_quote_round
        ON cash_game_recovery_consents(quote_id, recovery_round);

      CREATE TABLE IF NOT EXISTS cash_game_start_acknowledgements (
        quote_id TEXT NOT NULL REFERENCES cash_game_quotes(id),
        principal TEXT NOT NULL,
        acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (quote_id, principal)
      );
      CREATE INDEX IF NOT EXISTS idx_cash_game_quotes_recovery_deadline
        ON cash_game_quotes(review_deadline)
        WHERE state = 'review' AND review_deadline IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_cash_game_quotes_funded_start_deadline
        ON cash_game_quotes(funded_start_deadline)
        WHERE state = 'active' AND funded_start_deadline IS NOT NULL;
    `,
  },
  {
    version: 15,
    name: "participant_reality_check_acknowledgements",
    sql: `
      CREATE TABLE IF NOT EXISTS cash_game_reality_acknowledgements (
        quote_id TEXT NOT NULL REFERENCES cash_game_quotes(id),
        principal TEXT NOT NULL,
        acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (quote_id, principal)
      );
      CREATE INDEX IF NOT EXISTS idx_cash_reality_ack_principal
        ON cash_game_reality_acknowledgements(principal, acknowledged_at DESC);
    `,
  },
  {
    version: 16,
    name: "immutable_money_evidence_and_operation_timeline",
    sql: `
      ALTER TABLE cash_game_quotes
        ADD COLUMN IF NOT EXISTS funds_mode TEXT NOT NULL DEFAULT 'legacy_unverified'
          CHECK (funds_mode IN ('free', 'verusd_testnet', 'verusd_production', 'legacy_unverified')),
        ADD COLUMN IF NOT EXISTS test_funds BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS asset_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS display_denomination TEXT NOT NULL DEFAULT 'USD',
        ADD COLUMN IF NOT EXISTS balance_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS terms_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS legal_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

      ALTER TABLE cash_game_acceptances
        ADD COLUMN IF NOT EXISTS evidence_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

      CREATE TABLE IF NOT EXISTS money_operation_transitions (
        operation_id TEXT NOT NULL REFERENCES money_operations(id),
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        state TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reference TEXT,
        detail JSONB NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (operation_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_money_operation_transitions_operation
        ON money_operation_transitions(operation_id, sequence);

      INSERT INTO money_operation_transitions (operation_id, sequence, state, occurred_at, detail)
      SELECT id, 1, state, created_at, jsonb_build_object('source', 'migration')
        FROM money_operations operation
       WHERE NOT EXISTS (
         SELECT 1 FROM money_operation_transitions transition
          WHERE transition.operation_id = operation.id
       );
      CREATE OR REPLACE FUNCTION invalidate_cash_quote_acceptances_on_material_change() RETURNS TRIGGER AS $$
      BEGIN
        IF OLD.quote_hash IS DISTINCT FROM NEW.quote_hash
          OR OLD.rules_snapshot IS DISTINCT FROM NEW.rules_snapshot
          OR OLD.stake_micro_usd IS DISTINCT FROM NEW.stake_micro_usd
          OR OLD.reserve_per_player_micro_usd IS DISTINCT FROM NEW.reserve_per_player_micro_usd
          OR OLD.rake_bps IS DISTINCT FROM NEW.rake_bps
          OR OLD.cube_cap IS DISTINCT FROM NEW.cube_cap
          OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
          OR OLD.asset_snapshot IS DISTINCT FROM NEW.asset_snapshot
          OR OLD.display_denomination IS DISTINCT FROM NEW.display_denomination
          OR OLD.funds_mode IS DISTINCT FROM NEW.funds_mode
          OR OLD.test_funds IS DISTINCT FROM NEW.test_funds
          OR OLD.balance_snapshot IS DISTINCT FROM NEW.balance_snapshot
          OR OLD.terms_snapshot IS DISTINCT FROM NEW.terms_snapshot
          OR OLD.legal_snapshot IS DISTINCT FROM NEW.legal_snapshot THEN
          DELETE FROM cash_game_acceptances WHERE quote_id = NEW.id;
          DELETE FROM cash_game_commitments WHERE quote_id = NEW.id AND state = 'pending';
          IF NEW.state IN ('accepted', 'reserving') THEN NEW.state := 'offered'; END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS cash_quote_material_change_invalidates_acceptances ON cash_game_quotes;
      CREATE TRIGGER cash_quote_material_change_invalidates_acceptances
        BEFORE UPDATE ON cash_game_quotes
        FOR EACH ROW EXECUTE FUNCTION invalidate_cash_quote_acceptances_on_material_change();
      CREATE OR REPLACE FUNCTION record_money_operation_transition() RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM NEW.state THEN
          INSERT INTO money_operation_transitions (operation_id, sequence, state, occurred_at, detail)
          VALUES (
            NEW.id,
            COALESCE((SELECT MAX(sequence) + 1 FROM money_operation_transitions WHERE operation_id = NEW.id), 1),
            NEW.state,
            NEW.updated_at,
            jsonb_build_object('kind', NEW.kind)
          );
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS money_operation_state_timeline ON money_operations;
      CREATE TRIGGER money_operation_state_timeline
        AFTER INSERT OR UPDATE OF state ON money_operations
        FOR EACH ROW EXECUTE FUNCTION record_money_operation_transition();
      ALTER TABLE game_commands ADD COLUMN IF NOT EXISTS command_type TEXT;
      UPDATE game_commands command
         SET command_type = CASE event.event_type
           WHEN 'dice_rolled' THEN 'roll_dice'
           WHEN 'move_made' THEN 'move'
           WHEN 'turn_confirmed' THEN 'end_turn'
           WHEN 'turn_ended' THEN 'end_turn'
           WHEN 'move_undone' THEN 'undo'
           WHEN 'double_offered' THEN 'offer_double'
           WHEN 'double_accepted' THEN 'accept_double'
           WHEN 'double_rejected' THEN 'reject_double'
           WHEN 'resignation_offered' THEN 'resign'
           WHEN 'resigned' THEN 'resign'
           WHEN 'resignation_accepted' THEN 'accept_resignation'
           WHEN 'resignation_rejected' THEN 'reject_resignation'
           ELSE COALESCE(event.event_type, 'legacy_unverified')
         END
        FROM game_events event
       WHERE event.command_id = command.command_id
         AND command.command_type IS NULL;
      UPDATE game_commands SET command_type = 'legacy_unverified' WHERE command_type IS NULL;
      ALTER TABLE game_commands ALTER COLUMN command_type SET NOT NULL;
    `,
  },
  {
    version: 17,
    name: "cash_escrow_recovery_and_append_only_evidence",
    sql: `
      ALTER TABLE cash_game_quotes
        ADD COLUMN IF NOT EXISTS escrow_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS pre_review_state TEXT,
        ADD COLUMN IF NOT EXISTS pre_review_funded_start_deadline TIMESTAMPTZ;
      UPDATE cash_game_quotes
         SET escrow_snapshot = '{"legacyUnverified":true}'::jsonb
       WHERE NOT (
         escrow_snapshot ?& ARRAY[
           'chainId', 'genesisHash', 'escrowContract', 'escrowCodeChecksum', 'denom', 'settlementAuthority'
         ]
       );
      UPDATE cash_game_quotes
         SET pre_review_state = state,
             pre_review_funded_start_deadline = funded_start_deadline,
             state = 'review',
             review_reason = 'escrow_reconciliation',
             review_deadline = NOW() + INTERVAL '7 days',
             resolution_state = 'operator_resolution_required',
             resolution_reason = 'legacy_escrow_identity_reconciliation',
             recovery_round = recovery_round + 1,
             version = version + 1
       WHERE escrow_snapshot = '{"legacyUnverified":true}'::jsonb
         AND state IN ('offered', 'accepted', 'reserving', 'active', 'settlement_pending');

      ALTER TABLE cash_game_quotes ALTER COLUMN escrow_snapshot DROP DEFAULT;
      ALTER TABLE cash_game_quotes DROP CONSTRAINT IF EXISTS cash_quote_escrow_snapshot_identity;
      ALTER TABLE cash_game_quotes ADD CONSTRAINT cash_quote_escrow_snapshot_identity CHECK (
        escrow_snapshot = '{"legacyUnverified":true}'::jsonb
        OR (
          NULLIF(escrow_snapshot->>'chainId', '') IS NOT NULL
          AND NULLIF(escrow_snapshot->>'genesisHash', '') IS NOT NULL
          AND NULLIF(escrow_snapshot->>'escrowContract', '') IS NOT NULL
          AND NULLIF(escrow_snapshot->>'escrowCodeChecksum', '') IS NOT NULL
          AND NULLIF(escrow_snapshot->>'denom', '') IS NOT NULL
          AND NULLIF(escrow_snapshot->>'settlementAuthority', '') IS NOT NULL
        )
      );

      CREATE TABLE IF NOT EXISTS cash_game_quote_supersessions (
        id BIGSERIAL PRIMARY KEY,
        prior_quote_id TEXT NOT NULL REFERENCES cash_game_quotes(id),
        successor_quote_id TEXT NOT NULL REFERENCES cash_game_quotes(id),
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (prior_quote_id <> successor_quote_id),
        UNIQUE (prior_quote_id)
      );
      CREATE OR REPLACE FUNCTION reject_cash_game_supersession_mutation() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'cash-game supersessions are append-only evidence';
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS cash_game_quote_supersessions_immutable ON cash_game_quote_supersessions;
      CREATE TRIGGER cash_game_quote_supersessions_immutable
        BEFORE UPDATE OR DELETE ON cash_game_quote_supersessions
        FOR EACH ROW EXECUTE FUNCTION reject_cash_game_supersession_mutation();
      DROP TRIGGER IF EXISTS cash_quote_material_change_invalidates_acceptances ON cash_game_quotes;
      DROP FUNCTION IF EXISTS invalidate_cash_quote_acceptances_on_material_change();
      CREATE OR REPLACE FUNCTION reject_cash_quote_material_mutation() RETURNS TRIGGER AS $$
      BEGIN
        IF OLD.quote_hash IS DISTINCT FROM NEW.quote_hash
          OR OLD.rules_snapshot IS DISTINCT FROM NEW.rules_snapshot
          OR OLD.stake_micro_usd IS DISTINCT FROM NEW.stake_micro_usd
          OR OLD.reserve_per_player_micro_usd IS DISTINCT FROM NEW.reserve_per_player_micro_usd
          OR OLD.rake_bps IS DISTINCT FROM NEW.rake_bps
          OR OLD.cube_cap IS DISTINCT FROM NEW.cube_cap
          OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
          OR OLD.asset_snapshot IS DISTINCT FROM NEW.asset_snapshot
          OR OLD.display_denomination IS DISTINCT FROM NEW.display_denomination
          OR OLD.funds_mode IS DISTINCT FROM NEW.funds_mode
          OR OLD.test_funds IS DISTINCT FROM NEW.test_funds
          OR OLD.balance_snapshot IS DISTINCT FROM NEW.balance_snapshot
          OR OLD.terms_snapshot IS DISTINCT FROM NEW.terms_snapshot
          OR OLD.legal_snapshot IS DISTINCT FROM NEW.legal_snapshot
          OR OLD.escrow_snapshot IS DISTINCT FROM NEW.escrow_snapshot THEN
          RAISE EXCEPTION 'cash quote material is immutable; create a successor and append a supersession record';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER cash_quote_material_is_immutable
        BEFORE UPDATE ON cash_game_quotes
        FOR EACH ROW EXECUTE FUNCTION reject_cash_quote_material_mutation();

      CREATE TABLE IF NOT EXISTS cash_game_review_snapshots (
        quote_id TEXT NOT NULL REFERENCES cash_game_quotes(id),
        recovery_round INTEGER NOT NULL CHECK (recovery_round > 0),
        phase TEXT NOT NULL,
        deadline_at TIMESTAMPTZ,
        game_revision BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (quote_id, recovery_round)
      );
      CREATE TABLE IF NOT EXISTS cash_game_reality_intervals (
        quote_id TEXT NOT NULL REFERENCES cash_game_quotes(id),
        interval_number INTEGER NOT NULL CHECK (interval_number > 0),
        due_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (quote_id, interval_number)
      );
      CREATE TABLE IF NOT EXISTS cash_game_reality_interval_acknowledgements (
        quote_id TEXT NOT NULL REFERENCES cash_game_quotes(id),
        interval_number INTEGER NOT NULL CHECK (interval_number > 0),
        principal TEXT NOT NULL,
        acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (quote_id, interval_number, principal),
        FOREIGN KEY (quote_id, interval_number)
          REFERENCES cash_game_reality_intervals(quote_id, interval_number)
      );
      CREATE TABLE IF NOT EXISTS cash_game_commitment_decisions (
        quote_id TEXT NOT NULL REFERENCES cash_game_quotes(id),
        principal TEXT NOT NULL,
        quote_hash TEXT NOT NULL,
        eligibility_decision_id TEXT,
        balance_snapshot JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (quote_id, principal)
      );
      CREATE OR REPLACE FUNCTION assert_cash_commitment_decision_integrity() RETURNS TRIGGER AS $$
      DECLARE expected_hash TEXT;
      BEGIN
        SELECT quote_hash INTO expected_hash FROM cash_game_quotes WHERE id = NEW.quote_id;
        IF expected_hash IS NULL OR NEW.quote_hash <> expected_hash OR NEW.quote_hash = '' THEN
          RAISE EXCEPTION 'cash-game commitment decision must bind the immutable quote hash';
        END IF;
        IF NEW.eligibility_decision_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM eligibility_decisions WHERE id = NEW.eligibility_decision_id
        ) THEN
          RAISE EXCEPTION 'cash-game commitment decision references a missing eligibility decision';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER cash_commitment_decisions_integrity
        BEFORE INSERT OR UPDATE ON cash_game_commitment_decisions
        FOR EACH ROW EXECUTE FUNCTION assert_cash_commitment_decision_integrity();
      CREATE INDEX IF NOT EXISTS idx_cash_reality_intervals_due
        ON cash_game_reality_intervals(quote_id, due_at);
      CREATE TABLE IF NOT EXISTS cash_game_effect_attestations (
        effect_id TEXT PRIMARY KEY REFERENCES external_effects(id),
        quote_id TEXT NOT NULL REFERENCES cash_game_quotes(id),
        effect_type TEXT NOT NULL CHECK (effect_type IN ('escrow_create', 'escrow_settle', 'escrow_refund')),
        game_id TEXT NOT NULL,
        terminal_id TEXT,
        transaction_hash TEXT CHECK (transaction_hash IS NULL OR transaction_hash ~ '^[0-9A-F]{64}$'),
        transaction_height BIGINT NOT NULL CHECK (transaction_height > 0),
        finality_block_hash TEXT NOT NULL CHECK (length(finality_block_hash) > 0),
        attestation_source TEXT NOT NULL CHECK (attestation_source IN ('transaction', 'finalized_state')),
        authorizer_key_id TEXT NOT NULL CHECK (length(authorizer_key_id) > 0),
        receipt_snapshot JSONB,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE OR REPLACE FUNCTION assert_cash_game_evidence_participant() RETURNS TRIGGER AS $$
      DECLARE participant_a TEXT;
      DECLARE participant_b TEXT;
      BEGIN
        SELECT player_a, player_b INTO participant_a, participant_b
          FROM cash_game_quotes WHERE id = NEW.quote_id;
        IF participant_a IS NULL OR NEW.principal NOT IN (participant_a, participant_b) THEN
          RAISE EXCEPTION 'cash-game evidence principal must be a quote participant';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS cash_start_acknowledgements_participant ON cash_game_start_acknowledgements;
      CREATE TRIGGER cash_start_acknowledgements_participant BEFORE INSERT OR UPDATE ON cash_game_start_acknowledgements
        FOR EACH ROW EXECUTE FUNCTION assert_cash_game_evidence_participant();
      DROP TRIGGER IF EXISTS cash_reality_interval_acknowledgements_participant ON cash_game_reality_interval_acknowledgements;
      CREATE TRIGGER cash_reality_interval_acknowledgements_participant BEFORE INSERT OR UPDATE ON cash_game_reality_interval_acknowledgements
        FOR EACH ROW EXECUTE FUNCTION assert_cash_game_evidence_participant();
      DROP TRIGGER IF EXISTS cash_recovery_consents_participant ON cash_game_recovery_consents;
      CREATE TRIGGER cash_recovery_consents_participant BEFORE INSERT OR UPDATE ON cash_game_recovery_consents
        FOR EACH ROW EXECUTE FUNCTION assert_cash_game_evidence_participant();
      DROP TRIGGER IF EXISTS cash_commitment_decisions_participant ON cash_game_commitment_decisions;
      CREATE TRIGGER cash_commitment_decisions_participant BEFORE INSERT OR UPDATE ON cash_game_commitment_decisions
        FOR EACH ROW EXECUTE FUNCTION assert_cash_game_evidence_participant();

      CREATE OR REPLACE FUNCTION reject_immutable_evidence_mutation() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'immutable financial or consent evidence cannot be updated or deleted';
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS journal_batches_immutable ON journal_batches;
      CREATE TRIGGER journal_batches_immutable BEFORE UPDATE OR DELETE ON journal_batches
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_mutation();
      DROP TRIGGER IF EXISTS journal_lines_immutable ON journal_lines;
      CREATE TRIGGER journal_lines_immutable BEFORE UPDATE OR DELETE ON journal_lines
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_mutation();
      DROP TRIGGER IF EXISTS cash_acceptances_immutable ON cash_game_acceptances;
      CREATE TRIGGER cash_acceptances_immutable BEFORE UPDATE OR DELETE ON cash_game_acceptances
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_mutation();
      DROP TRIGGER IF EXISTS eligibility_decisions_immutable ON eligibility_decisions;
      CREATE TRIGGER eligibility_decisions_immutable BEFORE UPDATE OR DELETE ON eligibility_decisions
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_mutation();
      DROP TRIGGER IF EXISTS money_operation_transitions_immutable ON money_operation_transitions;
      DROP TRIGGER IF EXISTS cash_effect_attestations_immutable ON cash_game_effect_attestations;
      CREATE TRIGGER cash_effect_attestations_immutable BEFORE UPDATE OR DELETE ON cash_game_effect_attestations
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_mutation();
      CREATE TRIGGER money_operation_transitions_immutable BEFORE UPDATE OR DELETE ON money_operation_transitions
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_mutation();
      CREATE TRIGGER cash_start_acknowledgements_immutable BEFORE UPDATE OR DELETE ON cash_game_start_acknowledgements
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_mutation();
      CREATE TRIGGER cash_reality_interval_acknowledgements_immutable BEFORE UPDATE OR DELETE ON cash_game_reality_interval_acknowledgements
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_mutation();
      CREATE TRIGGER cash_recovery_consents_immutable BEFORE UPDATE OR DELETE ON cash_game_recovery_consents
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_mutation();
      CREATE TRIGGER cash_commitment_decisions_immutable BEFORE UPDATE OR DELETE ON cash_game_commitment_decisions
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_mutation();
      CREATE TRIGGER cash_review_snapshots_immutable BEFORE UPDATE OR DELETE ON cash_game_review_snapshots
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_mutation();
      DROP TRIGGER IF EXISTS cash_game_reality_intervals_immutable ON cash_game_reality_intervals;
      CREATE TRIGGER cash_game_reality_intervals_immutable BEFORE UPDATE OR DELETE ON cash_game_reality_intervals
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_mutation();
      CREATE OR REPLACE FUNCTION reject_money_operation_evidence_mutation() RETURNS TRIGGER AS $$
      BEGIN
        IF OLD.quote_snapshot IS DISTINCT FROM NEW.quote_snapshot
          OR OLD.consent_snapshot IS DISTINCT FROM NEW.consent_snapshot THEN
          RAISE EXCEPTION 'operation financial and consent evidence is immutable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS money_operations_evidence_immutable ON money_operations;
      CREATE TRIGGER money_operations_evidence_immutable BEFORE UPDATE ON money_operations
        FOR EACH ROW EXECUTE FUNCTION reject_money_operation_evidence_mutation();

      ALTER TABLE journal_batches
        ADD COLUMN IF NOT EXISTS reverses_batch_id TEXT REFERENCES journal_batches(id);

      CREATE OR REPLACE FUNCTION assert_journal_batch_conserved() RETURNS TRIGGER AS $$
      DECLARE row_document JSONB := COALESCE(to_jsonb(NEW), to_jsonb(OLD));
      DECLARE batch_key TEXT := COALESCE(row_document->>'batch_id', row_document->>'id');
      DECLARE operation_key TEXT;
      DECLARE entry TEXT;
      DECLARE reverse_key TEXT;
      DECLARE required_original_entry TEXT;
      DECLARE debits BIGINT;
      DECLARE credits BIGINT;
      BEGIN
        SELECT operation_id, entry_key, reverses_batch_id
          INTO operation_key, entry, reverse_key
          FROM journal_batches WHERE id = batch_key;
        IF operation_key IS NULL THEN RETURN NULL; END IF;
        SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_micro_usd ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_micro_usd ELSE 0 END), 0)
          INTO debits, credits FROM journal_lines WHERE batch_id = batch_key;
        IF debits <> credits OR debits = 0 THEN
          RAISE EXCEPTION 'journal batch must contain balanced non-zero paired lines';
        END IF;
        required_original_entry := CASE
          WHEN entry IN ('reversal', 'return', 'provider_reversal') THEN 'complete'
          WHEN entry = 'chain_return' THEN 'chain_inbound'
          ELSE NULL
        END;
        IF required_original_entry IS NULL THEN
          IF reverse_key IS NOT NULL THEN
            RAISE EXCEPTION 'non-reversal journal batch cannot reverse another batch';
          END IF;
        ELSIF reverse_key IS NULL OR NOT EXISTS (
          SELECT 1 FROM journal_batches
           WHERE id = reverse_key
             AND operation_id = operation_key
             AND entry_key = required_original_entry
        ) THEN
          RAISE EXCEPTION 'journal reversal must link to the matching original batch';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_batches_reverses_batch
        ON journal_batches(reverses_batch_id) WHERE reverses_batch_id IS NOT NULL;
      DROP TRIGGER IF EXISTS journal_batches_conserved ON journal_batches;
      CREATE CONSTRAINT TRIGGER journal_batches_conserved
        AFTER INSERT ON journal_batches DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION assert_journal_batch_conserved();
      CREATE INDEX IF NOT EXISTS idx_provider_state_history_transfer_state_observed
        ON provider_state_history(provider_transfer_id, state, observed_at);
      DROP TRIGGER IF EXISTS journal_lines_conserved ON journal_lines;
      CREATE CONSTRAINT TRIGGER journal_lines_conserved
        AFTER INSERT ON journal_lines DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION assert_journal_batch_conserved();

      CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_profiles_provider_account
        ON payment_profiles(provider_account_id) WHERE provider_account_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_money_operations_provider_transfer_updated
        ON money_operations(provider_transfer_id, updated_at DESC) WHERE provider_transfer_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_external_effects_operation_type_state_next_attempt
        ON external_effects(operation_id, effect_type, state, next_attempt_at);
      CREATE TABLE IF NOT EXISTS finance_reconciliation_cursor (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
        observed_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
        operation_id TEXT NOT NULL DEFAULT '',
        provider_transfer_id TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO finance_reconciliation_cursor (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
      CREATE INDEX IF NOT EXISTS idx_money_operations_reconciliation_cursor_v2
        ON money_operations(updated_at, id, provider_transfer_id) WHERE provider_transfer_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_external_effects_refund_reconciliation
        ON external_effects(operation_id, provider_reference, updated_at)
        WHERE effect_type = 'cash_out_refund' AND provider_reference IS NOT NULL;
      ALTER TABLE journal_batches DISABLE TRIGGER journal_batches_immutable;
      UPDATE journal_batches reversal
         SET reverses_batch_id = original.id
        FROM journal_batches original
       WHERE reversal.operation_id = original.operation_id
         AND (
           (reversal.entry_key IN ('reversal', 'return', 'provider_reversal') AND original.entry_key = 'complete')
           OR (reversal.entry_key = 'chain_return' AND original.entry_key = 'chain_inbound')
         )
         AND reversal.reverses_batch_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM journal_batches competing
            WHERE competing.operation_id = reversal.operation_id
              AND competing.entry_key = reversal.entry_key
              AND competing.reverses_batch_id = original.id
         );
      ALTER TABLE journal_batches ENABLE TRIGGER journal_batches_immutable;
      UPDATE money_operations operation
         SET state = 'review',
             failure_code = 'legacy_reversal_link_missing',
             updated_at = NOW(),
             version = version + 1
       WHERE EXISTS (
         SELECT 1 FROM journal_batches reversal
          WHERE reversal.operation_id = operation.id
            AND reversal.entry_key IN ('reversal', 'return', 'provider_reversal', 'chain_return')
            AND NOT EXISTS (
              SELECT 1 FROM journal_batches original
               WHERE original.id = reversal.reverses_batch_id
                 AND original.operation_id = reversal.operation_id
                 AND original.entry_key = CASE
                   WHEN reversal.entry_key = 'chain_return' THEN 'chain_inbound'
                   ELSE 'complete'
                 END
            )
       );
      UPDATE money_operations
         SET state = 'review',
             failure_code = 'legacy_chain_identity_missing',
             updated_at = NOW(),
             version = version + 1
       WHERE kind IN ('deposit', 'cash_out')
         AND state NOT IN ('complete', 'failed', 'canceled', 'refunded')
         AND (
           NULLIF(quote_snapshot->>'chainId', '') IS NULL
           OR NULLIF(quote_snapshot->>'genesisHash', '') IS NULL
         );

      CREATE OR REPLACE FUNCTION finance_json_key_is_sensitive(key_name TEXT) RETURNS BOOLEAN AS $$
      DECLARE normalized TEXT := regexp_replace(lower(key_name), '[^a-z0-9]', '', 'g');
      BEGIN
        RETURN normalized IN (
          'name', 'firstname', 'middlename', 'lastname', 'fullname', 'legalname',
          'email', 'emailaddress', 'dateofbirth', 'birthdate', 'dob',
          'phone', 'phonenumber', 'address', 'residentialaddress',
          'street', 'streetline1', 'streetline2', 'addressline1', 'addressline2',
          'postalcode', 'zipcode', 'identity', 'identitydocument', 'documentnumber',
          'passportnumber', 'driverslicensenumber', 'socialsecuritynumber', 'ssn',
          'taxid', 'ip', 'ipaddress', 'useragent', 'bankaccountnumber',
          'accountnumber', 'routingnumber'
        ) OR normalized ~ '(token|secret|password|credential)$';
      END;
      $$ LANGUAGE plpgsql IMMUTABLE STRICT;
      CREATE OR REPLACE FUNCTION finance_json_without_sensitive(value JSONB) RETURNS JSONB AS $$
      BEGIN
        CASE jsonb_typeof(value)
          WHEN 'object' THEN
            RETURN COALESCE((
              SELECT jsonb_object_agg(key, finance_json_without_sensitive(entry))
                FROM jsonb_each(value) AS object_entry(key, entry)
               WHERE NOT finance_json_key_is_sensitive(key)
            ), '{}'::jsonb);
          WHEN 'array' THEN
            RETURN COALESCE((
              SELECT jsonb_agg(finance_json_without_sensitive(entry))
                FROM jsonb_array_elements(value) AS array_entry(entry)
            ), '[]'::jsonb);
          ELSE RETURN value;
        END CASE;
      END;
      $$ LANGUAGE plpgsql IMMUTABLE;
      ALTER TABLE money_operations DISABLE TRIGGER money_operations_evidence_immutable;
      UPDATE money_operations
         SET quote_snapshot = finance_json_without_sensitive(quote_snapshot),
             consent_snapshot = CASE WHEN consent_snapshot IS NULL THEN NULL
                                     ELSE finance_json_without_sensitive(consent_snapshot) END
       WHERE finance_json_without_sensitive(quote_snapshot) IS DISTINCT FROM quote_snapshot
          OR (consent_snapshot IS NOT NULL AND finance_json_without_sensitive(consent_snapshot) IS DISTINCT FROM consent_snapshot);
      ALTER TABLE money_operations ENABLE TRIGGER money_operations_evidence_immutable;
      UPDATE external_effects
         SET request_payload = finance_json_without_sensitive(request_payload),
             response_payload = CASE WHEN response_payload IS NULL THEN NULL
                                     ELSE finance_json_without_sensitive(response_payload) END
       WHERE finance_json_without_sensitive(request_payload) IS DISTINCT FROM request_payload
          OR (response_payload IS NOT NULL AND finance_json_without_sensitive(response_payload) IS DISTINCT FROM response_payload);
      UPDATE webhook_events
         SET payload = finance_json_without_sensitive(payload)
       WHERE finance_json_without_sensitive(payload) IS DISTINCT FROM payload;
      UPDATE external_effects
         SET request_payload = '{"redacted":true}'::jsonb,
             response_payload = CASE WHEN response_payload IS NULL THEN NULL ELSE '{"redacted":true}'::jsonb END,
             state = CASE WHEN state IN ('queued', 'leased', 'retry', 'ambiguous') THEN 'failed' ELSE state END,
             last_error_code = CASE WHEN state IN ('queued', 'leased', 'retry', 'ambiguous') THEN 'sensitive_payload_purged' ELSE last_error_code END,
             lease_owner = CASE WHEN state IN ('queued', 'leased', 'retry', 'ambiguous') THEN NULL ELSE lease_owner END,
             lease_expires_at = CASE WHEN state IN ('queued', 'leased', 'retry', 'ambiguous') THEN NULL ELSE lease_expires_at END
       WHERE effect_type IN ('enroll', 'create_link_token', 'register_bank');
      UPDATE money_operations operation
         SET state = 'review', failure_code = 'sensitive_payload_purged', updated_at = NOW(), version = version + 1
       WHERE EXISTS (
         SELECT 1 FROM external_effects effect
          WHERE effect.operation_id = operation.id
            AND effect.effect_type IN ('enroll', 'create_link_token', 'register_bank')
            AND effect.last_error_code = 'sensitive_payload_purged'
       );
      CREATE OR REPLACE FUNCTION reject_sensitive_finance_json() RETURNS TRIGGER AS $$
      DECLARE document JSONB := to_jsonb(NEW);
      BEGIN
        IF document = '{"redacted":true}'::jsonb THEN RETURN NEW; END IF;
        IF finance_json_without_sensitive(document) IS DISTINCT FROM document THEN
          RAISE EXCEPTION 'sensitive identity and link-token data must not be persisted';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS money_operations_sensitive_json ON money_operations;
      CREATE TRIGGER money_operations_sensitive_json BEFORE INSERT OR UPDATE OF quote_snapshot, consent_snapshot ON money_operations
        FOR EACH ROW EXECUTE FUNCTION reject_sensitive_finance_json();
      DROP TRIGGER IF EXISTS external_effects_sensitive_json ON external_effects;
      CREATE TRIGGER external_effects_sensitive_json BEFORE INSERT OR UPDATE OF request_payload, response_payload ON external_effects
        FOR EACH ROW EXECUTE FUNCTION reject_sensitive_finance_json();
      DROP TRIGGER IF EXISTS webhook_events_sensitive_json ON webhook_events;
      CREATE TRIGGER webhook_events_sensitive_json BEFORE INSERT OR UPDATE OF payload ON webhook_events
        FOR EACH ROW EXECUTE FUNCTION reject_sensitive_finance_json();
    `,
  },
  {
    version: 18,
    name: "finance_chain_identity_cursor_and_evidence_hardening",
    sql: `
      ALTER TABLE cash_game_quotes DROP CONSTRAINT IF EXISTS cash_quote_escrow_snapshot_identity;
      ALTER TABLE cash_game_quotes ADD CONSTRAINT cash_quote_escrow_snapshot_identity CHECK (
        escrow_snapshot = '{"legacyUnverified":true}'::jsonb
        OR (
          NULLIF(escrow_snapshot->>'chainId', '') IS NOT NULL
          AND NULLIF(escrow_snapshot->>'genesisHash', '') IS NOT NULL
          AND NULLIF(escrow_snapshot->>'escrowContract', '') IS NOT NULL
          AND NULLIF(escrow_snapshot->>'escrowCodeChecksum', '') IS NOT NULL
          AND NULLIF(escrow_snapshot->>'denom', '') IS NOT NULL
          AND NULLIF(escrow_snapshot->>'settlementAuthority', '') IS NOT NULL
        )
      );
      CREATE OR REPLACE FUNCTION reject_cash_game_supersession_mutation() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'cash-game supersessions are append-only evidence';
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS cash_game_quote_supersessions_immutable ON cash_game_quote_supersessions;
      CREATE TRIGGER cash_game_quote_supersessions_immutable
        BEFORE UPDATE OR DELETE ON cash_game_quote_supersessions
        FOR EACH ROW EXECUTE FUNCTION reject_cash_game_supersession_mutation();
      CREATE OR REPLACE FUNCTION assert_cash_commitment_decision_integrity() RETURNS TRIGGER AS $$
      DECLARE expected_hash TEXT;
      BEGIN
        SELECT quote_hash INTO expected_hash FROM cash_game_quotes WHERE id = NEW.quote_id;
        IF expected_hash IS NULL OR NEW.quote_hash <> expected_hash OR NEW.quote_hash = '' THEN
          RAISE EXCEPTION 'cash-game commitment decision must bind the immutable quote hash';
        END IF;
        IF NEW.eligibility_decision_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM eligibility_decisions WHERE id = NEW.eligibility_decision_id
        ) THEN
          RAISE EXCEPTION 'cash-game commitment decision references a missing eligibility decision';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS cash_commitment_decisions_integrity ON cash_game_commitment_decisions;
      CREATE TRIGGER cash_commitment_decisions_integrity
        BEFORE INSERT OR UPDATE ON cash_game_commitment_decisions
        FOR EACH ROW EXECUTE FUNCTION assert_cash_commitment_decision_integrity();
      DROP TRIGGER IF EXISTS cash_game_reality_intervals_immutable ON cash_game_reality_intervals;
      CREATE TRIGGER cash_game_reality_intervals_immutable BEFORE UPDATE OR DELETE ON cash_game_reality_intervals
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_mutation();
      CREATE TABLE IF NOT EXISTS finance_reconciliation_cursor (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
        observed_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
        operation_id TEXT NOT NULL DEFAULT '',
        provider_transfer_id TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE finance_reconciliation_cursor
        ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
        ADD COLUMN IF NOT EXISTS provider_transfer_id TEXT NOT NULL DEFAULT '';
      INSERT INTO finance_reconciliation_cursor (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
      CREATE INDEX IF NOT EXISTS idx_money_operations_reconciliation_cursor_v2
        ON money_operations(updated_at, id, provider_transfer_id) WHERE provider_transfer_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS external_effect_dispatches (
        effect_id TEXT NOT NULL REFERENCES external_effects(id),
        step TEXT NOT NULL CHECK (step IN ('external_wallet', 'internal_address', 'transfer', 'refund_transfer', 'escrow_create', 'escrow_settle', 'escrow_refund', 'direct_account', 'direct_link_token', 'direct_register_bank')),
        operation_id TEXT NOT NULL REFERENCES money_operations(id),
        principal TEXT NOT NULL,
        authorized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (effect_id, step)
      );
      DROP TRIGGER IF EXISTS external_effect_dispatches_immutable ON external_effect_dispatches;
      ALTER TABLE external_effect_dispatches DROP CONSTRAINT IF EXISTS external_effect_dispatches_step_check;
      ALTER TABLE external_effect_dispatches ADD CONSTRAINT external_effect_dispatches_step_check
        CHECK (step IN ('external_wallet', 'internal_address', 'transfer', 'refund_transfer', 'escrow_create', 'escrow_settle', 'escrow_refund', 'direct_account', 'direct_link_token', 'direct_register_bank'));
      CREATE TRIGGER external_effect_dispatches_immutable BEFORE UPDATE OR DELETE ON external_effect_dispatches
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_mutation();
      CREATE INDEX IF NOT EXISTS idx_external_effects_refund_reconciliation
        ON external_effects(operation_id, provider_reference, updated_at)
        WHERE effect_type = 'cash_out_refund' AND provider_reference IS NOT NULL;
      ALTER TABLE journal_batches DISABLE TRIGGER journal_batches_immutable;
      UPDATE journal_batches reversal
         SET reverses_batch_id = original.id
        FROM journal_batches original
       WHERE reversal.operation_id = original.operation_id
         AND (
           (reversal.entry_key IN ('reversal', 'return', 'provider_reversal') AND original.entry_key = 'complete')
           OR (reversal.entry_key = 'chain_return' AND original.entry_key = 'chain_inbound')
         )
         AND reversal.reverses_batch_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM journal_batches competing
            WHERE competing.operation_id = reversal.operation_id
              AND competing.entry_key = reversal.entry_key
              AND competing.reverses_batch_id = original.id
         );
      ALTER TABLE journal_batches ENABLE TRIGGER journal_batches_immutable;
      UPDATE money_operations operation
         SET state = 'review',
             failure_code = 'legacy_reversal_link_missing',
             updated_at = NOW(),
             version = version + 1
       WHERE EXISTS (
         SELECT 1 FROM journal_batches reversal
          WHERE reversal.operation_id = operation.id
            AND reversal.entry_key IN ('reversal', 'return', 'provider_reversal', 'chain_return')
            AND NOT EXISTS (
              SELECT 1 FROM journal_batches original
               WHERE original.id = reversal.reverses_batch_id
                 AND original.operation_id = reversal.operation_id
                 AND original.entry_key = CASE
                   WHEN reversal.entry_key = 'chain_return' THEN 'chain_inbound'
                   ELSE 'complete'
                 END
            )
       );
      UPDATE money_operations
         SET state = 'review',
             failure_code = 'legacy_chain_identity_missing',
             updated_at = NOW(),
             version = version + 1
       WHERE kind IN ('deposit', 'cash_out')
         AND state NOT IN ('complete', 'failed', 'canceled', 'refunded')
         AND (
           NULLIF(quote_snapshot->>'chainId', '') IS NULL
           OR NULLIF(quote_snapshot->>'genesisHash', '') IS NULL
         );
      CREATE OR REPLACE FUNCTION finance_json_key_is_sensitive(key_name TEXT) RETURNS BOOLEAN AS $$
      DECLARE normalized TEXT := regexp_replace(lower(key_name), '[^a-z0-9]', '', 'g');
      BEGIN
        RETURN normalized IN (
          'name', 'firstname', 'middlename', 'lastname', 'fullname', 'legalname',
          'email', 'emailaddress', 'dateofbirth', 'birthdate', 'dob',
          'phone', 'phonenumber', 'address', 'residentialaddress',
          'street', 'streetline1', 'streetline2', 'addressline1', 'addressline2',
          'postalcode', 'zipcode', 'identity', 'identitydocument', 'documentnumber',
          'passportnumber', 'driverslicensenumber', 'socialsecuritynumber', 'ssn',
          'taxid', 'ip', 'ipaddress', 'useragent', 'bankaccountnumber',
          'accountnumber', 'routingnumber'
        ) OR normalized ~ '(token|secret|password|credential)$';
      END;
      $$ LANGUAGE plpgsql IMMUTABLE STRICT;
      CREATE OR REPLACE FUNCTION finance_json_without_sensitive(value JSONB) RETURNS JSONB AS $$
      BEGIN
        CASE jsonb_typeof(value)
          WHEN 'object' THEN
            RETURN COALESCE((
              SELECT jsonb_object_agg(key, finance_json_without_sensitive(entry))
                FROM jsonb_each(value) AS object_entry(key, entry)
               WHERE NOT finance_json_key_is_sensitive(key)
            ), '{}'::jsonb);
          WHEN 'array' THEN
            RETURN COALESCE((
              SELECT jsonb_agg(finance_json_without_sensitive(entry))
                FROM jsonb_array_elements(value) AS array_entry(entry)
            ), '[]'::jsonb);
          ELSE RETURN value;
        END CASE;
      END;
      $$ LANGUAGE plpgsql IMMUTABLE;
      ALTER TABLE money_operations DISABLE TRIGGER money_operations_evidence_immutable;
      UPDATE money_operations
         SET quote_snapshot = finance_json_without_sensitive(quote_snapshot),
             consent_snapshot = CASE WHEN consent_snapshot IS NULL THEN NULL
                                     ELSE finance_json_without_sensitive(consent_snapshot) END
       WHERE finance_json_without_sensitive(quote_snapshot) IS DISTINCT FROM quote_snapshot
          OR (consent_snapshot IS NOT NULL AND finance_json_without_sensitive(consent_snapshot) IS DISTINCT FROM consent_snapshot);
      ALTER TABLE money_operations ENABLE TRIGGER money_operations_evidence_immutable;
      UPDATE external_effects
         SET request_payload = finance_json_without_sensitive(request_payload),
             response_payload = CASE WHEN response_payload IS NULL THEN NULL
                                     ELSE finance_json_without_sensitive(response_payload) END
       WHERE finance_json_without_sensitive(request_payload) IS DISTINCT FROM request_payload
          OR (response_payload IS NOT NULL AND finance_json_without_sensitive(response_payload) IS DISTINCT FROM response_payload);
      UPDATE webhook_events
         SET payload = finance_json_without_sensitive(payload)
       WHERE finance_json_without_sensitive(payload) IS DISTINCT FROM payload;
      CREATE OR REPLACE FUNCTION reject_sensitive_finance_json() RETURNS TRIGGER AS $$
      DECLARE document JSONB := to_jsonb(NEW);
      BEGIN
        IF document = '{"redacted":true}'::jsonb THEN RETURN NEW; END IF;
        IF finance_json_without_sensitive(document) IS DISTINCT FROM document THEN
          RAISE EXCEPTION 'sensitive identity and link-token data must not be persisted';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS money_operations_sensitive_json ON money_operations;
      CREATE TRIGGER money_operations_sensitive_json BEFORE INSERT OR UPDATE OF quote_snapshot, consent_snapshot ON money_operations
        FOR EACH ROW EXECUTE FUNCTION reject_sensitive_finance_json();
      DROP TRIGGER IF EXISTS external_effects_sensitive_json ON external_effects;
      CREATE TRIGGER external_effects_sensitive_json BEFORE INSERT OR UPDATE OF request_payload, response_payload ON external_effects
        FOR EACH ROW EXECUTE FUNCTION reject_sensitive_finance_json();
      DROP TRIGGER IF EXISTS webhook_events_sensitive_json ON webhook_events;
      CREATE TRIGGER webhook_events_sensitive_json BEFORE INSERT OR UPDATE OF payload ON webhook_events
        FOR EACH ROW EXECUTE FUNCTION reject_sensitive_finance_json();
    `,
  },
  {
    version: 19,
    name: "finance_sensitive_key_precision",
    sql: `
      CREATE OR REPLACE FUNCTION finance_json_key_is_sensitive(key_name TEXT) RETURNS BOOLEAN AS $$
      DECLARE normalized TEXT := regexp_replace(lower(key_name), '[^a-z0-9]', '', 'g');
      BEGIN
        RETURN normalized IN (
          'name', 'firstname', 'middlename', 'lastname', 'fullname', 'legalname',
          'email', 'emailaddress', 'dateofbirth', 'birthdate', 'dob',
          'phone', 'phonenumber', 'address', 'residentialaddress',
          'street', 'streetline1', 'streetline2', 'addressline1', 'addressline2',
          'postalcode', 'zipcode', 'identity', 'identitydocument', 'documentnumber',
          'passportnumber', 'driverslicensenumber', 'socialsecuritynumber', 'ssn',
          'taxid', 'ip', 'ipaddress', 'useragent', 'bankaccountnumber',
          'accountnumber', 'routingnumber'
        ) OR normalized ~ '(token|secret|password|credential)$';
      END;
      $$ LANGUAGE plpgsql IMMUTABLE STRICT;
      CREATE OR REPLACE FUNCTION finance_json_without_sensitive(value JSONB) RETURNS JSONB AS $$
      BEGIN
        CASE jsonb_typeof(value)
          WHEN 'object' THEN
            RETURN COALESCE((
              SELECT jsonb_object_agg(key, finance_json_without_sensitive(entry))
                FROM jsonb_each(value) AS object_entry(key, entry)
               WHERE NOT finance_json_key_is_sensitive(key)
            ), '{}'::jsonb);
          WHEN 'array' THEN
            RETURN COALESCE((
              SELECT jsonb_agg(finance_json_without_sensitive(entry))
                FROM jsonb_array_elements(value) AS array_entry(entry)
            ), '[]'::jsonb);
          ELSE RETURN value;
        END CASE;
      END;
      $$ LANGUAGE plpgsql IMMUTABLE;
    `,
  },
  {
    version: 20,
    name: "finance_reconciliation_and_moderation_evidence",
    sql: `
      ALTER TABLE cash_game_reserves
        ADD COLUMN IF NOT EXISTS reserve_journal_batch_id TEXT REFERENCES journal_batches(id),
        ADD COLUMN IF NOT EXISTS finality_block_hash TEXT;
      WITH affected_quotes AS (
        SELECT DISTINCT quote_id
          FROM cash_game_reserves
         WHERE state = 'final'
           AND (NULLIF(finality_block_hash, '') IS NULL OR reserve_journal_batch_id IS NULL)
      ), reviewed_quotes AS (
        UPDATE cash_game_quotes quote
           SET pre_review_state = CASE WHEN quote.state = 'review' THEN quote.pre_review_state ELSE quote.state END,
               pre_review_funded_start_deadline = CASE
                 WHEN quote.state = 'review' THEN quote.pre_review_funded_start_deadline
                 ELSE quote.funded_start_deadline
               END,
               state = 'review',
               review_reason = 'escrow_reconciliation',
               review_deadline = NOW() + INTERVAL '7 days',
               resolution_state = 'operator_resolution_required',
               resolution_reason = 'legacy_reserve_evidence_missing',
               recovery_round = quote.recovery_round + 1,
               version = quote.version + 1
         WHERE quote.id IN (SELECT quote_id FROM affected_quotes)
         RETURNING quote.id
      ), reviewed_operations AS (
        UPDATE money_operations operation
           SET state = 'review',
               failure_code = 'legacy_reserve_evidence_missing',
               updated_at = NOW(),
               version = operation.version + 1
         WHERE operation.quote_snapshot->>'quoteId' IN (SELECT quote_id FROM affected_quotes)
         RETURNING operation.id
      )
      SELECT COUNT(*) FROM reviewed_operations;
      UPDATE cash_game_reserves
         SET state = 'review',
             updated_at = NOW()
       WHERE state = 'final'
         AND (
           NULLIF(finality_block_hash, '') IS NULL
           OR reserve_journal_batch_id IS NULL
         );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_reserves_reserve_journal_batch
        ON cash_game_reserves(reserve_journal_batch_id)
        WHERE reserve_journal_batch_id IS NOT NULL;
      ALTER TABLE cash_game_reserves DROP CONSTRAINT IF EXISTS cash_reserve_final_evidence;
      ALTER TABLE cash_game_reserves ADD CONSTRAINT cash_reserve_final_evidence CHECK (
        state <> 'final' OR (
          chain_tx_hash ~ '^[0-9A-F]{64}$'
          AND chain_height IS NOT NULL
          AND chain_height > 0
          AND NULLIF(finality_block_hash, '') IS NOT NULL
          AND reserve_journal_batch_id IS NOT NULL
      ));
      ALTER TABLE journal_batches DROP CONSTRAINT IF EXISTS journal_batches_operation_id_key;
      DROP INDEX IF EXISTS journal_batches_operation_id_key;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_operation_entry
        ON journal_batches(operation_id, entry_key);

      ALTER TABLE user_reports
        ADD COLUMN IF NOT EXISTS request_id TEXT,
        ADD COLUMN IF NOT EXISTS payload_hash TEXT,
        ADD COLUMN IF NOT EXISTS description_encrypted JSONB,
        ADD COLUMN IF NOT EXISTS claimed_by TEXT,
        ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS resolved_by TEXT,
        ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS resolution_code TEXT;
      UPDATE user_reports
         SET request_id = COALESCE(request_id, 'legacy:' || id),
             payload_hash = COALESCE(payload_hash, 'legacy:' || id)
       WHERE request_id IS NULL OR payload_hash IS NULL;
      ALTER TABLE user_reports
        ALTER COLUMN request_id SET NOT NULL,
        ALTER COLUMN payload_hash SET NOT NULL,
        ADD CONSTRAINT user_reports_payload_hash_format CHECK (
          payload_hash ~ '^[0-9a-f]{64}$' OR payload_hash LIKE 'legacy:%'
        );
      DROP INDEX IF EXISTS idx_user_reports_reporter_request;
      CREATE UNIQUE INDEX idx_user_reports_reporter_request
        ON user_reports(reporter, request_id);
      CREATE INDEX IF NOT EXISTS idx_user_reports_queue
        ON user_reports(state, created_at, id);
      CREATE TABLE IF NOT EXISTS user_report_audit (
        id BIGSERIAL PRIMARY KEY,
        report_id TEXT NOT NULL REFERENCES user_reports(id),
        event_type TEXT NOT NULL CHECK (event_type IN ('claimed', 'resolved')),
        actor TEXT NOT NULL,
        prior_state TEXT NOT NULL,
        next_state TEXT NOT NULL,
        resolution_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE OR REPLACE FUNCTION reject_user_report_audit_mutation() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'user-report audit evidence is immutable';
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS user_report_audit_immutable ON user_report_audit;
      CREATE TRIGGER user_report_audit_immutable
        BEFORE UPDATE OR DELETE ON user_report_audit
        FOR EACH ROW EXECUTE FUNCTION reject_user_report_audit_mutation();
    `,
  },
  {
    version: 21,
    name: "legacy_reserve_evidence_review_repair",
    sql: `
      WITH affected_quotes AS (
        SELECT DISTINCT quote_id
          FROM cash_game_reserves
         WHERE state = 'review'
           AND (NULLIF(finality_block_hash, '') IS NULL OR reserve_journal_batch_id IS NULL)
      ), reviewed_quotes AS (
        UPDATE cash_game_quotes quote
           SET pre_review_state = CASE WHEN quote.state = 'review' THEN quote.pre_review_state ELSE quote.state END,
               pre_review_funded_start_deadline = CASE
                 WHEN quote.state = 'review' THEN quote.pre_review_funded_start_deadline
                 ELSE quote.funded_start_deadline
               END,
               state = 'review',
               review_reason = 'escrow_reconciliation',
               review_deadline = NOW() + INTERVAL '7 days',
               resolution_state = 'operator_resolution_required',
               resolution_reason = 'legacy_reserve_evidence_missing',
               recovery_round = quote.recovery_round + 1,
               version = quote.version + 1
         WHERE quote.id IN (SELECT quote_id FROM affected_quotes)
         RETURNING quote.id
      ), reviewed_operations AS (
        UPDATE money_operations operation
           SET state = 'review',
               failure_code = 'legacy_reserve_evidence_missing',
               updated_at = NOW(),
               version = operation.version + 1
         WHERE operation.quote_snapshot->>'quoteId' IN (SELECT quote_id FROM affected_quotes)
         RETURNING operation.id
      )
      SELECT COUNT(*) FROM reviewed_operations;
    `,
  },

  {
    version: 22,
    name: "legacy_report_narrative_backfill",
    sql: `
      CREATE TABLE IF NOT EXISTS user_report_narrative_reconciliations (
        report_id TEXT PRIMARY KEY REFERENCES user_reports(id),
        outcome TEXT NOT NULL CHECK (outcome = 'backup_restore_required'),
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      DROP TRIGGER IF EXISTS user_report_narrative_reconciliations_immutable
        ON user_report_narrative_reconciliations;
      CREATE TRIGGER user_report_narrative_reconciliations_immutable
        BEFORE UPDATE OR DELETE ON user_report_narrative_reconciliations
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_mutation();
    `,
    apply: async (client) => {
      if (await backfillLegacyReportNarratives(client) === "backfilled") {
        await client.query("ALTER TABLE user_reports DROP COLUMN IF EXISTS description");
      }
    },
  },
  {
    version: 23,
    name: "escrow_reconciliation_and_provider_retry_evidence",
    sql: `
      CREATE TABLE IF NOT EXISTS legacy_escrow_reserve_reconciliations (
        quote_id TEXT NOT NULL,
        principal TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'attestation_required',
          'chain_convergence_required',
          'manual_reconstruction_required',
          'reconciled'
        )),
        reason_code TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (quote_id, principal),
        FOREIGN KEY (quote_id, principal) REFERENCES cash_game_reserves(quote_id, principal)
      );
      CREATE INDEX IF NOT EXISTS idx_legacy_escrow_reserve_reconciliations_pending
        ON legacy_escrow_reserve_reconciliations(state, updated_at)
        WHERE state IN ('attestation_required', 'chain_convergence_required');

      CREATE TABLE IF NOT EXISTS legacy_escrow_manual_reconstruction_requirements (
        effect_id TEXT PRIMARY KEY REFERENCES external_effects(id),
        quote_id TEXT NOT NULL REFERENCES cash_game_quotes(id),
        principal TEXT NOT NULL,
        requirement TEXT NOT NULL CHECK (
          requirement = 'backup_restore_or_manual_reconstruction_required'
        ),
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE OR REPLACE FUNCTION reject_legacy_escrow_manual_reconstruction_mutation() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'legacy escrow manual reconstruction requirements are immutable';
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS legacy_escrow_manual_reconstruction_requirements_immutable
        ON legacy_escrow_manual_reconstruction_requirements;
      CREATE TRIGGER legacy_escrow_manual_reconstruction_requirements_immutable
        BEFORE UPDATE OR DELETE ON legacy_escrow_manual_reconstruction_requirements
        FOR EACH ROW EXECUTE FUNCTION reject_legacy_escrow_manual_reconstruction_mutation();

      INSERT INTO legacy_escrow_manual_reconstruction_requirements (
        effect_id, quote_id, principal, requirement
      )
      SELECT effect.id, operation.quote_snapshot->>'quoteId', operation.principal,
             'backup_restore_or_manual_reconstruction_required'
        FROM external_effects effect
        JOIN external_effect_dispatches dispatch ON dispatch.effect_id = effect.id
        JOIN money_operations operation ON operation.id = effect.operation_id
       WHERE effect.effect_type IN ('escrow_create', 'escrow_settle', 'escrow_refund')
         AND operation.quote_snapshot->>'quoteId' IS NOT NULL
         AND effect.request_payload = '{"redacted":true}'::jsonb
      ON CONFLICT (effect_id) DO NOTHING;

      INSERT INTO legacy_escrow_reserve_reconciliations (
        quote_id, principal, state, reason_code
      )
      SELECT reserve.quote_id, reserve.principal,
             CASE
               WHEN EXISTS (
                 SELECT 1
                   FROM legacy_escrow_manual_reconstruction_requirements requirement
                   JOIN money_operations operation
                     ON operation.quote_snapshot->>'quoteId' = requirement.quote_id
                  WHERE operation.principal = reserve.principal
                    AND requirement.quote_id = reserve.quote_id
               ) THEN 'manual_reconstruction_required'
               WHEN EXISTS (
                 SELECT 1
                   FROM external_effects effect
                   JOIN external_effect_dispatches dispatch ON dispatch.effect_id = effect.id
                   JOIN money_operations operation ON operation.id = effect.operation_id
                  WHERE operation.quote_snapshot->>'quoteId' = reserve.quote_id
                    AND effect.effect_type IN ('escrow_create', 'escrow_settle', 'escrow_refund')
               ) THEN 'chain_convergence_required'
               ELSE 'attestation_required'
             END,
             CASE
               WHEN EXISTS (
                 SELECT 1
                   FROM legacy_escrow_manual_reconstruction_requirements requirement
                   JOIN money_operations operation
                     ON operation.quote_snapshot->>'quoteId' = requirement.quote_id
                  WHERE operation.principal = reserve.principal
                    AND requirement.quote_id = reserve.quote_id
               ) THEN 'legacy_dispatched_payload_redacted'
               WHEN EXISTS (
                 SELECT 1
                   FROM external_effects effect
                   JOIN external_effect_dispatches dispatch ON dispatch.effect_id = effect.id
                   JOIN money_operations operation ON operation.id = effect.operation_id
                  WHERE operation.quote_snapshot->>'quoteId' = reserve.quote_id
                    AND effect.effect_type IN ('escrow_create', 'escrow_settle', 'escrow_refund')
               ) THEN 'legacy_dispatched_effect_requires_chain_convergence'
               ELSE 'legacy_reserve_evidence_missing'
             END
        FROM cash_game_reserves reserve
       WHERE reserve.state = 'review'
         AND (NULLIF(reserve.finality_block_hash, '') IS NULL OR reserve.reserve_journal_batch_id IS NULL)
      ON CONFLICT (quote_id, principal) DO NOTHING;

      UPDATE external_effects effect
         SET state = 'retry',
             lease_owner = NULL,
             lease_expires_at = NULL,
             next_attempt_at = NOW(),
             updated_at = NOW()
        FROM money_operations operation
        JOIN legacy_escrow_reserve_reconciliations reconciliation
          ON reconciliation.quote_id = operation.quote_snapshot->>'quoteId'
       WHERE effect.operation_id = operation.id
         AND effect.effect_type IN ('escrow_create', 'escrow_settle', 'escrow_refund')
         AND effect.state IN ('queued', 'retry', 'ambiguous', 'leased', 'sent')
         AND effect.request_payload <> '{"redacted":true}'::jsonb
         AND reconciliation.state IN ('attestation_required', 'chain_convergence_required')
         AND EXISTS (
           SELECT 1 FROM external_effect_dispatches dispatch
            WHERE dispatch.effect_id = effect.id
         );

      CREATE OR REPLACE FUNCTION assert_journal_batch_conserved() RETURNS TRIGGER AS $$
      DECLARE row_document JSONB := COALESCE(to_jsonb(NEW), to_jsonb(OLD));
      DECLARE batch_key TEXT := COALESCE(row_document->>'batch_id', row_document->>'id');
      DECLARE operation_key TEXT;
      DECLARE entry TEXT;
      DECLARE reverse_key TEXT;
      DECLARE required_original_entry TEXT;
      DECLARE reserve_principal TEXT;
      DECLARE cross_reserve_reversal BOOLEAN;
      DECLARE debits BIGINT;
      DECLARE credits BIGINT;
      BEGIN
        SELECT operation_id, entry_key, reverses_batch_id
          INTO operation_key, entry, reverse_key
          FROM journal_batches WHERE id = batch_key;
        IF operation_key IS NULL THEN RETURN NULL; END IF;
        SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_micro_usd ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_micro_usd ELSE 0 END), 0)
          INTO debits, credits FROM journal_lines WHERE batch_id = batch_key;
        IF debits <> credits OR debits = 0 THEN
          RAISE EXCEPTION 'journal batch must contain balanced non-zero paired lines';
        END IF;
        cross_reserve_reversal := entry ~ '^(settlement|refund)_reserve_reversal:[^:]+$';
        IF cross_reserve_reversal THEN
          reserve_principal := split_part(entry, ':', 2);
          IF reverse_key IS NULL OR NOT EXISTS (
            SELECT 1
              FROM journal_batches original
              JOIN money_operations original_operation ON original_operation.id = original.operation_id
              JOIN money_operations terminal_operation ON terminal_operation.id = operation_key
             WHERE original.id = reverse_key
               AND original.entry_key = 'reserve:' || reserve_principal
               AND original.asset_denom = (
                 SELECT asset_denom FROM journal_batches WHERE id = batch_key
               )
               AND NULLIF(original_operation.quote_snapshot->>'quoteId', '') IS NOT NULL
               AND original_operation.quote_snapshot->>'quoteId'
                   = terminal_operation.quote_snapshot->>'quoteId'
          ) THEN
            RAISE EXCEPTION 'reserve reversal must link to the same-principal reserve in the same quote and asset';
          END IF;
          IF EXISTS (
            (
              SELECT account_code, principal,
                     CASE direction WHEN 'debit' THEN 'credit' ELSE 'debit' END AS direction,
                     amount_micro_usd
                FROM journal_lines
               WHERE batch_id = reverse_key
              EXCEPT ALL
              SELECT account_code, principal, direction, amount_micro_usd
                FROM journal_lines
               WHERE batch_id = batch_key
            )
            UNION ALL
            (
              SELECT account_code, principal, direction, amount_micro_usd
                FROM journal_lines
               WHERE batch_id = batch_key
              EXCEPT ALL
              SELECT account_code, principal,
                     CASE direction WHEN 'debit' THEN 'credit' ELSE 'debit' END AS direction,
                     amount_micro_usd
                FROM journal_lines
               WHERE batch_id = reverse_key
            )
          ) THEN
            RAISE EXCEPTION 'reserve reversal journal lines must exactly invert the original reserve';
          END IF;
        ELSE
          required_original_entry := CASE
            WHEN entry IN ('reversal', 'return', 'provider_reversal') THEN 'complete'
            WHEN entry = 'chain_return' THEN 'chain_inbound'
            ELSE NULL
          END;
          IF required_original_entry IS NULL THEN
            IF reverse_key IS NOT NULL THEN
              RAISE EXCEPTION 'non-reversal journal batch cannot reverse another batch';
            END IF;
          ELSIF reverse_key IS NULL OR NOT EXISTS (
            SELECT 1 FROM journal_batches
             WHERE id = reverse_key
               AND operation_id = operation_key
               AND entry_key = required_original_entry
          ) THEN
            RAISE EXCEPTION 'journal reversal must link to the matching original batch';
          END IF;
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TABLE IF NOT EXISTS finance_resource_reconciliation_outcomes (
        resource_type TEXT NOT NULL CHECK (resource_type IN ('account', 'address')),
        resource_id TEXT NOT NULL,
        retry_count SMALLINT NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 255),
        last_error_code TEXT NOT NULL CHECK (length(last_error_code) BETWEEN 1 AND 100),
        next_attempt_at TIMESTAMPTZ NOT NULL,
        last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (resource_type, resource_id)
      );
      CREATE INDEX IF NOT EXISTS idx_finance_resource_reconciliation_outcomes_due
        ON finance_resource_reconciliation_outcomes(next_attempt_at);

      CREATE TABLE IF NOT EXISTS late_deposit_completion_reviews (
        operation_id TEXT PRIMARY KEY REFERENCES money_operations(id),
        effect_id TEXT NOT NULL UNIQUE REFERENCES external_effects(id),
        provider_transfer_id TEXT NOT NULL,
        provider_state TEXT NOT NULL CHECK (provider_state = 'complete'),
        compensation_requirement TEXT NOT NULL CHECK (
          compensation_requirement = 'chain_funds_reconciliation_required_before_any_recredit'
        ),
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE OR REPLACE FUNCTION reject_late_deposit_completion_review_mutation() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'late deposit completion review evidence is immutable';
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS late_deposit_completion_reviews_immutable
        ON late_deposit_completion_reviews;
      CREATE TRIGGER late_deposit_completion_reviews_immutable
        BEFORE UPDATE OR DELETE ON late_deposit_completion_reviews
        FOR EACH ROW EXECUTE FUNCTION reject_late_deposit_completion_review_mutation();
    `,
  },
  {
    version: 24,
    name: "legacy_effect_recovery_closure",
    sql: `
      INSERT INTO legacy_escrow_manual_reconstruction_requirements (
        effect_id, quote_id, principal, requirement
      )
      SELECT effect.id, operation.quote_snapshot->>'quoteId', operation.principal,
             'backup_restore_or_manual_reconstruction_required'
        FROM external_effects effect
        JOIN money_operations operation ON operation.id = effect.operation_id
       WHERE effect.effect_type IN ('escrow_create', 'escrow_settle', 'escrow_refund')
         AND NULLIF(operation.quote_snapshot->>'quoteId', '') IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM legacy_escrow_reserve_reconciliations reconciliation
            WHERE reconciliation.quote_id = operation.quote_snapshot->>'quoteId'
         )
         AND (
           effect.request_payload = '{"redacted":true}'::jsonb
           OR effect.state = 'failed'
           OR (
             effect.state IN ('ambiguous', 'sent')
             AND NOT EXISTS (
               SELECT 1 FROM external_effect_dispatches dispatch
                WHERE dispatch.effect_id = effect.id
             )
           )
         )
      ON CONFLICT (effect_id) DO NOTHING;

      WITH affected_quotes AS (
        SELECT DISTINCT requirement.quote_id
          FROM legacy_escrow_manual_reconstruction_requirements requirement
      )
      UPDATE cash_game_quotes quote
         SET pre_review_state = CASE WHEN quote.state = 'review' THEN quote.pre_review_state ELSE quote.state END,
             pre_review_funded_start_deadline = CASE
               WHEN quote.state = 'review' THEN quote.pre_review_funded_start_deadline
               ELSE quote.funded_start_deadline
             END,
             state = 'review',
             review_reason = 'escrow_reconciliation',
             review_deadline = COALESCE(quote.review_deadline, NOW() + INTERVAL '7 days'),
             resolution_state = 'operator_resolution_required',
             resolution_reason = 'legacy_effect_reconstruction_required',
             recovery_round = quote.recovery_round + 1,
             version = quote.version + 1
       WHERE quote.id IN (SELECT quote_id FROM affected_quotes);

      UPDATE money_operations operation
         SET state = 'review',
             failure_code = 'legacy_effect_reconstruction_required',
             updated_at = NOW(),
             version = operation.version + 1
       WHERE operation.quote_snapshot->>'quoteId' IN (
         SELECT DISTINCT quote_id FROM legacy_escrow_manual_reconstruction_requirements
       );

      UPDATE money_operations operation
         SET state = 'pending',
             failure_code = 'provider_response_ambiguous',
             updated_at = NOW(),
             version = operation.version + 1
        FROM external_effects effect
       WHERE effect.operation_id = operation.id
         AND effect.effect_type = 'direct_account'
         AND effect.state = 'ambiguous'
         AND effect.last_error_code = 'provider_response_ambiguous'
         AND operation.kind = 'enroll'
         AND operation.state = 'review';
    `,
  },
  {
    version: 25,
    name: "late_cashout_completion_review_evidence",
    sql: `
      CREATE TABLE IF NOT EXISTS late_cash_out_completion_reviews (
        operation_id TEXT PRIMARY KEY REFERENCES money_operations(id),
        effect_id TEXT NOT NULL UNIQUE REFERENCES external_effects(id),
        provider_transfer_id TEXT NOT NULL,
        provider_state TEXT NOT NULL CHECK (provider_state = 'complete'),
        held_micro_usd BIGINT NOT NULL CHECK (held_micro_usd > 0),
        compensation_requirement TEXT NOT NULL CHECK (
          compensation_requirement = 'provider_payout_compensation_required_before_chain_funds_reuse'
        ),
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE OR REPLACE FUNCTION reject_late_cash_out_completion_review_mutation() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'late cash-out completion review evidence is immutable';
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS late_cash_out_completion_reviews_immutable
        ON late_cash_out_completion_reviews;
      CREATE TRIGGER late_cash_out_completion_reviews_immutable
        BEFORE UPDATE OR DELETE ON late_cash_out_completion_reviews
        FOR EACH ROW EXECUTE FUNCTION reject_late_cash_out_completion_review_mutation();

      WITH candidates AS (
        SELECT operation.id AS operation_id,
               MIN(effect.id) AS effect_id,
               MIN(effect.provider_reference) AS provider_transfer_id,
               COUNT(DISTINCT effect.provider_reference) AS provider_reference_count,
               operation.amount_micro_usd AS held_micro_usd
          FROM money_operations operation
          JOIN external_effects effect ON effect.operation_id = operation.id
         WHERE operation.kind = 'cash_out'
           AND operation.state = 'review'
           AND operation.failure_code = 'late_original_cash_out_complete_after_refund'
           AND operation.amount_micro_usd IS NOT NULL
           AND effect.state = 'confirmed'
           AND effect.last_error_code = 'late_original_cash_out_complete_after_refund'
           AND effect.provider_reference IS NOT NULL
         GROUP BY operation.id, operation.amount_micro_usd
      )
      INSERT INTO late_cash_out_completion_reviews (
        operation_id, effect_id, provider_transfer_id, provider_state,
        held_micro_usd, compensation_requirement
      )
      SELECT operation_id, effect_id, provider_transfer_id, 'complete',
             held_micro_usd, 'provider_payout_compensation_required_before_chain_funds_reuse'
        FROM candidates
       WHERE provider_reference_count = 1
      ON CONFLICT (operation_id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS late_cash_out_completion_reconstruction_requirements (
        operation_id TEXT PRIMARY KEY REFERENCES money_operations(id),
        requirement TEXT NOT NULL CHECK (
          requirement = 'provider_completion_evidence_reconstruction_required'
        ),
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      DROP TRIGGER IF EXISTS late_cash_out_completion_reconstruction_requirements_immutable
        ON late_cash_out_completion_reconstruction_requirements;
      CREATE TRIGGER late_cash_out_completion_reconstruction_requirements_immutable
        BEFORE UPDATE OR DELETE ON late_cash_out_completion_reconstruction_requirements
        FOR EACH ROW EXECUTE FUNCTION reject_late_cash_out_completion_review_mutation();
      INSERT INTO late_cash_out_completion_reconstruction_requirements (operation_id, requirement)
      SELECT operation.id, 'provider_completion_evidence_reconstruction_required'
        FROM money_operations operation
       WHERE operation.kind = 'cash_out'
         AND operation.state = 'review'
         AND operation.failure_code = 'late_original_cash_out_complete_after_refund'
         AND NOT EXISTS (
           SELECT 1 FROM late_cash_out_completion_reviews review
            WHERE review.operation_id = operation.id
         )
      ON CONFLICT (operation_id) DO NOTHING;
    `,
  },
  {
    version: 26,
    name: "authentication_retention_indexes",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_consumed_auth_challenges_expiry
        ON consumed_auth_challenges(expires_at);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_revoked
        ON auth_sessions(revoked_at) WHERE revoked_at IS NOT NULL;
    `,
  },
  {
    version: 27,
    name: "leased_legacy_recovery_and_append_only_resolution",
    sql: `
      ALTER TABLE legacy_escrow_reserve_reconciliations
        ADD COLUMN IF NOT EXISTS lease_owner TEXT;
      ALTER TABLE legacy_escrow_reserve_reconciliations
        ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS idx_legacy_escrow_recovery_claim
        ON legacy_escrow_reserve_reconciliations(state, lease_expires_at, updated_at)
        WHERE state IN ('attestation_required', 'chain_convergence_required');

      CREATE TABLE IF NOT EXISTS legacy_escrow_manual_reconstruction_resolutions (
        effect_id TEXT PRIMARY KEY
          REFERENCES legacy_escrow_manual_reconstruction_requirements(effect_id),
        resolution_type TEXT NOT NULL CHECK (
          resolution_type IN ('backup_restored', 'terminal_custody_recovered')
        ),
        evidence_snapshot JSONB NOT NULL CHECK (jsonb_typeof(evidence_snapshot) = 'object'),
        resolved_by TEXT NOT NULL,
        resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE OR REPLACE FUNCTION reject_legacy_escrow_manual_resolution_mutation() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'legacy escrow manual reconstruction resolutions are immutable';
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS legacy_escrow_manual_reconstruction_resolutions_immutable
        ON legacy_escrow_manual_reconstruction_resolutions;
      CREATE TRIGGER legacy_escrow_manual_reconstruction_resolutions_immutable
        BEFORE UPDATE OR DELETE ON legacy_escrow_manual_reconstruction_resolutions
        FOR EACH ROW EXECUTE FUNCTION reject_legacy_escrow_manual_resolution_mutation();
    `,
  },
  {
    version: 28,
    name: "shared_fenced_matchmaking_queue",
    sql: `
      CREATE TABLE IF NOT EXISTS matchmaking_queue (
        address TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        rating INTEGER NOT NULL,
        wager_amount BIGINT NOT NULL CHECK (wager_amount >= 0),
        match_length INTEGER NOT NULL CHECK (match_length BETWEEN 1 AND 25),
        state TEXT NOT NULL CHECK (state IN ('queued', 'matched')),
        game_id TEXT,
        owner_instance_id TEXT,
        color TEXT CHECK (color IN ('white', 'black')),
        joined_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        claim_expires_at TIMESTAMPTZ,
        ready_at TIMESTAMPTZ,
        notified_at TIMESTAMPTZ,
        CHECK (
          (state = 'queued' AND game_id IS NULL AND owner_instance_id IS NULL AND color IS NULL)
          OR
          (state = 'matched' AND game_id IS NOT NULL AND owner_instance_id IS NOT NULL AND color IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_matchmaking_queue_candidates
        ON matchmaking_queue(state, wager_amount, match_length, joined_at)
        WHERE state = 'queued';
      CREATE INDEX IF NOT EXISTS idx_matchmaking_queue_notifications
        ON matchmaking_queue(instance_id, state, ready_at, notified_at)
        WHERE state = 'matched';
    `,
  },
  {
    version: 29,
    name: "durable_match_continuations",
    sql: `
      CREATE TABLE IF NOT EXISTS backgammon_match_continuations (
        match_id TEXT NOT NULL REFERENCES backgammon_matches(id),
        completed_game_id TEXT NOT NULL REFERENCES games(id),
        next_game_id TEXT NOT NULL UNIQUE,
        game_number INTEGER NOT NULL CHECK (game_number > 1),
        player_white_address TEXT NOT NULL,
        player_black_address TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready')),
        available_at TIMESTAMPTZ NOT NULL,
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (match_id, completed_game_id),
        CHECK (
          (state = 'pending')
          OR (state = 'ready' AND lease_owner IS NULL AND lease_expires_at IS NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_match_continuations_claim
        ON backgammon_match_continuations(state, available_at, lease_expires_at)
        WHERE state = 'pending';
    `,
  },
  {
    version: 30,
    name: "owned_match_continuation_routing",
    sql: `
      ALTER TABLE backgammon_match_continuations
        ADD COLUMN IF NOT EXISTS owner_instance_id TEXT;
      ALTER TABLE backgammon_match_continuations
        ADD COLUMN IF NOT EXISTS owner_expires_at TIMESTAMPTZ;
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'backgammon_match_continuations_owner_pair'
             AND conrelid = 'backgammon_match_continuations'::regclass
        ) THEN
          ALTER TABLE backgammon_match_continuations
            ADD CONSTRAINT backgammon_match_continuations_owner_pair CHECK (
              (owner_instance_id IS NULL AND owner_expires_at IS NULL)
              OR (owner_instance_id IS NOT NULL AND owner_expires_at IS NOT NULL)
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'backgammon_match_continuations_ready_unowned'
             AND conrelid = 'backgammon_match_continuations'::regclass
        ) THEN
          ALTER TABLE backgammon_match_continuations
            ADD CONSTRAINT backgammon_match_continuations_ready_unowned CHECK (
              state = 'pending' OR (owner_instance_id IS NULL AND owner_expires_at IS NULL)
            );
        END IF;
      END
      $$;
      CREATE INDEX IF NOT EXISTS idx_match_continuations_participants
        ON backgammon_match_continuations(state, player_white_address, player_black_address, owner_expires_at)
        WHERE state = 'pending';
    `,
  },
  {
    version: 31,
    name: "unscored_match_game_recovery",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_backgammon_match_games_unscored
        ON backgammon_match_games(created_at, game_id)
        WHERE score_result IS NULL;
    `,
  },
  {
    version: 32,
    name: "provider_resource_authoritative_reconciliation",
    sql: `
      CREATE TABLE IF NOT EXISTS provider_resource_states (
        resource_type TEXT NOT NULL CHECK (resource_type IN ('account', 'address')),
        resource_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'complete', 'active', 'pending', 'documents_required', 'relink_required',
          'disabled', 'rejected', 'archived', 'stale'
        )),
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (resource_type, resource_id)
      );
      CREATE TABLE IF NOT EXISTS provider_resource_reconciliation_requests (
        resource_type TEXT NOT NULL CHECK (resource_type IN ('account', 'address')),
        resource_id TEXT NOT NULL,
        parent_account_id TEXT NOT NULL,
        attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 255),
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 100),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (resource_type, resource_id),
        CHECK (
          (lease_owner IS NULL AND lease_expires_at IS NULL)
          OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_provider_resource_reconciliation_claim
        ON provider_resource_reconciliation_requests(next_attempt_at, lease_expires_at);
      CREATE TABLE IF NOT EXISTS provider_transfer_reconciliation_requests (
        provider_transfer_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES money_operations(id),
        next_poll_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (
          (lease_owner IS NULL AND lease_expires_at IS NULL)
          OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_provider_transfer_reconciliation_claim
        ON provider_transfer_reconciliation_requests(next_poll_at, lease_expires_at);
      INSERT INTO provider_resource_states (resource_type, resource_id, status)
      SELECT 'account', provider_account_id, 'stale' FROM payment_profiles
      ON CONFLICT (resource_type, resource_id) DO NOTHING;
      INSERT INTO provider_resource_states (resource_type, resource_id, status)
      SELECT 'address', external_wallet_address_id, 'stale'
        FROM payment_profiles WHERE external_wallet_address_id IS NOT NULL
      ON CONFLICT (resource_type, resource_id) DO NOTHING;
      INSERT INTO provider_resource_states (resource_type, resource_id, status)
      SELECT 'address', internal_address_id, 'stale'
        FROM payment_profiles WHERE internal_address_id IS NOT NULL
      ON CONFLICT (resource_type, resource_id) DO NOTHING;
      INSERT INTO provider_resource_states (resource_type, resource_id, status)
      SELECT 'address', provider_address_id, 'stale' FROM payment_methods
      ON CONFLICT (resource_type, resource_id) DO NOTHING;
      UPDATE payment_profiles SET status = 'restricted'
       WHERE status = 'active';
    `,
  },
  {
    version: 33,
    name: "durable_active_game_principals",
    sql: `
      CREATE TABLE IF NOT EXISTS active_game_principals (
        principal TEXT PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS user_report_submission_windows (
        reporter TEXT PRIMARY KEY,
        window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        submitted_count SMALLINT NOT NULL DEFAULT 0 CHECK (submitted_count BETWEEN 0 AND 5),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_user_reports_open_duplicate
        ON user_reports(reporter, target, category)
        WHERE state IN ('open', 'investigating');
      ALTER TABLE matchmaking_queue
        ADD COLUMN IF NOT EXISTS joined_game_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS idx_active_game_principals_game
        ON active_game_principals(game_id);

      WITH ranked AS (
        SELECT g.id AS game_id,
               principal,
               ROW_NUMBER() OVER (
                 PARTITION BY principal
                 ORDER BY g.updated_at DESC, g.created_at DESC, g.id DESC
               ) AS position
          FROM games g
          CROSS JOIN LATERAL unnest(ARRAY[g.player_white, g.player_black]) AS participant(principal)
         WHERE g.status IN ('waiting', 'depositing', 'playing')
           AND principal IS NOT NULL
      ),
      superseded AS (
        SELECT DISTINCT game_id FROM ranked WHERE position > 1
      )
      UPDATE games
         SET status = 'abandoned', finished_at = COALESCE(finished_at, NOW()), updated_at = NOW()
       WHERE id IN (SELECT game_id FROM superseded);

      UPDATE games
         SET status = 'abandoned', finished_at = COALESCE(finished_at, NOW()), updated_at = NOW()
       WHERE status = 'waiting'
         AND player_white IS NOT NULL
         AND player_black IS NULL
         AND created_at <= NOW() - INTERVAL '15 minutes';

      INSERT INTO active_game_principals (principal, game_id)
      SELECT DISTINCT participant.principal, g.id
        FROM games g
        CROSS JOIN LATERAL unnest(ARRAY[g.player_white, g.player_black]) AS participant(principal)
       WHERE g.status IN ('waiting', 'depositing', 'playing')
         AND participant.principal IS NOT NULL
      ON CONFLICT (principal) DO NOTHING;
    `,
  },
  {
    version: 34,
    name: "support_payment_category",
    sql: `
      ALTER TABLE support_cases DROP CONSTRAINT IF EXISTS support_cases_category_check;
      ALTER TABLE support_cases
        ADD CONSTRAINT support_cases_category_check CHECK (category IN (
          'payment', 'missing_deposit', 'returned_payment', 'failed_cash_out',
          'incorrect_settlement', 'account_access', 'location_error', 'responsible_play'
        ));
    `,
  },
  {
    version: 35,
    name: "bounded_cash_out_intents",
    sql: `
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY principal, COALESCE(quote_snapshot->>'paymentMethodId', '')
                 ORDER BY created_at DESC, id DESC
               ) AS position
          FROM money_operations
         WHERE kind = 'cash_out' AND state = 'awaiting_user'
      )
      UPDATE money_operations operation
         SET state = 'review',
             failure_code = 'duplicate_legacy_cash_out_intent_requires_reconciliation',
             updated_at = NOW(),
             version = version + 1
        FROM ranked
       WHERE operation.id = ranked.id AND ranked.position > 1;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_money_operations_one_active_cash_out
        ON money_operations (principal, (COALESCE(quote_snapshot->>'paymentMethodId', '')))
        WHERE kind = 'cash_out' AND state = 'awaiting_user';
      CREATE INDEX IF NOT EXISTS idx_money_operations_cash_out_expiry
        ON money_operations (created_at, id)
        WHERE kind = 'cash_out' AND state = 'awaiting_user';
    `,
  },
  {
    version: 36,
    name: "durable_challenges_and_match_reservations",
    sql: `
      CREATE TABLE IF NOT EXISTS friend_challenges (
        id TEXT PRIMARY KEY,
        from_address TEXT NOT NULL,
        to_address TEXT NOT NULL,
        config JSONB NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'declined', 'expired')),
        game_id TEXT UNIQUE REFERENCES games(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        accepted_at TIMESTAMPTZ,
        CHECK (from_address <> to_address)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_challenges_pending_pair
        ON friend_challenges (from_address, to_address)
        WHERE state = 'pending';
      CREATE INDEX IF NOT EXISTS idx_friend_challenges_recipient
        ON friend_challenges (to_address, state, expires_at);
      CREATE INDEX IF NOT EXISTS idx_matchmaking_queue_stale_claim
        ON matchmaking_queue (state, claim_expires_at)
        WHERE state = 'matched' AND ready_at IS NULL;
    `,
  },
  {
    version: 37,
    name: "undirected_pending_friend_challenge_pair",
    sql: `
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY LEAST(from_address, to_address), GREATEST(from_address, to_address)
                 ORDER BY created_at, id
               ) AS ordinal
          FROM friend_challenges
         WHERE state = 'pending'
      )
      UPDATE friend_challenges challenge
         SET state = 'expired'
        FROM ranked
       WHERE challenge.id = ranked.id AND ranked.ordinal > 1;
      DROP INDEX IF EXISTS idx_friend_challenges_pending_pair;
      CREATE UNIQUE INDEX idx_friend_challenges_pending_pair
        ON friend_challenges (
          LEAST(from_address, to_address),
          GREATEST(from_address, to_address)
        )
        WHERE state = 'pending';
    `,
  },
  {
    version: 38,
    name: "expire_stale_undirected_friend_challenges",
    sql: `
      UPDATE friend_challenges
         SET state = 'expired'
       WHERE state = 'pending' AND expires_at <= NOW();
      WITH ranked_live_pairs AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY LEAST(from_address, to_address), GREATEST(from_address, to_address)
                 ORDER BY created_at, id
               ) AS ordinal
          FROM friend_challenges
         WHERE state = 'pending' AND expires_at > NOW()
      )
      UPDATE friend_challenges challenge
         SET state = 'expired'
        FROM ranked_live_pairs ranked
       WHERE challenge.id = ranked.id AND ranked.ordinal > 1;
    `,
  },
  {
    version: 39,
    name: "durable_match_continuation_deadline",
    sql: `
      ALTER TABLE backgammon_matches
        ADD COLUMN IF NOT EXISTS continuation_deadline_at TIMESTAMPTZ;
      ALTER TABLE backgammon_matches
        ADD COLUMN IF NOT EXISTS terminal_reason TEXT;
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'backgammon_matches_continuation_deadline_requires_playing'
             AND conrelid = 'backgammon_matches'::regclass
        ) THEN
          ALTER TABLE backgammon_matches
            ADD CONSTRAINT backgammon_matches_continuation_deadline_requires_playing
            CHECK (continuation_deadline_at IS NULL OR status = 'playing');
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'backgammon_matches_terminal_reason_requires_finished'
             AND conrelid = 'backgammon_matches'::regclass
        ) THEN
          ALTER TABLE backgammon_matches
            ADD CONSTRAINT backgammon_matches_terminal_reason_requires_finished
            CHECK (terminal_reason IS NULL OR status = 'finished');
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS idx_backgammon_matches_continuation_deadline
        ON backgammon_matches (continuation_deadline_at)
        WHERE status = 'playing' AND continuation_deadline_at IS NOT NULL;
    `,
  },
  {
    version: 40,
    name: "repair_legacy_terminal_reservations_and_continuations",
    sql: `
      UPDATE friend_challenges
         SET state = 'expired'
       WHERE state = 'pending' AND expires_at <= NOW();
      WITH recoverable AS (
        SELECT challenge.id,
               ROW_NUMBER() OVER (
                 PARTITION BY LEAST(challenge.from_address, challenge.to_address),
                              GREATEST(challenge.from_address, challenge.to_address)
                 ORDER BY challenge.created_at, challenge.id
               ) AS ordinal
          FROM friend_challenges challenge
         WHERE challenge.state = 'expired'
           AND challenge.expires_at > NOW()
           AND NOT EXISTS (
             SELECT 1
               FROM friend_challenges pending
              WHERE pending.state = 'pending'
                AND LEAST(pending.from_address, pending.to_address)
                    = LEAST(challenge.from_address, challenge.to_address)
                AND GREATEST(pending.from_address, pending.to_address)
                    = GREATEST(challenge.from_address, challenge.to_address)
           )
           AND EXISTS (
             SELECT 1
               FROM friend_challenges predecessor
              WHERE predecessor.state = 'expired'
                AND predecessor.expires_at <= NOW()
                AND LEAST(predecessor.from_address, predecessor.to_address)
                    = LEAST(challenge.from_address, challenge.to_address)
                AND GREATEST(predecessor.from_address, predecessor.to_address)
                    = GREATEST(challenge.from_address, challenge.to_address)
                AND (predecessor.created_at, predecessor.id) < (challenge.created_at, challenge.id)
                AND NOT EXISTS (
                  SELECT 1 FROM friend_challenges acted
                   WHERE acted.state IN ('accepted', 'declined')
                     AND acted.created_at >= predecessor.created_at
                     AND LEAST(acted.from_address, acted.to_address)
                         = LEAST(challenge.from_address, challenge.to_address)
                     AND GREATEST(acted.from_address, acted.to_address)
                         = GREATEST(challenge.from_address, challenge.to_address)
                )
           )
      )
      UPDATE friend_challenges challenge
         SET state = 'pending'
        FROM recoverable
       WHERE challenge.id = recoverable.id
         AND recoverable.ordinal = 1;
      UPDATE backgammon_matches match_record
         SET continuation_deadline_at = NOW() + INTERVAL '15 minutes',
             updated_at = NOW()
        FROM backgammon_match_continuations continuation
       WHERE continuation.match_id = match_record.id
         AND match_record.status = 'playing'
         AND match_record.current_game_id = continuation.next_game_id
         AND match_record.continuation_deadline_at IS NULL
         AND continuation.state IN ('pending', 'ready')
         AND EXISTS (
           SELECT 1 FROM games game
            WHERE game.id = continuation.next_game_id AND game.status = 'waiting'
         );
      DELETE FROM active_game_principals active
       USING games game
       WHERE active.game_id = game.id
         AND game.status IN ('finished', 'abandoned')
         AND NOT EXISTS (
           SELECT 1
             FROM backgammon_match_games match_game
             JOIN backgammon_matches match_record ON match_record.id = match_game.match_id
            WHERE match_game.game_id = game.id
              AND match_record.status = 'playing'
              AND match_record.current_game_id = game.id
         );
    `,
  },
];
export async function runMigrations(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (const migration of DATABASE_MIGRATIONS) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ name: string }>(
        "SELECT name FROM schema_migrations WHERE version = $1 FOR UPDATE",
        [migration.version],
      );
      if (existing.rowCount === 0) {
        await client.query(migration.sql);
        await migration.apply?.(client);
        await client.query(
          "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)",
          [migration.version, migration.name],
        );
      } else if (existing.rows[0].name !== migration.name) {
        throw new Error(`Migration ${migration.version} name mismatch`);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export const LATEST_DATABASE_VERSION = DATABASE_MIGRATIONS[DATABASE_MIGRATIONS.length - 1].version;
