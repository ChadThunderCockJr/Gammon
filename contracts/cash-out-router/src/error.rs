use cosmwasm_std::{StdError, Uint128, VerificationError};
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("{0}")]
    Verification(#[from] VerificationError),

    #[error("invalid configuration: {reason}")]
    InvalidConfig { reason: String },

    #[error("invalid cash-out operation id")]
    InvalidOperationId,

    #[error("cash-out operation already processed")]
    DuplicateOperation,

    #[error("cash-out authorization is invalid or expired")]
    Unauthorized,

    #[error("expected one positive {denom} transfer no greater than {maximum}")]
    InvalidFunds { denom: String, maximum: Uint128 },
}
