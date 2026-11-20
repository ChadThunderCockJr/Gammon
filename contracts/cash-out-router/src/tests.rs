use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info, MockApi};
use cosmwasm_std::{coin, BankMsg, Binary, CosmosMsg, Uint128};
use k256::ecdsa::{signature::hazmat::PrehashSigner, Signature, SigningKey};
use sha2::{Digest, Sha256};

use crate::contract::{execute, instantiate};
use crate::error::ContractError;
use crate::msg::{ExecuteMsg, InstantiateMsg};

fn address(label: &str) -> String {
    MockApi::default().addr_make(label).to_string()
}
fn signing_key() -> SigningKey {
    SigningKey::from_bytes((&[7u8; 32]).into()).unwrap()
}

fn instantiate_router(deps: cosmwasm_std::DepsMut) {
    let public_key = signing_key().verifying_key().to_encoded_point(true);
    instantiate(
        deps,
        mock_env(),
        mock_info(&address("admin"), &[]),
        InstantiateMsg {
            denom: "factory/xion/verusd".into(),
            max_transfer: Uint128::new(5_000_000),
            authorization_public_key: Binary::from(public_key.as_bytes()),
        },
    )
    .unwrap();
}

fn authorization(
    sender: &str,
    operation_id: &str,
    destination: &str,
    amount: u128,
    expires_at: u64,
) -> Binary {
    let env = mock_env();
    let payload = format!(
        "gammon.cash-out.v1|{}|{}|{}|{}|{}|{}|{}|{}",
        env.block.chain_id,
        env.contract.address,
        sender,
        operation_id,
        destination,
        "factory/xion/verusd",
        amount,
        expires_at,
    );
    let digest: [u8; 32] = Sha256::digest(payload.as_bytes()).into();
    let signature: Signature = signing_key().sign_prehash(&digest).unwrap();
    Binary::from(signature.to_bytes().as_slice())
}

#[test]
fn routes_only_a_server_authorized_exact_transfer() {
    let mut deps = mock_dependencies();
    instantiate_router(deps.as_mut());
    let env = mock_env();
    let sender = address("principal");
    let destination = address("brale-custody");
    let operation_id = "01234567-89ab-cdef-0123-456789abcdef";
    let expires_at = env.block.time.seconds() + 300;
    let response = execute(
        deps.as_mut(),
        env,
        mock_info(&sender, &[coin(1_250_000, "factory/xion/verusd")]),
        ExecuteMsg::AuthorizeFinanceAction {
            operation_id: operation_id.into(),
            destination: destination.clone(),
            expires_at,
            signature: authorization(&sender, operation_id, &destination, 1_250_000, expires_at),
        },
    )
    .unwrap();
    assert_eq!(response.messages.len(), 1);
    assert_eq!(
        response.messages[0].msg,
        CosmosMsg::Bank(BankMsg::Send {
            to_address: destination,
            amount: vec![coin(1_250_000, "factory/xion/verusd")],
        })
    );
}

#[test]
fn rejects_tampering_expiry_and_replay() {
    let mut deps = mock_dependencies();
    instantiate_router(deps.as_mut());
    let env = mock_env();
    let sender = address("principal");
    let destination = address("brale-custody");
    let operation_id = "01234567-89ab-cdef-0123-456789abcdef";
    let expires_at = env.block.time.seconds() + 300;
    let signature = authorization(&sender, operation_id, &destination, 1, expires_at);
    let tampered = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(&sender, &[coin(2, "factory/xion/verusd")]),
        ExecuteMsg::AuthorizeFinanceAction {
            operation_id: operation_id.into(),
            destination: destination.clone(),
            expires_at,
            signature: signature.clone(),
        },
    )
    .unwrap_err();
    assert_eq!(tampered, ContractError::Unauthorized);
    let expired = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(&sender, &[coin(1, "factory/xion/verusd")]),
        ExecuteMsg::AuthorizeFinanceAction {
            operation_id: operation_id.into(),
            destination: destination.clone(),
            expires_at: env.block.time.seconds() - 1,
            signature: signature.clone(),
        },
    )
    .unwrap_err();
    assert_eq!(expired, ContractError::Unauthorized);
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(&sender, &[coin(1, "factory/xion/verusd")]),
        ExecuteMsg::AuthorizeFinanceAction {
            operation_id: operation_id.into(),
            destination,
            expires_at,
            signature,
        },
    )
    .unwrap();
    let replay = execute(
        deps.as_mut(),
        env,
        mock_info(&sender, &[coin(1, "factory/xion/verusd")]),
        ExecuteMsg::AuthorizeFinanceAction {
            operation_id: operation_id.into(),
            destination: address("brale-custody"),
            expires_at,
            signature: Binary::from(vec![0; 64]),
        },
    )
    .unwrap_err();
    assert_eq!(replay, ContractError::DuplicateOperation);
}
