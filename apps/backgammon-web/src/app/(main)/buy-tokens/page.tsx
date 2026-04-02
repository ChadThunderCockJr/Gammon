"use client";

import { redirect } from "next/navigation";

// Old Crossmint NFT token pack page. Redirects to the new wallet with Brale ACH deposit/withdraw.
export default function BuyTokensRedirect() {
  redirect("/wallet");
}
