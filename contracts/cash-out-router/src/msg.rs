use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{Addr, Binary, Uint128};

#[cw_serde]
pub struct InstantiateMsg {
    pub denom: String,
    pub max_transfer: Uint128,
    pub authorization_public_key: Binary,
}

#[cw_serde]
pub enum ExecuteMsg {
    AuthorizeFinanceAction {
        operation_id: String,
        destination: String,
        expires_at: u64,
        signature: Binary,
    },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(ConfigResponse)]
    Config {},
    #[returns(ProcessedResponse)]
    Processed { operation_id: String },
}

#[cw_serde]
pub struct ConfigResponse {
    pub admin: Addr,
    pub denom: String,
    pub max_transfer: Uint128,
    pub authorization_public_key: Binary,
}

#[cw_serde]
pub struct ProcessedResponse {
    pub operation_id: String,
    pub sender: Option<Addr>,
}
