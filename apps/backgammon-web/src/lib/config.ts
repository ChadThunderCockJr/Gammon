export const CHAIN_ID = process.env.NEXT_PUBLIC_CHAIN_ID ?? "xion-testnet-2";
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://gammon.nyc";

export type ClientFundsMode = "free" | "verusd_testnet" | "verusd_production";

const configuredFundsMode = process.env.NEXT_PUBLIC_FUNDS_MODE;
export const FUNDS_MODE: ClientFundsMode = configuredFundsMode === "verusd_testnet" || configuredFundsMode === "verusd_production"
  ? configuredFundsMode
  : "free";

export const VERUSD_DENOM = FUNDS_MODE === "free" ? null : process.env.NEXT_PUBLIC_VERUSD_DENOM ?? null;
export const VERUSD_ESCROW_CONTRACT = FUNDS_MODE === "free" ? null : process.env.NEXT_PUBLIC_VERUSD_ESCROW_CONTRACT ?? null;
export const ESCROW_GRANT_AMOUNT_MICRO_USD = FUNDS_MODE === "free"
  ? null
  : process.env.NEXT_PUBLIC_ESCROW_GRANT_AMOUNT_MICRO_USD ?? null;
export const FINANCE_AUTHORIZATION_CONTRACT = FUNDS_MODE === "free"
  ? null
  : process.env.NEXT_PUBLIC_FINANCE_AUTHORIZATION_CONTRACT ?? null;
export const FINANCE_AUTHORIZATION_GRANT_AMOUNT_MICRO_USD = FUNDS_MODE === "free"
  ? null
  : process.env.NEXT_PUBLIC_FINANCE_AUTHORIZATION_GRANT_AMOUNT_MICRO_USD ?? null;

export const CLIENT_FUNDS_CONFIGURED = Boolean(
  FUNDS_MODE !== "free" &&
  VERUSD_DENOM &&
  VERUSD_ESCROW_CONTRACT &&
  ESCROW_GRANT_AMOUNT_MICRO_USD &&
  FINANCE_AUTHORIZATION_CONTRACT &&
  FINANCE_AUTHORIZATION_GRANT_AMOUNT_MICRO_USD,
);
