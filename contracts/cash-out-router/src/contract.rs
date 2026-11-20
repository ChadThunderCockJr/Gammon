use cosmwasm_std::{
    entry_point, to_json_binary, BankMsg, Binary, Deps, DepsMut, Env, MessageInfo, Response,
    StdResult,
};
use cw2::set_contract_version;
use sha2::{Digest, Sha256};

use crate::error::ContractError;
use crate::msg::{ConfigResponse, ExecuteMsg, InstantiateMsg, ProcessedResponse, QueryMsg};
use crate::state::{Config, CONFIG, PROCESSED};

const CONTRACT_NAME: &str = "crates.io:cash-out-router";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_AUTHORIZATION_WINDOW_SECONDS: u64 = 900;

fn valid_operation_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn authorization_digest(
    env: &Env,
    sender: &str,
    operation_id: &str,
    destination: &str,
    denom: &str,
    amount: &str,
    expires_at: u64,
) -> [u8; 32] {
    let payload = format!(
        "gammon.cash-out.v1|{}|{}|{}|{}|{}|{}|{}|{}",
        env.block.chain_id,
        env.contract.address,
        sender,
        operation_id,
        destination,
        denom,
        amount,
        expires_at,
    );
    Sha256::digest(payload.as_bytes()).into()
}

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    if !info.funds.is_empty() {
        return Err(ContractError::InvalidConfig {
            reason: "instantiate cannot receive funds".into(),
        });
    }
    if msg.denom.trim().is_empty() || msg.denom.contains('|') || msg.max_transfer.is_zero() {
        return Err(ContractError::InvalidConfig {
            reason: "denom and max transfer must be positive".into(),
        });
    }
    if !matches!(msg.authorization_public_key.len(), 33 | 65) {
        return Err(ContractError::InvalidConfig {
            reason: "authorization public key must be compressed or uncompressed secp256k1".into(),
        });
    }
    let config = Config {
        admin: info.sender,
        denom: msg.denom,
        max_transfer: msg.max_transfer,
        authorization_public_key: msg.authorization_public_key,
    };
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new().add_attribute("action", "instantiate"))
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::AuthorizeFinanceAction {
            operation_id,
            destination,
            expires_at,
            signature,
        } => execute_cash_out(
            deps,
            env,
            info,
            operation_id,
            destination,
            expires_at,
            signature,
        ),
    }
}

fn execute_cash_out(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    operation_id: String,
    destination: String,
    expires_at: u64,
    signature: Binary,
) -> Result<Response, ContractError> {
    if !valid_operation_id(&operation_id) || destination.contains('|') {
        return Err(ContractError::InvalidOperationId);
    }
    if PROCESSED.has(deps.storage, &operation_id) {
        return Err(ContractError::DuplicateOperation);
    }
    let config = CONFIG.load(deps.storage)?;
    if info.funds.len() != 1
        || info.funds[0].denom != config.denom
        || info.funds[0].amount.is_zero()
        || info.funds[0].amount > config.max_transfer
    {
        return Err(ContractError::InvalidFunds {
            denom: config.denom,
            maximum: config.max_transfer,
        });
    }
    let destination = deps.api.addr_validate(&destination)?;
    if expires_at < env.block.time.seconds()
        || expires_at
            > env
                .block
                .time
                .seconds()
                .saturating_add(MAX_AUTHORIZATION_WINDOW_SECONDS)
        || signature.len() != 64
    {
        return Err(ContractError::Unauthorized);
    }
    let amount = info.funds[0].clone();
    let digest = authorization_digest(
        &env,
        info.sender.as_str(),
        &operation_id,
        destination.as_str(),
        &amount.denom,
        &amount.amount.to_string(),
        expires_at,
    );
    if !deps.api.secp256k1_verify(
        &digest,
        signature.as_slice(),
        config.authorization_public_key.as_slice(),
    )? {
        return Err(ContractError::Unauthorized);
    }
    PROCESSED.save(deps.storage, &operation_id, &info.sender)?;
    Ok(Response::new()
        .add_message(BankMsg::Send {
            to_address: destination.to_string(),
            amount: vec![amount.clone()],
        })
        .add_attribute("action", "authorize_finance_action")
        .add_attribute("operation_id", operation_id)
        .add_attribute("principal", info.sender)
        .add_attribute("destination", destination)
        .add_attribute("amount", amount.amount)
        .add_attribute("denom", amount.denom))
}

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => {
            let config = CONFIG.load(deps.storage)?;
            to_json_binary(&ConfigResponse {
                admin: config.admin,
                denom: config.denom,
                max_transfer: config.max_transfer,
                authorization_public_key: config.authorization_public_key,
            })
        }
        QueryMsg::Processed { operation_id } => to_json_binary(&ProcessedResponse {
            sender: PROCESSED.may_load(deps.storage, &operation_id)?,
            operation_id,
        }),
    }
}
