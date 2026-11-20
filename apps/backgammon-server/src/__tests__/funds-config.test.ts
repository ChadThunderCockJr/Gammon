import { afterEach, describe, expect, it, vi } from "vitest";
import { FundsGate, loadFundsConfig, type FundsConfig } from "../funds-config.js";

const unblocked: FundsConfig = {
  mode: "verusd_testnet",
  asset: {
    chainId: "xion-testnet-2",
    genesisHash: "b".repeat(64),
    rpcUrl: "https://rpc.example.test",
    restUrl: "https://rest.example.test",
    denom: `factory/xion1${"q".repeat(38)}/verusd`,
    symbol: "verUSD",
    decimals: 6,
    finalityBlocks: 2,
    braleTransferType: "verona_testnet",
    escrowContract: `xion1${"q".repeat(38)}`,
    escrowCodeChecksum: "a".repeat(64),
  },
  accountId: "account_test",
  staticBlockers: {
    provider_account_create: [],
    link_bank: [],
    deposit: [],
    cash_out: [],
    wager: [],
    settle: [],
    refund: [],
    history: [],
  },
  approvalExpiries: null,
  legalDocuments: null,
  responsiblePlayHelp: null,
  approvedAchPolicy: null,
  settlementAuthorizer: null,
  rulesJson: "{}",
};

function attest(
  gate: FundsGate,
  escrowEntry: readonly string[] = [],
  provider: readonly string[] = [],
  escrowRecovery: readonly string[] = [],
  escrowIntegrity: readonly string[] = [],
  financeRouter: readonly string[] = [],
): void {
  gate.setAttestation({ infrastructure: [], asset: [], escrowIntegrity, escrowEntry, escrowRecovery, provider, financeRouter });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("FundsGate", () => {
  it("keeps funded settlement available when entry escrow checks drift", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const gate = new FundsGate(unblocked);

    attest(gate, [], ["brale_attestation_failed"]);
    expect(gate.allows("deposit")).toBe(false);
    expect(gate.allows("cash_out")).toBe(false);
    expect(gate.allows("wager")).toBe(true);
    expect(gate.allows("settle")).toBe(true);
    expect(gate.allows("refund")).toBe(true);
    expect(gate.blockersFor("settle")).not.toContain("brale_attestation_failed");

    attest(gate, ["escrow_paused"], []);
    expect(gate.allows("deposit")).toBe(true);
    expect(gate.allows("cash_out")).toBe(true);
    expect(gate.allows("wager")).toBe(false);
    expect(gate.allows("settle")).toBe(true);
    expect(gate.allows("refund")).toBe(true);
    expect(gate.blockersFor("settle")).not.toContain("escrow_paused");
  });
  it("isolates cash-out router attestation from deposits and funded settlement", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const gate = new FundsGate(unblocked);
    attest(gate, [], [], [], [], ["finance_router_checksum_mismatch"]);

    expect(gate.allows("cash_out")).toBe(false);
    expect(gate.allows("deposit")).toBe(true);
    expect(gate.allows("settle")).toBe(true);
  });


  it.each([
    "escrow_checksum_mismatch",
    "escrow_admin_mismatch",
    "escrow_denom_mismatch",
    "settlement_authority_mismatch",
  ])("blocks new wagers and funded recovery on immutable %s", (mismatch) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const gate = new FundsGate(unblocked);

    attest(gate, [], [], [], [mismatch]);

    expect(gate.allows("wager")).toBe(false);
    expect(gate.allows("settle")).toBe(false);
    expect(gate.allows("refund")).toBe(false);
    expect(gate.publicState().wagerEnabled).toBe(false);
  });

  it("keeps balance reads available through entry and provider pauses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const gate = new FundsGate({
      ...unblocked,
      staticBlockers: {
        ...unblocked.staticBlockers,
        deposit: ["entry_kill_switch"],
        wager: ["entry_kill_switch"],
      },
    });
    gate.setAttestation({
      infrastructure: [],
      asset: [],
      escrowIntegrity: [],
      escrowEntry: ["escrow_paused"],
      escrowRecovery: [],
      provider: ["brale_attestation_failed"],
      financeRouter: [],
    });

    expect(gate.balanceReadBlockers()).toEqual([]);
    expect(gate.allows("deposit")).toBe(false);
    expect(gate.allows("wager")).toBe(false);

    gate.setAttestation({
      infrastructure: [],
      asset: ["asset_identity_mismatch"],
      escrowIntegrity: [],
      escrowEntry: [],
      escrowRecovery: [],
      provider: [],
      financeRouter: [],
    });
    expect(gate.balanceReadBlockers()).toContain("asset_identity_mismatch");
  });

  it("fails every action closed when its required attestation becomes stale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const gate = new FundsGate(unblocked);
    attest(gate);
    expect(gate.allows("deposit")).toBe(true);
    expect(gate.allows("history")).toBe(true);

    vi.advanceTimersByTime(60_001);

    expect(gate.allows("deposit")).toBe(false);
    expect(gate.allows("wager")).toBe(false);
    expect(gate.blockersFor("wager")).toContain("escrowEntry_attestation_stale");
    expect(gate.allows("history")).toBe(false);
    expect(gate.blockersFor("history")).toEqual(["infrastructure_attestation_stale"]);
  });

  it("re-evaluates entry approvals independently from recovery approvals", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const gate = new FundsGate({
      ...unblocked,
      mode: "verusd_production",
      asset: { ...unblocked.asset!, braleTransferType: "verona" },
      approvalExpiries: {
        entry: "2026-01-01T00:00:30.000Z",
        achAvailability: "2026-01-01T00:00:35.000Z",
        recovery: "2026-01-01T00:00:45.000Z",
      },
      responsiblePlayHelp: {
        name: "National Problem Gambling Helpline",
        url: "https://www.ncpgambling.org/help-treatment/national-helpline-1-800-gambler/",
        version: "2026.01",
        sha256: "c".repeat(64),
        expiresAt: "2026-01-02T00:00:00.000Z",
      },
    });
    attest(gate);
    expect(gate.allows("wager")).toBe(true);
    expect(gate.allows("settle")).toBe(true);

    vi.advanceTimersByTime(31_000);
    expect(gate.blockersFor("wager")).toContain("production_approval_expired");
    expect(gate.allows("settle")).toBe(true);

    vi.advanceTimersByTime(15_000);
    expect(gate.allows("settle")).toBe(false);
    expect(gate.blockersFor("settle")).toContain("production_recovery_approval_expired");
  });

  it("keeps responsible-play help optional outside production", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const testGate = new FundsGate(unblocked);
    attest(testGate);

    expect(testGate.allows("deposit")).toBe(true);
    expect(testGate.allows("wager")).toBe(true);
    expect(new FundsGate({ ...unblocked, mode: "free", asset: null, accountId: null }).publicState().responsiblePlayHelp).toBeNull();
  });

  it("requires responsible-play help for production entry without limiting recovery", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const gate = new FundsGate({
      ...unblocked,
      mode: "verusd_production",
      asset: { ...unblocked.asset!, braleTransferType: "verona" },
      approvalExpiries: {
        entry: "2026-01-02T00:00:00.000Z",
        achAvailability: "2026-01-02T00:00:00.000Z",
        recovery: "2026-01-02T00:00:00.000Z",
      },
      responsiblePlayHelp: null,
    });
    attest(gate);

    for (const action of ["provider_account_create", "link_bank", "deposit", "wager"] as const) {
      expect(gate.allows(action)).toBe(false);
      expect(gate.blockersFor(action)).toContain("responsible_play_help_required");
    }
    for (const action of ["cash_out", "settle", "refund", "history"] as const) {
      expect(gate.allows(action)).toBe(true);
    }
    expect(gate.publicState().actionBlockers.deposit).toContain("entry_approval_required");
  });

  it("exposes an approved responsible-play help tuple and re-closes entry when it expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const responsiblePlayHelp = {
      name: "National Problem Gambling Helpline",
      url: "https://www.ncpgambling.org/help-treatment/national-helpline-1-800-gambler/",
      version: "2026.01",
      sha256: "c".repeat(64),
      expiresAt: "2026-01-01T00:00:30.000Z",
    };
    const gate = new FundsGate({
      ...unblocked,
      mode: "verusd_production",
      asset: { ...unblocked.asset!, braleTransferType: "verona" },
      approvalExpiries: {
        entry: "2026-01-02T00:00:00.000Z",
        achAvailability: "2026-01-02T00:00:00.000Z",
        recovery: "2026-01-02T00:00:00.000Z",
      },
      responsiblePlayHelp,
    });
    attest(gate);

    expect(gate.publicState().responsiblePlayHelp).toEqual(responsiblePlayHelp);
    expect(gate.allows("deposit")).toBe(true);

    vi.advanceTimersByTime(31_000);
    expect(gate.blockersFor("deposit")).toContain("responsible_play_help_expired");
    expect(gate.allows("wager")).toBe(false);
    expect(gate.allows("settle")).toBe(true);
  });

  it("rejects an invalid production help tuple before entry actions", () => {
    vi.stubEnv("FUNDS_MODE", "verusd_production");
    vi.stubEnv("RESPONSIBLE_PLAY_HELP_NAME", "National Problem Gambling Helpline");
    vi.stubEnv("RESPONSIBLE_PLAY_HELP_URL", "http://help.example.test");
    vi.stubEnv("RESPONSIBLE_PLAY_HELP_VERSION", "2026.01");
    vi.stubEnv("RESPONSIBLE_PLAY_HELP_SHA256", "c".repeat(64));
    vi.stubEnv("RESPONSIBLE_PLAY_HELP_EXPIRES_AT", "2026-12-31T00:00:00.000Z");

    const config = loadFundsConfig();

    expect(config.responsiblePlayHelp).toBeNull();
    expect(config.staticBlockers.provider_account_create).toContain("invalid_responsible_play_help_url");
    expect(config.staticBlockers.link_bank).toContain("invalid_responsible_play_help_url");
    expect(config.staticBlockers.deposit).toContain("invalid_responsible_play_help_url");
    expect(config.staticBlockers.wager).toContain("invalid_responsible_play_help_url");
    expect(config.staticBlockers.settle).not.toContain("invalid_responsible_play_help_url");
    expect(config.staticBlockers.refund).not.toContain("invalid_responsible_play_help_url");
  });

  it("blocks production when the approved finality depth differs", () => {
    vi.stubEnv("FUNDS_MODE", "verusd_production");
    vi.stubEnv("VERUSD_FINALITY_BLOCKS", "12");
    vi.stubEnv("VERUSD_APPROVED_FINALITY_BLOCKS", "13");

    expect(loadFundsConfig().staticBlockers.wager).toContain("verusd_finality_blocks_approval_mismatch");
  });

  it("requires a credential-free HTTPS Plaid callback and validates testnet ACH policy", () => {
    vi.stubEnv("FUNDS_MODE", "verusd_testnet");
    vi.stubEnv("BRALE_PLAID_WEBHOOK_URL", "http://user:secret@callback.example.test");
    vi.stubEnv("ACH_AVAILABILITY_DELAY_SECONDS", "60");
    vi.stubEnv("ACH_RETURN_RECONCILIATION_HORIZON_SECONDS", "86400");

    const config = loadFundsConfig();

    expect(config.staticBlockers.link_bank).toContain("invalid_brale_plaid_webhook_url");
    expect(config.approvedAchPolicy).toEqual({
      availabilityDelaySeconds: 60,
      returnReconciliationHorizonSeconds: 86_400,
    });
  });

  it("blocks paid actions when authentication grant queries use another RPC", () => {
    vi.stubEnv("FUNDS_MODE", "verusd_testnet");
    vi.stubEnv("VERUSD_RPC_URL", "https://approved-rpc.example");
    vi.stubEnv("AUTH_RPC_URL", "https://attacker-rpc.example");

    const config = loadFundsConfig();
    expect(config.staticBlockers.cash_out).toContain("unapproved_auth_rpc_url");
    expect(config.staticBlockers.wager).toContain("unapproved_auth_rpc_url");
    expect(config.staticBlockers.history).toContain("unapproved_auth_rpc_url");
  });

  it("binds paid sessions to the attested asset chain", () => {
    vi.stubEnv("FUNDS_MODE", "verusd_testnet");
    vi.stubEnv("VERUSD_CHAIN_ID", "xion-testnet-2");
    vi.stubEnv("AUTH_CHAIN_ID", "xion-mainnet-1");

    expect(loadFundsConfig().staticBlockers.wager).toContain("auth_chain_id_mismatch");
  });
});
