import { fundsGate, type FundsAction } from "./funds-config.js";

const actions = [
  "provider_account_create", "link_bank", "deposit", "wager",
  "cash_out", "settle", "refund", "history",
] as const satisfies readonly FundsAction[];

const [target, ...extra] = process.argv.slice(2);
if (extra.length || (target !== "verusd_testnet" && target !== "verusd_production")) {
  console.error("Usage: pnpm funds:preflight <verusd_testnet|verusd_production>");
  process.exitCode = 2;
} else if (fundsGate.config.mode !== target) {
  console.log(JSON.stringify({ target, status: "blocked", reason: "funds_mode_mismatch" }, null, 2));
  process.exitCode = 1;
} else {
  const results = actions.map((action) => ({
    action,
    // This process never sets attestations; keep those separate from static failures.
    configurationBlockers: fundsGate.blockersFor(action).filter((code) => !code.endsWith("_attestation_stale")),
  }));
  const blocked = results.some(({ configurationBlockers }) => configurationBlockers.length > 0);
  console.log(JSON.stringify({
    target,
    status: blocked ? "blocked" : "configuration_passed",
    liveAttestation: "not_checked",
    actions: results,
  }, null, 2));
  process.exitCode = blocked ? 1 : 0;
}
