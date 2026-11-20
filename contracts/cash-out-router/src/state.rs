use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, Binary, Uint128};
use cw_storage_plus::{Item, Map};

#[cw_serde]
pub struct Config {
    pub admin: Addr,
    pub denom: String,
    pub max_transfer: Uint128,
    pub authorization_public_key: Binary,
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const PROCESSED: Map<&str, Addr> = Map::new("processed");
