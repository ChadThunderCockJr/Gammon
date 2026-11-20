import { describe, expect, it } from "vitest";
import { authorizedReserveExecutionMessage } from "../cash-game-chain.js";

const principal = `xion1${"p".repeat(38)}`;
const signer = `xion1${"s".repeat(38)}`;

function reserveExecution(sender = principal) {
  return {
    "@type": "/cosmwasm.wasm.v1.MsgExecuteContract",
    sender,
    contract: `xion1${"e".repeat(38)}`,
    msg: Buffer.from(JSON.stringify({ deposit_reserve: { game_id: "game-1" } })).toString("base64"),
    funds: [{ denom: "factory/xion/verusd", amount: "2400" }],
  };
}

function authorizedExecution(grantee: string, msgs: unknown[]) {
  return {
    "@type": "/cosmos.authz.v1beta1.MsgExec",
    grantee,
    msgs,
  };
}

describe("authorizedReserveExecutionMessage", () => {
  it("accepts one Abstraxion authz execution for the authenticated signer", () => {
    const execution = reserveExecution();

    expect(authorizedReserveExecutionMessage(
      [authorizedExecution(signer, [execution])],
      principal,
      signer,
    )).toEqual(execution);
  });

  it("accepts a direct execution only when the principal signed it", () => {
    const execution = reserveExecution();

    expect(authorizedReserveExecutionMessage([execution], principal, principal)).toEqual(execution);
  });

  it.each([
    ["wrong grantee", [authorizedExecution(principal, [reserveExecution()])], principal, signer],
    ["multiple outer messages", [reserveExecution(), reserveExecution()], principal, principal],
    ["zero delegated messages", [authorizedExecution(signer, [])], principal, signer],
    ["multiple delegated messages", [authorizedExecution(signer, [reserveExecution(), reserveExecution()])], principal, signer],
    ["nested authz message", [authorizedExecution(signer, [authorizedExecution(signer, [reserveExecution()])])], principal, signer],
    ["other delegated message type", [authorizedExecution(signer, [{ "@type": "/cosmos.bank.v1beta1.MsgSend" }])], principal, signer],
    ["direct delegated bypass", [reserveExecution()], principal, signer],
  ])("rejects %s", (_caseName, messages, requestPrincipal, requestSigner) => {
    expect(() => authorizedReserveExecutionMessage(messages, requestPrincipal, requestSigner)).toThrow(
      "CHAIN_TRANSACTION_MISMATCH",
    );
  });

  it("permits only direct execution during signerless legacy reconciliation", () => {
    const execution = reserveExecution();

    expect(authorizedReserveExecutionMessage([execution], principal, null)).toEqual(execution);
    expect(() => authorizedReserveExecutionMessage(
      [authorizedExecution(signer, [execution])],
      principal,
      null,
    )).toThrow("CHAIN_TRANSACTION_MISMATCH");
  });
});
