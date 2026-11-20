use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info, MockApi};
use cosmwasm_std::{coin, from_json, Addr, BankMsg, CosmosMsg, DepsMut, Empty, Uint128};
use cw_multi_test::{App, Contract, ContractWrapper, Executor};

use crate::contract::{execute, instantiate, query};
use crate::error::ContractError;
use crate::msg::{ExecuteMsg, GameResponse, InstantiateMsg, QueryMsg};

fn address(label: &str) -> String {
    MockApi::default().addr_make(label).to_string()
}

fn instantiate_contract(mut deps: DepsMut) {
    instantiate(
        deps.branch(),
        mock_env(),
        mock_info(&address("admin"), &[]),
        InstantiateMsg {
            wager_denom: "factory/xion1issuer/verusd".into(),
            settlement_authority: address("authority"),
            rake_bps: 250,
            rake_recipient: address("treasury"),
            min_stake_per_point: Uint128::new(1),
            max_stake_per_point: Uint128::new(1_000_000_000),
            funding_timeout_seconds: 300,
            cube_cap: 8,
            rules_version: "cash-v1".into(),
        },
    )
    .unwrap();
}

fn create_and_fund(mut deps: DepsMut, game_id: &str, stake: u128) {
    execute(
        deps.branch(),
        mock_env(),
        mock_info(&address("authority"), &[]),
        ExecuteMsg::CreateGame {
            game_id: game_id.into(),
            player_a: address("player-a"),
            player_b: address("player-b"),
            stake_per_point: Uint128::new(stake),
            quote_hash: "a".repeat(64),
        },
    )
    .unwrap();
    let reserve = stake * 8 * 3;
    execute(
        deps.branch(),
        mock_env(),
        mock_info(
            &address("player-a"),
            &[coin(reserve, "factory/xion1issuer/verusd")],
        ),
        ExecuteMsg::DepositReserve {
            game_id: game_id.into(),
        },
    )
    .unwrap();
    execute(
        deps.branch(),
        mock_env(),
        mock_info(
            &address("player-b"),
            &[coin(reserve, "factory/xion1issuer/verusd")],
        ),
        ExecuteMsg::DepositReserve {
            game_id: game_id.into(),
        },
    )
    .unwrap();
}

#[test]
fn rejects_extra_denoms_and_admin_settlement() {
    let mut deps = mock_dependencies();
    instantiate_contract(deps.as_mut());
    execute(
        deps.as_mut(),
        mock_env(),
        mock_info(&address("authority"), &[]),
        ExecuteMsg::CreateGame {
            game_id: "game-1".into(),
            player_a: address("player-a"),
            player_b: address("player-b"),
            stake_per_point: Uint128::new(10),
            quote_hash: "b".repeat(64),
        },
    )
    .unwrap();
    let error = execute(
        deps.as_mut(),
        mock_env(),
        mock_info(
            &address("player-a"),
            &[
                coin(240, "factory/xion1issuer/verusd"),
                coin(1, "unexpected"),
            ],
        ),
        ExecuteMsg::DepositReserve {
            game_id: "game-1".into(),
        },
    )
    .unwrap_err();
    assert!(matches!(error, ContractError::InvalidReserve { .. }));

    let error = execute(
        deps.as_mut(),
        mock_env(),
        mock_info(&address("admin"), &[]),
        ExecuteMsg::Refund {
            game_id: "game-1".into(),
            refund_id: "refund-1".into(),
            reason: "manual_review".into(),
        },
    )
    .unwrap_err();
    assert_eq!(error, ContractError::Unauthorized);
}

#[test]
fn every_cube_and_result_conserves_reserves() {
    for cube in [1u32, 2, 4, 8] {
        for multiplier in [1u32, 2, 3] {
            let mut deps = mock_dependencies();
            instantiate_contract(deps.as_mut());
            create_and_fund(deps.as_mut(), "matrix-game", 100);
            let response = execute(
                deps.as_mut(),
                mock_env(),
                mock_info(&address("authority"), &[]),
                ExecuteMsg::Settle {
                    game_id: "matrix-game".into(),
                    winner: address("player-a"),
                    result_multiplier: multiplier,
                    cube_value: cube,
                    cube_was_turned: true,
                    settlement_id: format!("settlement-{cube}-{multiplier}"),
                },
            )
            .unwrap();
            let paid: u128 = response
                .messages
                .iter()
                .map(|message| match &message.msg {
                    CosmosMsg::Bank(BankMsg::Send { amount, .. }) => amount[0].amount.u128(),
                    _ => 0,
                })
                .sum();
            assert_eq!(paid, 4_800);

            let game: GameResponse = from_json(
                query(
                    deps.as_ref(),
                    mock_env(),
                    QueryMsg::Game {
                        game_id: "matrix-game".into(),
                    },
                )
                .unwrap(),
            )
            .unwrap();
            let receipt = game.receipt.unwrap();
            let liability = Uint128::new(100 * cube as u128 * multiplier as u128);
            assert_eq!(receipt.liability, liability);
            assert_eq!(receipt.rake, liability.multiply_ratio(250u128, 10_000u128));
            assert_eq!(
                receipt.winner_payout + receipt.loser_payout + receipt.rake,
                Uint128::new(4_800)
            );
        }
    }
}

#[test]
fn jacoby_and_terminal_retries_are_deterministic() {
    let mut deps = mock_dependencies();
    instantiate_contract(deps.as_mut());
    create_and_fund(deps.as_mut(), "jacoby-game", 100);
    let command = ExecuteMsg::Settle {
        game_id: "jacoby-game".into(),
        winner: address("player-b"),
        result_multiplier: 3,
        cube_value: 1,
        cube_was_turned: false,
        settlement_id: "settlement-jacoby".into(),
    };
    execute(
        deps.as_mut(),
        mock_env(),
        mock_info(&address("authority"), &[]),
        command.clone(),
    )
    .unwrap();
    let retry = execute(
        deps.as_mut(),
        mock_env(),
        mock_info(&address("authority"), &[]),
        command,
    )
    .unwrap();
    assert!(retry
        .attributes
        .iter()
        .any(|attribute| attribute.key == "idempotent" && attribute.value == "true"));

    let game: GameResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::Game {
                game_id: "jacoby-game".into(),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(game.receipt.unwrap().result_multiplier, Some(1));
}

#[test]
fn rejects_admin_as_settlement_authority() {
    let mut deps = mock_dependencies();
    let admin = address("same-admin");
    let error = instantiate(
        deps.as_mut(),
        mock_env(),
        mock_info(&admin, &[]),
        InstantiateMsg {
            wager_denom: "factory/xion1issuer/verusd".into(),
            settlement_authority: admin,
            rake_bps: 0,
            rake_recipient: address("treasury"),
            min_stake_per_point: Uint128::new(1),
            max_stake_per_point: Uint128::new(1_000_000_000),
            funding_timeout_seconds: 300,
            cube_cap: 8,
            rules_version: "cash-v1".into(),
        },
    )
    .unwrap_err();
    assert!(matches!(error, ContractError::InvalidConfig { .. }));
}

const WAGER_DENOM: &str = "factory/xion1issuer/verusd";

struct FundedSandbox {
    app: App,
    escrow: Addr,
    authority: Addr,
    player_a: Addr,
    player_b: Addr,
    treasury: Addr,
    total_issued: Uint128,
}

fn escrow_contract() -> Box<dyn Contract<Empty>> {
    Box::new(ContractWrapper::new(execute, instantiate, query))
}

fn sandbox_balance(app: &App, account: &Addr) -> Uint128 {
    app.wrap()
        .query_balance(account.to_string(), WAGER_DENOM)
        .unwrap()
        .amount
}

fn sandbox_total(sandbox: &FundedSandbox) -> Uint128 {
    sandbox_balance(&sandbox.app, &sandbox.player_a)
        + sandbox_balance(&sandbox.app, &sandbox.player_b)
        + sandbox_balance(&sandbox.app, &sandbox.treasury)
        + sandbox_balance(&sandbox.app, &sandbox.escrow)
}

// Fixture boundary: all accounts and funds below exist only in the in-memory MultiTest bank.
fn funded_sandbox(game_id: &str, stake: u128) -> FundedSandbox {
    let admin = Addr::unchecked(address("sandbox-admin"));
    let authority = Addr::unchecked(address("sandbox-authority"));
    let player_a = Addr::unchecked(address("sandbox-player-a"));
    let player_b = Addr::unchecked(address("sandbox-player-b"));
    let treasury = Addr::unchecked(address("sandbox-treasury"));
    let reserve = stake * 8 * 3;
    let total_issued = Uint128::new(reserve * 2);
    let mut app = App::new(|router, _, storage| {
        router
            .bank
            .init_balance(storage, &player_a, vec![coin(reserve, WAGER_DENOM)])
            .unwrap();
        router
            .bank
            .init_balance(storage, &player_b, vec![coin(reserve, WAGER_DENOM)])
            .unwrap();
    });
    let code_id = app.store_code(escrow_contract());
    let escrow = app
        .instantiate_contract(
            code_id,
            admin,
            &InstantiateMsg {
                wager_denom: WAGER_DENOM.into(),
                settlement_authority: authority.to_string(),
                rake_bps: 250,
                rake_recipient: treasury.to_string(),
                min_stake_per_point: Uint128::new(1),
                max_stake_per_point: Uint128::new(1_000_000_000),
                funding_timeout_seconds: 300,
                cube_cap: 8,
                rules_version: "cash-v1".into(),
            },
            &[],
            "finance-sandbox",
            None,
        )
        .unwrap();
    app.execute_contract(
        authority.clone(),
        escrow.clone(),
        &ExecuteMsg::CreateGame {
            game_id: game_id.into(),
            player_a: player_a.to_string(),
            player_b: player_b.to_string(),
            stake_per_point: Uint128::new(stake),
            quote_hash: "d".repeat(64),
        },
        &[],
    )
    .unwrap();
    for player in [&player_a, &player_b] {
        app.execute_contract(
            (*player).clone(),
            escrow.clone(),
            &ExecuteMsg::DepositReserve {
                game_id: game_id.into(),
            },
            &[coin(reserve, WAGER_DENOM)],
        )
        .unwrap();
    }

    FundedSandbox {
        app,
        escrow,
        authority,
        player_a,
        player_b,
        treasury,
        total_issued,
    }
}

#[test]
fn finance_sandbox_conserves_money_through_settlement_and_refund() {
    let mut settlement = funded_sandbox("funded-settlement", 100);
    assert_eq!(sandbox_balance(&settlement.app, &settlement.escrow), Uint128::new(4_800));
    assert_eq!(sandbox_total(&settlement), settlement.total_issued);

    settlement
        .app
        .execute_contract(
            settlement.authority.clone(),
            settlement.escrow.clone(),
            &ExecuteMsg::Settle {
                game_id: "funded-settlement".into(),
                winner: settlement.player_a.to_string(),
                result_multiplier: 2,
                cube_value: 4,
                cube_was_turned: true,
                settlement_id: "settlement-1".into(),
            },
            &[],
        )
        .unwrap();

    assert_eq!(sandbox_balance(&settlement.app, &settlement.player_a), Uint128::new(3_180));
    assert_eq!(sandbox_balance(&settlement.app, &settlement.player_b), Uint128::new(1_600));
    assert_eq!(sandbox_balance(&settlement.app, &settlement.treasury), Uint128::new(20));
    assert_eq!(sandbox_balance(&settlement.app, &settlement.escrow), Uint128::zero());
    assert_eq!(sandbox_total(&settlement), settlement.total_issued);

    let mut refund = funded_sandbox("funded-refund", 100);
    assert_eq!(sandbox_balance(&refund.app, &refund.escrow), Uint128::new(4_800));
    assert_eq!(sandbox_total(&refund), refund.total_issued);

    refund
        .app
        .execute_contract(
            refund.authority.clone(),
            refund.escrow.clone(),
            &ExecuteMsg::Refund {
                game_id: "funded-refund".into(),
                refund_id: "refund-1".into(),
                reason: "sandbox_dispute".into(),
            },
            &[],
        )
        .unwrap();

    assert_eq!(sandbox_balance(&refund.app, &refund.player_a), Uint128::new(2_400));
    assert_eq!(sandbox_balance(&refund.app, &refund.player_b), Uint128::new(2_400));
    assert_eq!(sandbox_balance(&refund.app, &refund.treasury), Uint128::zero());
    assert_eq!(sandbox_balance(&refund.app, &refund.escrow), Uint128::zero());
    assert_eq!(sandbox_total(&refund), refund.total_issued);
}

struct MultitestBridgeInput {
    terminal: String,
    principal_balance: u128,
    opponent_balance: u128,
    rake_balance: u128,
    stake_per_point: u128,
    cube_cap: u32,
    rake_bps: u16,
    cube_value: u32,
    result_multiplier: u32,
    cube_was_turned: bool,
    winner: String,
    denom: String,
}

fn multitest_bridge_input() -> Option<MultitestBridgeInput> {
    let fixture = match std::env::var("SANDBOX_ESCROW_BRIDGE_INPUT") {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => return None,
        Err(error) => panic!("bridge fixture unavailable: {error}"),
    };
    let mut values = fixture.split('|');
    let terminal = values.next().expect("bridge terminal missing").to_owned();
    let principal_balance = values
        .next()
        .expect("bridge principal balance missing")
        .parse()
        .expect("bridge principal balance invalid");
    let opponent_balance = values
        .next()
        .expect("bridge opponent balance missing")
        .parse()
        .expect("bridge opponent balance invalid");
    let rake_balance = values
        .next()
        .expect("bridge rake balance missing")
        .parse()
        .expect("bridge rake balance invalid");
    let stake_per_point = values
        .next()
        .expect("bridge stake missing")
        .parse()
        .expect("bridge stake invalid");
    let cube_cap = values
        .next()
        .expect("bridge cube cap missing")
        .parse()
        .expect("bridge cube cap invalid");
    let rake_bps = values
        .next()
        .expect("bridge rake bps missing")
        .parse()
        .expect("bridge rake bps invalid");
    let cube_value = values
        .next()
        .expect("bridge cube value missing")
        .parse()
        .expect("bridge cube value invalid");
    let result_multiplier = values
        .next()
        .expect("bridge result multiplier missing")
        .parse()
        .expect("bridge result multiplier invalid");
    let cube_was_turned = values
        .next()
        .expect("bridge cube turn missing")
        .parse()
        .expect("bridge cube turn invalid");
    let winner = values.next().expect("bridge winner missing").to_owned();
    let denom = values.next().expect("bridge denom missing").to_owned();
    assert!(values.next().is_none(), "bridge fixture has unexpected fields");
    Some(MultitestBridgeInput {
        terminal,
        principal_balance,
        opponent_balance,
        rake_balance,
        stake_per_point,
        cube_cap,
        rake_bps,
        cube_value,
        result_multiplier,
        cube_was_turned,
        winner,
        denom,
    })
}
#[test]
fn multitest_bridge_from_environment() {
    let Some(input) = multitest_bridge_input() else {
        return;
    };
    let admin = Addr::unchecked(address("bridge-admin"));
    let authority = Addr::unchecked(address("bridge-authority"));
    let principal = Addr::unchecked(address("bridge-principal"));
    let opponent = Addr::unchecked(address("bridge-opponent"));
    let rake_recipient = Addr::unchecked(address("bridge-rake"));
    let mut app = App::new(|router, _, storage| {
        router
            .bank
            .init_balance(
                storage,
                &principal,
                vec![coin(input.principal_balance, input.denom.clone())],
            )
            .unwrap();
        router
            .bank
            .init_balance(
                storage,
                &opponent,
                vec![coin(input.opponent_balance, input.denom.clone())],
            )
            .unwrap();
        if input.rake_balance > 0 {
            router
                .bank
                .init_balance(
                    storage,
                    &rake_recipient,
                    vec![coin(input.rake_balance, input.denom.clone())],
                )
                .unwrap();
        }
    });
    let code_id = app.store_code(escrow_contract());
    let escrow = app
        .instantiate_contract(
            code_id,
            admin,
            &InstantiateMsg {
                wager_denom: input.denom.clone(),
                settlement_authority: authority.to_string(),
                rake_bps: input.rake_bps,
                rake_recipient: rake_recipient.to_string(),
                min_stake_per_point: Uint128::new(1),
                max_stake_per_point: Uint128::new(u128::MAX),
                funding_timeout_seconds: 300,
                cube_cap: input.cube_cap,
                rules_version: "cash-v1".into(),
            },
            &[],
            "multitest-bridge",
            None,
        )
        .unwrap();
    let game_id = "multitest-bridge";
    app.execute_contract(
        authority.clone(),
        escrow.clone(),
        &ExecuteMsg::CreateGame {
            game_id: game_id.into(),
            player_a: principal.to_string(),
            player_b: opponent.to_string(),
            stake_per_point: Uint128::new(input.stake_per_point),
            quote_hash: "e".repeat(64),
        },
        &[],
    )
    .unwrap();
    let reserve = input.stake_per_point * input.cube_cap as u128 * 3;
    for player in [&principal, &opponent] {
        app.execute_contract(
            (*player).clone(),
            escrow.clone(),
            &ExecuteMsg::DepositReserve {
                game_id: game_id.into(),
            },
            &[coin(reserve, input.denom.clone())],
        )
        .unwrap();
    }
    match input.terminal.as_str() {
        "settlement" => app
            .execute_contract(
                authority,
                escrow.clone(),
                &ExecuteMsg::Settle {
                    game_id: game_id.into(),
                    winner: match input.winner.as_str() {
                        "principal" => principal.to_string(),
                        "opponent" => opponent.to_string(),
                        _ => panic!("bridge winner invalid"),
                    },
                    result_multiplier: input.result_multiplier,
                    cube_value: input.cube_value,
                    cube_was_turned: input.cube_was_turned,
                    settlement_id: "multitest-settlement".into(),
                },
                &[],
            )
            .unwrap(),
        "refund" => app
            .execute_contract(
                authority,
                escrow.clone(),
                &ExecuteMsg::Refund {
                    game_id: game_id.into(),
                    refund_id: "multitest-refund".into(),
                    reason: "sandbox_refund".into(),
                },
                &[],
            )
            .unwrap(),
        _ => panic!("bridge terminal invalid"),
    };
    let game: GameResponse = app
        .wrap()
        .query_wasm_smart(escrow.to_string(), &QueryMsg::Game {
            game_id: game_id.into(),
        })
        .unwrap();
    let receipt = game.receipt.expect("bridge receipt missing");
    let principal_balance = sandbox_balance_for_denom(&app, &principal, &input.denom);
    let opponent_balance = sandbox_balance_for_denom(&app, &opponent, &input.denom);
    let rake_balance = sandbox_balance_for_denom(&app, &rake_recipient, &input.denom);
    let escrow_balance = sandbox_balance_for_denom(&app, &escrow, &input.denom);
    assert_eq!(
        principal_balance + opponent_balance + rake_balance + escrow_balance,
        Uint128::new(input.principal_balance + input.opponent_balance + input.rake_balance),
    );
    println!(
        "SANDBOX_ESCROW_RESULT|principal={principal_balance}|opponent={opponent_balance}|rake={rake_balance}|escrow={escrow_balance}|reserve={}|liability={}|rake_amount={}|winner_payout={}|loser_payout={}",
        game.reserve_per_player,
        receipt.liability,
        receipt.rake,
        receipt.winner_payout,
        receipt.loser_payout,
    );
}

fn sandbox_balance_for_denom(app: &App, account: &Addr, denom: &str) -> Uint128 {
    app.wrap()
        .query_balance(account.to_string(), denom)
        .unwrap()
        .amount
}
