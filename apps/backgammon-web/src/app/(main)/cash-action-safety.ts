export type MoneyAction = "deposit" | "cash_out" | "wager";

const XION_ADDRESS = /^xion1[ac-hj-np-z02-9]{38}$/;
const USD_CENTS = /^(?:0|[1-9]\d*)\.\d{2}$/;

export function xionAddressError(value: string, ownAddress?: string | null): string | null {
  const address = value.trim().toLowerCase();
  if (!XION_ADDRESS.test(address)) return "Enter a valid XION address.";
  if (ownAddress && address === ownAddress.toLowerCase()) return "Choose another player; you cannot create a cash game against your own wallet.";
  return null;
}

export function usdCentsError(value: string): string | null {
  if (!USD_CENTS.test(value)) return "Enter a positive amount in whole cents, for example 5.00.";
  if (BigInt(value.replace(".", "")) === 0n) return "Enter an amount greater than $0.00.";
  return null;
}

export function usdToMicroUsd(value: string): string | null {
  if (usdCentsError(value)) return null;
  const [dollars, cents] = value.split(".");
  return (BigInt(dollars) * 1_000_000n + BigInt(cents) * 10_000n).toString();
}

export function safeMoneyFailure(action: MoneyAction): string {
  switch (action) {
    case "deposit": return "Your deposit could not be submitted. No money has been assumed received; review Activity before trying again.";
    case "cash_out": return "Your cash-out could not be submitted. No verUSD has moved; review Activity before trying again.";
    case "wager": return "This cash-game action could not be completed. No reserve has been assumed; refresh the offer or check Activity.";
  }
}

export function unavailableMoneyMessage(): string {
  return "This money feature is unavailable on this deployment until its required legal documents, provider integrations, eligibility controls, and operational approvals are active.";
}

export function fundsLabel(testFunds: boolean): string {
  return testFunds ? "TEST FUNDS ONLY — no cash value" : "Production verUSD";
}
