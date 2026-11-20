use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{Addr, Uint128};

#[cw_serde]
pub struct InstantiateMsg {
    pub wager_denom: String,
    pub settlement_authority: String,
    pub rake_bps: u16,
    pub rake_recipient: String,
    pub min_stake_per_point: Uint128,
    pub max_stake_per_point: Uint128,
    pub funding_timeout_seconds: u64,
    pub cube_cap: u32,
    pub rules_version: String,
}

#[cw_serde]
pub enum ExecuteMsg {
    CreateGame {
        game_id: String,
        player_a: String,
        player_b: String,
        stake_per_point: Uint128,
        quote_hash: String,
    },
    DepositReserve {
        game_id: String,
    },
    ClaimFundingTimeout {
        game_id: String,
    },
    Settle {
        game_id: String,
        winner: String,
        result_multiplier: u32,
        cube_value: u32,
        cube_was_turned: bool,
        settlement_id: String,
    },
    RejectDouble {
        game_id: String,
        winner: String,
        pre_double_cube: u32,
        settlement_id: String,
    },
    Refund {
        game_id: String,
        refund_id: String,
        reason: String,
    },
    UpdateFutureConfig {
        paused: Option<bool>,
        rake_bps: Option<u16>,
        rake_recipient: Option<String>,
        min_stake_per_point: Option<Uint128>,
        max_stake_per_point: Option<Uint128>,
        funding_timeout_seconds: Option<u64>,
    },
}

#[cw_serde]
pub struct MigrateMsg {}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(ConfigResponse)]
    Config {},
    #[returns(GameResponse)]
    Game { game_id: String },
    #[returns(StatsResponse)]
    Stats {},
}

#[cw_serde]
pub struct ConfigResponse {
    pub admin: Addr,
    pub wager_denom: String,
    pub settlement_authority: Addr,
    pub rake_bps: u16,
    pub rake_recipient: Addr,
    pub min_stake_per_point: Uint128,
    pub max_stake_per_point: Uint128,
    pub funding_timeout_seconds: u64,
    pub cube_cap: u32,
    pub rules_version: String,
    pub paused: bool,
}

#[cw_serde]
pub struct GameResponse {
    pub game_id: String,
    pub player_a: Addr,
    pub player_b: Addr,
    pub stake_per_point: Uint128,
    pub reserve_per_player: Uint128,
    pub player_a_deposited: bool,
    pub player_b_deposited: bool,
    pub quote_hash: String,
    pub wager_denom: String,
    pub rake_bps: u16,
    pub rake_recipient: Addr,
    pub cube_cap: u32,
    pub rules_version: String,
    pub status: GameStatusResponse,
    pub created_at: u64,
    pub funding_deadline: u64,
    pub created_height: u64,
    pub receipt: Option<SettlementReceiptResponse>,
}

#[cw_serde]
pub enum GameStatusResponse {
    AwaitingReserves,
    Active,
    Settled,
    Refunded,
}

#[cw_serde]
pub struct SettlementReceiptResponse {
    pub terminal_id: String,
    pub winner: Option<Addr>,
    pub cube_value: Option<u32>,
    pub result_multiplier: Option<u32>,
    pub liability: Uint128,
    pub rake: Uint128,
    pub winner_payout: Uint128,
    pub loser_payout: Uint128,
    pub reason: Option<String>,
    pub settled_at: u64,
    pub terminal_height: u64,
}

#[cw_serde]
pub struct StatsResponse {
    pub total_games_created: u64,
    pub total_games_settled: u64,
    pub total_rake_collected: Uint128,
    pub total_obligations: Uint128,
}
