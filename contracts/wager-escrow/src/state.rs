use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, Uint128};
use cw_storage_plus::{Item, Map};

#[cw_serde]
pub struct Config {
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
pub struct Game {
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
    pub status: GameStatus,
    pub created_at: u64,
    #[serde(default)]
    pub created_height: u64,
    pub funding_deadline: u64,
    pub receipt: Option<SettlementReceipt>,
}

#[cw_serde]
pub enum GameStatus {
    AwaitingReserves,
    Active,
    Settled,
    Refunded,
}

#[cw_serde]
pub struct SettlementReceipt {
    pub terminal_id: String,
    pub winner: Option<Addr>,
    pub cube_value: Option<u32>,
    pub result_multiplier: Option<u32>,
    pub liability: Uint128,
    pub rake: Uint128,
    pub winner_payout: Uint128,
    pub loser_payout: Uint128,
    pub reason: Option<String>,
    #[serde(default)]
    pub terminal_height: u64,
    pub settled_at: u64,
}

pub const CONFIG: Item<Config> = Item::new("config_v2");
pub const GAMES: Map<&str, Game> = Map::new("games_v2");
pub const TOTAL_GAMES_CREATED: Item<u64> = Item::new("total_created_v2");
pub const TOTAL_GAMES_SETTLED: Item<u64> = Item::new("total_settled_v2");
pub const TOTAL_RAKE_COLLECTED: Item<Uint128> = Item::new("total_rake_v2");
pub const TOTAL_OBLIGATIONS: Item<Uint128> = Item::new("total_obligations_v2");
