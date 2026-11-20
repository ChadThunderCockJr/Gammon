use cosmwasm_std::{OverflowError, StdError, Uint128};
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("{0}")]
    Overflow(#[from] OverflowError),

    #[error("unauthorized")]
    Unauthorized,

    #[error("new wagers are paused")]
    Paused,

    #[error("invalid configuration: {reason}")]
    InvalidConfig { reason: String },

    #[error("invalid identifier")]
    InvalidIdentifier,

    #[error("game already exists")]
    GameAlreadyExists,

    #[error("game not found")]
    GameNotFound,

    #[error("players must be distinct")]
    SamePlayer,

    #[error("stake {amount} is outside [{minimum}, {maximum}]")]
    InvalidStake {
        amount: Uint128,
        minimum: Uint128,
        maximum: Uint128,
    },

    #[error("unexpected funds")]
    UnexpectedFunds,

    #[error("invalid reserve payment: expected {expected} {denom}")]
    InvalidReserve { expected: Uint128, denom: String },

    #[error("sender is not a player")]
    NotAPlayer,

    #[error("reserve already deposited")]
    AlreadyDeposited,

    #[error("invalid game state")]
    InvalidState,

    #[error("funding deadline has not passed")]
    FundingDeadlineNotReached,

    #[error("both reserves are already funded")]
    AlreadyFunded,

    #[error("winner must be a player")]
    InvalidWinner,

    #[error("invalid result multiplier")]
    InvalidMultiplier,

    #[error("invalid cube value")]
    InvalidCubeValue,

    #[error("terminal command conflicts with the existing receipt")]
    TerminalConflict,

    #[error("refund reason is invalid")]
    InvalidRefundReason,
}
