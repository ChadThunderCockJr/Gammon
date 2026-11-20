use cosmwasm_std::{
    entry_point, to_json_binary, BankMsg, Binary, Coin, Deps, DepsMut, Env, MessageInfo, Response,
    StdError, StdResult, Uint128,
};
use cw2::{get_contract_version, set_contract_version};

use crate::error::ContractError;
use crate::msg::{
    ConfigResponse, ExecuteMsg, GameResponse, GameStatusResponse, InstantiateMsg, MigrateMsg,
    QueryMsg, SettlementReceiptResponse, StatsResponse,
};
use crate::state::{
    Config, Game, GameStatus, SettlementReceipt, CONFIG, GAMES, TOTAL_GAMES_CREATED,
    TOTAL_GAMES_SETTLED, TOTAL_OBLIGATIONS, TOTAL_RAKE_COLLECTED,
};

const CONTRACT_NAME: &str = "crates.io:wager-escrow";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_RAKE_BPS: u16 = 10_000;
const MAX_ID_LENGTH: usize = 128;
const MAX_REASON_LENGTH: usize = 200;

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn validate_config(config: &Config) -> Result<(), ContractError> {
    if config.wager_denom.trim().is_empty() {
        return Err(ContractError::InvalidConfig {
            reason: "empty wager denom".into(),
        });
    }
    if config.admin == config.settlement_authority {
        return Err(ContractError::InvalidConfig {
            reason: "admin and settlement authority must be distinct".into(),
        });
    }
    if config.rake_bps > MAX_RAKE_BPS {
        return Err(ContractError::InvalidConfig {
            reason: "rake exceeds 100%".into(),
        });
    }
    if config.min_stake_per_point.is_zero()
        || config.min_stake_per_point > config.max_stake_per_point
    {
        return Err(ContractError::InvalidConfig {
            reason: "invalid stake bounds".into(),
        });
    }
    if config.funding_timeout_seconds == 0 {
        return Err(ContractError::InvalidConfig {
            reason: "funding timeout must be positive".into(),
        });
    }
    if config.cube_cap == 0 || !config.cube_cap.is_power_of_two() || config.cube_cap > 64 {
        return Err(ContractError::InvalidConfig {
            reason: "cube cap must be a power of two up to 64".into(),
        });
    }
    if config.rules_version.trim().is_empty() || config.rules_version.len() > 64 {
        return Err(ContractError::InvalidConfig {
            reason: "invalid rules version".into(),
        });
    }
    Ok(())
}

fn no_funds(info: &MessageInfo) -> Result<(), ContractError> {
    if info.funds.is_empty() {
        Ok(())
    } else {
        Err(ContractError::UnexpectedFunds)
    }
}

fn ensure_authority(config: &Config, info: &MessageInfo) -> Result<(), ContractError> {
    if info.sender == config.settlement_authority {
        Ok(())
    } else {
        Err(ContractError::Unauthorized)
    }
}

fn exact_reserve(info: &MessageInfo, denom: &str, expected: Uint128) -> Result<(), ContractError> {
    if info.funds.len() == 1 && info.funds[0].denom == denom && info.funds[0].amount == expected {
        Ok(())
    } else {
        Err(ContractError::InvalidReserve {
            expected,
            denom: denom.to_owned(),
        })
    }
}

fn increment(
    item: &cw_storage_plus::Item<u64>,
    storage: &mut dyn cosmwasm_std::Storage,
) -> StdResult<()> {
    item.update(storage, |value| {
        value
            .checked_add(1)
            .ok_or_else(|| StdError::generic_err("counter overflow"))
    })?;
    Ok(())
}

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    no_funds(&info)?;
    let config = Config {
        admin: info.sender,
        wager_denom: msg.wager_denom,
        settlement_authority: deps.api.addr_validate(&msg.settlement_authority)?,
        rake_bps: msg.rake_bps,
        rake_recipient: deps.api.addr_validate(&msg.rake_recipient)?,
        min_stake_per_point: msg.min_stake_per_point,
        max_stake_per_point: msg.max_stake_per_point,
        funding_timeout_seconds: msg.funding_timeout_seconds,
        cube_cap: msg.cube_cap,
        rules_version: msg.rules_version,
        paused: false,
    };
    validate_config(&config)?;
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;
    CONFIG.save(deps.storage, &config)?;
    TOTAL_GAMES_CREATED.save(deps.storage, &0)?;
    TOTAL_GAMES_SETTLED.save(deps.storage, &0)?;
    TOTAL_RAKE_COLLECTED.save(deps.storage, &Uint128::zero())?;
    TOTAL_OBLIGATIONS.save(deps.storage, &Uint128::zero())?;
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
        ExecuteMsg::CreateGame {
            game_id,
            player_a,
            player_b,
            stake_per_point,
            quote_hash,
        } => execute_create_game(
            deps,
            env,
            info,
            game_id,
            player_a,
            player_b,
            stake_per_point,
            quote_hash,
        ),
        ExecuteMsg::DepositReserve { game_id } => execute_deposit(deps, env, info, game_id),
        ExecuteMsg::ClaimFundingTimeout { game_id } => execute_timeout(deps, env, info, game_id),
        ExecuteMsg::Settle {
            game_id,
            winner,
            result_multiplier,
            cube_value,
            cube_was_turned,
            settlement_id,
        } => execute_settle(
            deps,
            env,
            info,
            game_id,
            winner,
            result_multiplier,
            cube_value,
            cube_was_turned,
            settlement_id,
        ),
        ExecuteMsg::RejectDouble {
            game_id,
            winner,
            pre_double_cube,
            settlement_id,
        } => execute_settle(
            deps,
            env,
            info,
            game_id,
            winner,
            1,
            pre_double_cube,
            true,
            settlement_id,
        ),
        ExecuteMsg::Refund {
            game_id,
            refund_id,
            reason,
        } => execute_refund(deps, env, info, game_id, refund_id, reason),
        ExecuteMsg::UpdateFutureConfig {
            paused,
            rake_bps,
            rake_recipient,
            min_stake_per_point,
            max_stake_per_point,
            funding_timeout_seconds,
        } => execute_update_config(
            deps,
            info,
            paused,
            rake_bps,
            rake_recipient,
            min_stake_per_point,
            max_stake_per_point,
            funding_timeout_seconds,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn execute_create_game(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: String,
    player_a: String,
    player_b: String,
    stake_per_point: Uint128,
    quote_hash: String,
) -> Result<Response, ContractError> {
    no_funds(&info)?;
    let config = CONFIG.load(deps.storage)?;
    ensure_authority(&config, &info)?;
    if config.paused {
        return Err(ContractError::Paused);
    }
    if !valid_id(&game_id)
        || quote_hash.len() != 64
        || !quote_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(ContractError::InvalidIdentifier);
    }
    if GAMES.may_load(deps.storage, &game_id)?.is_some() {
        return Err(ContractError::GameAlreadyExists);
    }
    if stake_per_point < config.min_stake_per_point || stake_per_point > config.max_stake_per_point
    {
        return Err(ContractError::InvalidStake {
            amount: stake_per_point,
            minimum: config.min_stake_per_point,
            maximum: config.max_stake_per_point,
        });
    }
    let player_a = deps.api.addr_validate(&player_a)?;
    let player_b = deps.api.addr_validate(&player_b)?;
    if player_a == player_b {
        return Err(ContractError::SamePlayer);
    }
    let reserve_per_player = stake_per_point
        .checked_mul(Uint128::from(config.cube_cap as u128))?
        .checked_mul(Uint128::new(3))?;
    let funding_deadline = env
        .block
        .time
        .seconds()
        .checked_add(config.funding_timeout_seconds)
        .ok_or_else(|| StdError::generic_err("deadline overflow"))?;
    let game = Game {
        game_id: game_id.clone(),
        player_a,
        player_b,
        stake_per_point,
        reserve_per_player,
        player_a_deposited: false,
        player_b_deposited: false,
        quote_hash: quote_hash.to_ascii_lowercase(),
        wager_denom: config.wager_denom,
        rake_bps: config.rake_bps,
        rake_recipient: config.rake_recipient,
        cube_cap: config.cube_cap,
        rules_version: config.rules_version,
        status: GameStatus::AwaitingReserves,
        created_at: env.block.time.seconds(),
        created_height: env.block.height,
        funding_deadline,
        receipt: None,
    };
    GAMES.save(deps.storage, &game_id, &game)?;
    increment(&TOTAL_GAMES_CREATED, deps.storage)?;
    Ok(Response::new()
        .add_attribute("action", "create_game")
        .add_attribute("game_id", game_id)
        .add_attribute("reserve_per_player", reserve_per_player))
}

fn execute_deposit(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: String,
) -> Result<Response, ContractError> {
    let mut game = GAMES
        .may_load(deps.storage, &game_id)?
        .ok_or(ContractError::GameNotFound)?;
    if game.status != GameStatus::AwaitingReserves {
        return Err(ContractError::InvalidState);
    }
    if env.block.time.seconds() >= game.funding_deadline {
        return Err(ContractError::InvalidState);
    }
    exact_reserve(&info, &game.wager_denom, game.reserve_per_player)?;
    if info.sender == game.player_a {
        if game.player_a_deposited {
            return Err(ContractError::AlreadyDeposited);
        }
        game.player_a_deposited = true;
    } else if info.sender == game.player_b {
        if game.player_b_deposited {
            return Err(ContractError::AlreadyDeposited);
        }
        game.player_b_deposited = true;
    } else {
        return Err(ContractError::NotAPlayer);
    }
    if game.player_a_deposited && game.player_b_deposited {
        game.status = GameStatus::Active;
    }
    GAMES.save(deps.storage, &game_id, &game)?;
    TOTAL_OBLIGATIONS.update(deps.storage, |value| {
        value
            .checked_add(game.reserve_per_player)
            .map_err(StdError::overflow)
    })?;
    Ok(Response::new()
        .add_attribute("action", "deposit_reserve")
        .add_attribute("game_id", game_id)
        .add_attribute("active", (game.status == GameStatus::Active).to_string()))
}

fn terminal_refund(
    deps: DepsMut,
    env: Env,
    mut game: Game,
    terminal_id: String,
    reason: String,
) -> Result<Response, ContractError> {
    if game.status == GameStatus::Refunded {
        let receipt = game
            .receipt
            .as_ref()
            .ok_or(ContractError::TerminalConflict)?;
        if receipt.terminal_id == terminal_id && receipt.reason.as_deref() == Some(reason.as_str())
        {
            return Ok(Response::new()
                .add_attribute("action", "refund")
                .add_attribute("idempotent", "true"));
        }
        return Err(ContractError::TerminalConflict);
    }
    if game.status == GameStatus::Settled {
        return Err(ContractError::InvalidState);
    }
    let mut messages: Vec<BankMsg> = Vec::new();
    let player_a_refund = if game.player_a_deposited {
        messages.push(BankMsg::Send {
            to_address: game.player_a.to_string(),
            amount: vec![Coin::new(
                game.reserve_per_player.u128(),
                game.wager_denom.clone(),
            )],
        });
        game.reserve_per_player
    } else {
        Uint128::zero()
    };
    let player_b_refund = if game.player_b_deposited {
        messages.push(BankMsg::Send {
            to_address: game.player_b.to_string(),
            amount: vec![Coin::new(
                game.reserve_per_player.u128(),
                game.wager_denom.clone(),
            )],
        });
        game.reserve_per_player
    } else {
        Uint128::zero()
    };
    let refunded = player_a_refund.checked_add(player_b_refund)?;
    game.status = GameStatus::Refunded;
    game.receipt = Some(SettlementReceipt {
        terminal_id: terminal_id.clone(),
        winner: None,
        cube_value: None,
        result_multiplier: None,
        liability: Uint128::zero(),
        rake: Uint128::zero(),
        winner_payout: player_a_refund,
        loser_payout: player_b_refund,
        reason: Some(reason.clone()),
        settled_at: env.block.time.seconds(),
        terminal_height: env.block.height,
    });
    GAMES.save(deps.storage, &game.game_id, &game)?;
    TOTAL_OBLIGATIONS.update(deps.storage, |value| {
        value.checked_sub(refunded).map_err(StdError::overflow)
    })?;
    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "refund")
        .add_attribute("game_id", game.game_id)
        .add_attribute("terminal_id", terminal_id)
        .add_attribute("reason", reason))
}

fn execute_timeout(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: String,
) -> Result<Response, ContractError> {
    no_funds(&info)?;
    let game = GAMES
        .may_load(deps.storage, &game_id)?
        .ok_or(ContractError::GameNotFound)?;
    if info.sender != game.player_a && info.sender != game.player_b {
        return Err(ContractError::NotAPlayer);
    }
    if game.status != GameStatus::AwaitingReserves {
        return Err(ContractError::AlreadyFunded);
    }
    if env.block.time.seconds() < game.funding_deadline {
        return Err(ContractError::FundingDeadlineNotReached);
    }
    terminal_refund(
        deps,
        env,
        game,
        "funding-timeout".into(),
        "funding_timeout".into(),
    )
}

#[allow(clippy::too_many_arguments)]
fn execute_settle(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: String,
    winner: String,
    result_multiplier: u32,
    cube_value: u32,
    cube_was_turned: bool,
    settlement_id: String,
) -> Result<Response, ContractError> {
    no_funds(&info)?;
    let config = CONFIG.load(deps.storage)?;
    ensure_authority(&config, &info)?;
    if !valid_id(&settlement_id) {
        return Err(ContractError::InvalidIdentifier);
    }
    let mut game = GAMES
        .may_load(deps.storage, &game_id)?
        .ok_or(ContractError::GameNotFound)?;
    let winner = deps.api.addr_validate(&winner)?;
    let effective_multiplier = if cube_was_turned {
        result_multiplier
    } else {
        1
    };
    if !matches!(effective_multiplier, 1..=3) {
        return Err(ContractError::InvalidMultiplier);
    }
    if cube_value == 0 || !cube_value.is_power_of_two() || cube_value > game.cube_cap {
        return Err(ContractError::InvalidCubeValue);
    }
    if winner != game.player_a && winner != game.player_b {
        return Err(ContractError::InvalidWinner);
    }
    if game.status == GameStatus::Settled {
        let receipt = game
            .receipt
            .as_ref()
            .ok_or(ContractError::TerminalConflict)?;
        if receipt.terminal_id == settlement_id
            && receipt.winner.as_ref() == Some(&winner)
            && receipt.cube_value == Some(cube_value)
            && receipt.result_multiplier == Some(effective_multiplier)
        {
            return Ok(Response::new()
                .add_attribute("action", "settle")
                .add_attribute("idempotent", "true"));
        }
        return Err(ContractError::TerminalConflict);
    }
    if game.status != GameStatus::Active {
        return Err(ContractError::InvalidState);
    }
    let liability = game
        .stake_per_point
        .checked_mul(Uint128::from(cube_value as u128))?
        .checked_mul(Uint128::from(effective_multiplier as u128))?;
    if liability > game.reserve_per_player {
        return Err(ContractError::InvalidMultiplier);
    }
    let rake = liability.multiply_ratio(game.rake_bps as u128, 10_000u128);
    let winner_payout = game
        .reserve_per_player
        .checked_add(liability)?
        .checked_sub(rake)?;
    let loser_payout = game.reserve_per_player.checked_sub(liability)?;
    let loser = if winner == game.player_a {
        game.player_b.clone()
    } else {
        game.player_a.clone()
    };
    let mut messages = vec![BankMsg::Send {
        to_address: winner.to_string(),
        amount: vec![Coin::new(winner_payout.u128(), game.wager_denom.clone())],
    }];
    if !loser_payout.is_zero() {
        messages.push(BankMsg::Send {
            to_address: loser.to_string(),
            amount: vec![Coin::new(loser_payout.u128(), game.wager_denom.clone())],
        });
    }
    if !rake.is_zero() {
        messages.push(BankMsg::Send {
            to_address: game.rake_recipient.to_string(),
            amount: vec![Coin::new(rake.u128(), game.wager_denom.clone())],
        });
    }
    game.status = GameStatus::Settled;
    game.receipt = Some(SettlementReceipt {
        terminal_id: settlement_id.clone(),
        winner: Some(winner),
        cube_value: Some(cube_value),
        result_multiplier: Some(effective_multiplier),
        liability,
        rake,
        winner_payout,
        loser_payout,
        reason: None,
        settled_at: env.block.time.seconds(),
        terminal_height: env.block.height,
    });
    GAMES.save(deps.storage, &game_id, &game)?;
    let total_reserve = game.reserve_per_player.checked_mul(Uint128::new(2))?;
    TOTAL_OBLIGATIONS.update(deps.storage, |value| {
        value.checked_sub(total_reserve).map_err(StdError::overflow)
    })?;
    TOTAL_RAKE_COLLECTED.update(deps.storage, |value| {
        value.checked_add(rake).map_err(StdError::overflow)
    })?;
    increment(&TOTAL_GAMES_SETTLED, deps.storage)?;
    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "settle")
        .add_attribute("game_id", game_id)
        .add_attribute("settlement_id", settlement_id)
        .add_attribute("liability", liability)
        .add_attribute("rake", rake))
}

fn execute_refund(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: String,
    refund_id: String,
    reason: String,
) -> Result<Response, ContractError> {
    no_funds(&info)?;
    let config = CONFIG.load(deps.storage)?;
    ensure_authority(&config, &info)?;
    if !valid_id(&refund_id) {
        return Err(ContractError::InvalidIdentifier);
    }
    if reason.is_empty() || reason.len() > MAX_REASON_LENGTH {
        return Err(ContractError::InvalidRefundReason);
    }
    let game = GAMES
        .may_load(deps.storage, &game_id)?
        .ok_or(ContractError::GameNotFound)?;
    terminal_refund(deps, env, game, refund_id, reason)
}

#[allow(clippy::too_many_arguments)]
fn execute_update_config(
    deps: DepsMut,
    info: MessageInfo,
    paused: Option<bool>,
    rake_bps: Option<u16>,
    rake_recipient: Option<String>,
    min_stake_per_point: Option<Uint128>,
    max_stake_per_point: Option<Uint128>,
    funding_timeout_seconds: Option<u64>,
) -> Result<Response, ContractError> {
    no_funds(&info)?;
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin {
        return Err(ContractError::Unauthorized);
    }
    if let Some(value) = paused {
        config.paused = value;
    }
    if let Some(value) = rake_bps {
        config.rake_bps = value;
    }
    if let Some(value) = rake_recipient {
        config.rake_recipient = deps.api.addr_validate(&value)?;
    }
    if let Some(value) = min_stake_per_point {
        config.min_stake_per_point = value;
    }
    if let Some(value) = max_stake_per_point {
        config.max_stake_per_point = value;
    }
    if let Some(value) = funding_timeout_seconds {
        config.funding_timeout_seconds = value;
    }
    validate_config(&config)?;
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new().add_attribute("action", "update_future_config"))
}

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_json_binary(&query_config(deps)?),
        QueryMsg::Game { game_id } => to_json_binary(&query_game(deps, game_id)?),
        QueryMsg::Stats {} => to_json_binary(&query_stats(deps)?),
    }
}

fn query_config(deps: Deps) -> StdResult<ConfigResponse> {
    let config = CONFIG.load(deps.storage)?;
    Ok(ConfigResponse {
        admin: config.admin,
        wager_denom: config.wager_denom,
        settlement_authority: config.settlement_authority,
        rake_bps: config.rake_bps,
        rake_recipient: config.rake_recipient,
        min_stake_per_point: config.min_stake_per_point,
        max_stake_per_point: config.max_stake_per_point,
        funding_timeout_seconds: config.funding_timeout_seconds,
        cube_cap: config.cube_cap,
        rules_version: config.rules_version,
        paused: config.paused,
    })
}

fn status_response(status: GameStatus) -> GameStatusResponse {
    match status {
        GameStatus::AwaitingReserves => GameStatusResponse::AwaitingReserves,
        GameStatus::Active => GameStatusResponse::Active,
        GameStatus::Settled => GameStatusResponse::Settled,
        GameStatus::Refunded => GameStatusResponse::Refunded,
    }
}

fn receipt_response(receipt: SettlementReceipt) -> SettlementReceiptResponse {
    SettlementReceiptResponse {
        terminal_id: receipt.terminal_id,
        winner: receipt.winner,
        cube_value: receipt.cube_value,
        result_multiplier: receipt.result_multiplier,
        liability: receipt.liability,
        rake: receipt.rake,
        winner_payout: receipt.winner_payout,
        loser_payout: receipt.loser_payout,
        reason: receipt.reason,
        settled_at: receipt.settled_at,
        terminal_height: receipt.terminal_height,
    }
}

fn query_game(deps: Deps, game_id: String) -> StdResult<GameResponse> {
    let game = GAMES.load(deps.storage, &game_id)?;
    Ok(GameResponse {
        game_id: game.game_id,
        player_a: game.player_a,
        player_b: game.player_b,
        stake_per_point: game.stake_per_point,
        reserve_per_player: game.reserve_per_player,
        player_a_deposited: game.player_a_deposited,
        player_b_deposited: game.player_b_deposited,
        quote_hash: game.quote_hash,
        wager_denom: game.wager_denom,
        rake_bps: game.rake_bps,
        rake_recipient: game.rake_recipient,
        cube_cap: game.cube_cap,
        rules_version: game.rules_version,
        status: status_response(game.status),
        created_at: game.created_at,
        funding_deadline: game.funding_deadline,
        created_height: game.created_height,
        receipt: game.receipt.map(receipt_response),
    })
}

fn query_stats(deps: Deps) -> StdResult<StatsResponse> {
    Ok(StatsResponse {
        total_games_created: TOTAL_GAMES_CREATED.load(deps.storage)?,
        total_games_settled: TOTAL_GAMES_SETTLED.load(deps.storage)?,
        total_rake_collected: TOTAL_RAKE_COLLECTED.load(deps.storage)?,
        total_obligations: TOTAL_OBLIGATIONS.load(deps.storage)?,
    })
}

#[entry_point]
pub fn migrate(deps: DepsMut, _env: Env, _msg: MigrateMsg) -> Result<Response, ContractError> {
    let prior = get_contract_version(deps.storage)?;
    if prior.contract != CONTRACT_NAME {
        return Err(ContractError::InvalidConfig {
            reason: "wrong migration source".into(),
        });
    }
    CONFIG.load(deps.storage)?;
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;
    Ok(Response::new().add_attribute("action", "migrate"))
}
