import { generateKeyPairSync } from "node:crypto";

if (process.env.NODE_ENV === "production") {
  throw new Error("The browser finance sandbox cannot run in production");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required; start and migrate an isolated Postgres database first");
}

const fixtureHash = "a".repeat(64);
const fixtureKey = Buffer.alloc(32, 7).toString("base64");
const escrowContract = "xion1767l3dc579pfeegsy0mcgrjrpu5u8m4sh0cfyu";
const financeContract = "xion1vsrxv6uay8urlrx6ajhqqwg4xs52scx036c8kf";
const settlementKeys = generateKeyPairSync("ed25519");

Object.assign(process.env, {
  NODE_ENV: "development",
  GAMMON_BROWSER_FINANCE_SANDBOX: "1",
  FUNDS_MODE: "verusd_testnet",
  ALLOWED_ORIGINS: "http://127.0.0.1:3421",
  SESSION_SECRET: "sandbox-session-secret-must-never-be-used-outside-local-dev",
  VERUSD_CHAIN_ID: "xion-testnet-2",
  VERUSD_GENESIS_BLOCK_HASH: fixtureHash,
  VERUSD_RPC_URL: "https://chain.browser-sandbox.invalid",
  VERUSD_REST_URL: "https://chain.browser-sandbox.invalid",
  VERUSD_DENOM: `factory/${escrowContract}/verusd`,
  VERUSD_SYMBOL: "verUSD",
  VERUSD_DECIMALS: "6",
  VERUSD_ESCROW_CONTRACT: escrowContract,
  VERUSD_ESCROW_CODE_CHECKSUM: fixtureHash,
  VERUSD_FINALITY_BLOCKS: "2",
  BRALE_TRANSFER_TYPE: "verona_testnet",
  BRALE_ACCOUNT_ID: "sandboxbraleaccount01",
  BRALE_API_KEY: "browser-sandbox-provider-key",
  BRALE_API_URL: "https://brale.browser-sandbox.invalid",
  BRALE_AUTH_URL: "https://auth.browser-sandbox.invalid/oauth2/token",
  BRALE_PROGRAM_ID: "sandbox-program",
  BRALE_REQUIRED_ACCOUNT_CAPABILITY: "sandbox-capability",
  BRALE_WEBHOOK_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef",
  BRALE_WEBHOOK_SUBSCRIPTION_ID: "sandbox-webhook-subscription",
  BRALE_WEBHOOK_ENVIRONMENT: "sandbox",
  BRALE_PLAID_WEBHOOK_URL: "https://brale.browser-sandbox.invalid/webhooks/plaid",
  FINANCE_AUTHORIZATION_CONTRACT: financeContract,
  FINANCE_AUTHORIZATION_MESSAGE_KEY: "authorize_finance_action",
  FINANCE_AUTHORIZATION_CODE_CHECKSUM: fixtureHash,
  FINANCE_AUTHORIZATION_ADMIN: escrowContract,
  FINANCE_AUTHORIZATION_MAX_TRANSFER_MICRO_USD: "100000000",
  CASH_OUT_AUTHORIZATION_PRIVATE_KEY: Buffer.alloc(32, 11).toString("base64"),
  CASH_OUT_AUTHORIZATION_PUBLIC_KEY: "02552c630b64b54bf50210c9e253d38bd4949c72e22873500f6285c2bede312a84",
  FINANCE_DATA_KEY: fixtureKey,
  FINANCE_HASH_KEY: fixtureKey,
  ACH_AVAILABILITY_DELAY_SECONDS: "1",
  ACH_RETURN_RECONCILIATION_HORIZON_SECONDS: "3600",
  SETTLEMENT_AUTHORITY_CONTRACT: financeContract,
  SETTLEMENT_AUTHORIZER_URL: "https://settlement.browser-sandbox.invalid",
  SETTLEMENT_AUTHORIZER_API_KEY: "browser-sandbox-settlement-key",
  SETTLEMENT_AUTHORIZER_PUBLIC_KEY: settlementKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  SANDBOX_SETTLEMENT_PRIVATE_KEY: settlementKeys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  SETTLEMENT_AUTHORIZER_SIGNING_KEY_ID: "browser-sandbox-key-1",
  VERUSD_ESCROW_ADMIN: financeContract,
  VERUSD_MIN_STAKE_MICRO_USD: "100000",
  VERUSD_MAX_STAKE_MICRO_USD: "10000000",
  VERUSD_FUNDING_TIMEOUT_SECONDS: "300",
  VERUSD_RAKE_RECIPIENT: financeContract,
  CASH_GAME_TERMS_VERSION: "browser-sandbox-cash-v1",
  RESPONSIBLE_PLAY_POLICY_VERSION: "browser-sandbox-responsible-play-v1",
  TERMS_VERSION: "browser-sandbox-terms-v1",
  PRIVACY_VERSION: "browser-sandbox-privacy-v1",
  BRALE_END_USER_TOS_VERSION: "browser-sandbox-brale-eua-v1",
  BRALE_EUA_URL: "https://www.brale.xyz/browser-sandbox-eua",
  BRALE_EUA_SHA256: fixtureHash,
  BRALE_EUA_EXPIRES_AT: "2099-01-01T00:00:00.000Z",
  PLAID_PRIVACY_VERSION: "browser-sandbox-plaid-privacy-v1",
  PLAID_PRIVACY_URL: "https://plaid.com/browser-sandbox-privacy",
  PLAID_PRIVACY_SHA256: fixtureHash,
  PLAID_PRIVACY_EXPIRES_AT: "2099-01-01T00:00:00.000Z",
  ACH_AUTHORIZATION_VERSION: "browser-sandbox-ach-v1",
  ACH_AUTHORIZATION_URL: "https://brale.browser-sandbox.invalid/ach-authorization",
  ACH_AUTHORIZATION_SHA256: fixtureHash,
  ACH_AUTHORIZATION_EXPIRES_AT: "2099-01-01T00:00:00.000Z",
});

// Funds configuration is loaded at module initialization, after the isolated fixture environment above.

const { startBrowserFinanceSandbox } = await import("../src/browser-finance-sandbox.js");
await startBrowserFinanceSandbox(Number(process.env.PORT ?? "3422"));
console.log("Browser finance sandbox listening at http://127.0.0.1:3422");
