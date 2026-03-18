"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  useAbstraxionAccount,
  useAbstraxionSigningClient,
} from "@burnt-labs/abstraxion";
import { toUtf8 } from "@cosmjs/encoding";
import { BALANCE_POLL_INTERVAL_MS } from "@/lib/constants";
import { useIsNativeApp } from "@/hooks/useIsNativeApp";

// Dynamically import Crossmint to avoid SSR crashes (browser-only SDK)
const CrossmintProvider = dynamic(
  () => import("@crossmint/client-sdk-react-ui").then((mod) => mod.CrossmintProvider),
  { ssr: false }
);
const CrossmintEmbeddedCheckout = dynamic(
  () => import("@crossmint/client-sdk-react-ui").then((mod) => mod.CrossmintEmbeddedCheckout),
  { ssr: false }
);

const CROSSMINT_CLIENT_API_KEY = process.env.NEXT_PUBLIC_CROSSMINT_CLIENT_API_KEY ?? "";
const CROSSMINT_COLLECTION_ID = process.env.NEXT_PUBLIC_CROSSMINT_COLLECTION_ID || "";
const NFT_CONTRACT = process.env.NEXT_PUBLIC_CROSSMINT_NFT_CONTRACT || "";
const DEV_ADDRESS = process.env.NEXT_PUBLIC_GAMMON_DEV_ADDRESS || "";
const GAMMON_DENOM = process.env.NEXT_PUBLIC_GAMMON_DENOM || "";

interface PackTier {
  amount: number;
  label: string;
  price: string;
}

const PACK_TIERS: PackTier[] = [
  { amount: 100, label: "100 GAMMON", price: "$1.00" },
  { amount: 500, label: "500 GAMMON", price: "$4.50" },
  { amount: 1000, label: "1,000 GAMMON", price: "$8.00" },
];

type PageState = "selecting" | "checkout" | "success" | "redeeming";

export default function BuyTokensPage() {
  const isNativeApp = useIsNativeApp();
  const router = useRouter();
  const { data: account } = useAbstraxionAccount();
  const { client } = useAbstraxionSigningClient();
  const [pageState, setPageState] = useState<PageState>("selecting");
  const [selectedPack, setSelectedPack] = useState<PackTier | null>(null);
  const [ownedTokenIds, setOwnedTokenIds] = useState<string[]>([]);
  const [gammonBalance, setGammonBalance] = useState<string>("0");
  const [isRedeeming, setIsRedeeming] = useState(false);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [redeemSuccess, setRedeemSuccess] = useState(false);

  const userAddress = account?.bech32Address || "";

  // Fetch Gammon token balance
  const fetchGammonBalance = useCallback(async () => {
    if (!client || !userAddress || !GAMMON_DENOM) return;
    try {
      const balance = await client.getBalance(userAddress, GAMMON_DENOM);
      setGammonBalance(balance.amount);
    } catch (err) {
      console.error("Failed to fetch Gammon balance:", err);
    }
  }, [client, userAddress]);

  // Fetch owned NFT pack tokens
  const fetchOwnedPacks = useCallback(async () => {
    if (!client || !userAddress || !NFT_CONTRACT) return;
    try {
      const result = await client.queryContractSmart(NFT_CONTRACT, {
        tokens: { owner: userAddress, limit: 30 },
      });
      if (result?.tokens && Array.isArray(result.tokens)) {
        setOwnedTokenIds(result.tokens);
      }
    } catch (err) {
      console.error("Failed to fetch owned packs:", err);
    }
  }, [client, userAddress]);

  useEffect(() => {
    fetchGammonBalance();
    fetchOwnedPacks();
  }, [fetchGammonBalance, fetchOwnedPacks]);

  // Poll for balance updates after redeeming
  useEffect(() => {
    if (!redeemSuccess) return;
    const interval = setInterval(() => {
      fetchGammonBalance();
      fetchOwnedPacks();
    }, BALANCE_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [redeemSuccess, fetchGammonBalance, fetchOwnedPacks]);

  // Burn NFT (transfer to dev address) to redeem Gammon tokens
  const redeemPack = async (tokenId: string) => {
    if (!client || !userAddress || !NFT_CONTRACT || !DEV_ADDRESS) {
      setRedeemError("Missing configuration for redemption");
      return;
    }

    setIsRedeeming(true);
    setRedeemError(null);
    setRedeemSuccess(false);

    try {
      const msg = {
        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        value: {
          sender: userAddress,
          contract: NFT_CONTRACT,
          msg: toUtf8(
            JSON.stringify({
              transfer_nft: {
                recipient: DEV_ADDRESS,
                token_id: tokenId,
              },
            })
          ),
          funds: [],
        },
      };

      await client.signAndBroadcast(userAddress, [msg], "auto");
      setRedeemSuccess(true);
      // Remove from local list immediately
      setOwnedTokenIds((prev) => prev.filter((id) => id !== tokenId));
    } catch (err) {
      console.error("Redeem failed:", err);
      setRedeemError(err instanceof Error ? err.message : "Redemption failed");
    } finally {
      setIsRedeeming(false);
    }
  };

  // Parse pack amount from token ID (format: pack-{amount}-{uuid})
  const parsePackAmount = (tokenId: string): number => {
    const match = tokenId.match(/^pack-(\d+)-/);
    return match ? parseInt(match[1], 10) : 0;
  };

  // Redirect away if running inside native iOS app
  useEffect(() => {
    if (isNativeApp) router.replace("/");
  }, [isNativeApp, router]);

  const formatGammon = (microAmount: string): string => {
    const num = parseInt(microAmount, 10) || 0;
    return (num / 1_000_000).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
  };

  if (isNativeApp) return null;

  return (
    <div
      style={{
        maxWidth: 560,
        margin: "0 auto",
        padding: "32px 16px",
      }}
    >
      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "1.75rem",
            fontWeight: 700,
            color: "var(--color-text-primary)",
            margin: "0 0 8px",
          }}
        >
          Buy Gammon Tokens
        </h1>
        <p
          style={{
            fontSize: "0.875rem",
            color: "var(--color-text-muted)",
            fontFamily: "var(--font-body)",
            margin: 0,
          }}
        >
          Purchase token packs with your credit card to wager on games.
        </p>
      </div>

      {/* Balance Display */}
      <div
        style={{
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border-subtle)",
          borderRadius: 12,
          padding: "16px 20px",
          marginBottom: 24,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span
          style={{
            fontSize: "0.8125rem",
            color: "var(--color-text-muted)",
            fontFamily: "var(--font-body)",
          }}
        >
          Your Balance
        </span>
        <span
          style={{
            fontSize: "1.25rem",
            fontWeight: 700,
            color: "var(--color-gold-primary)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {formatGammon(gammonBalance)} GAMMON
        </span>
      </div>

      {/* Pack Selection */}
      {pageState === "selecting" && (
        <div>
          <h2
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "1rem",
              fontWeight: 600,
              color: "var(--color-text-primary)",
              margin: "0 0 16px",
            }}
          >
            Select a Pack
          </h2>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {PACK_TIERS.map((pack) => (
              <button
                key={pack.amount}
                onClick={() => {
                  setSelectedPack(pack);
                  setPageState("checkout");
                }}
                style={{
                  background: "var(--color-bg-surface)",
                  border: "2px solid var(--color-border-subtle)",
                  borderRadius: 12,
                  padding: "20px 24px",
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  transition: "border-color 0.15s, background 0.15s",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--color-gold-primary)";
                  e.currentTarget.style.background = "var(--color-bg-elevated)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--color-border-subtle)";
                  e.currentTarget.style.background = "var(--color-bg-surface)";
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: "1.125rem",
                      fontWeight: 700,
                      color: "var(--color-text-primary)",
                      fontFamily: "var(--font-display)",
                    }}
                  >
                    {pack.label}
                  </div>
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--color-text-muted)",
                      fontFamily: "var(--font-body)",
                      marginTop: 4,
                    }}
                  >
                    Token pack NFT
                  </div>
                </div>
                <div
                  style={{
                    fontSize: "1.25rem",
                    fontWeight: 700,
                    color: "var(--color-gold-primary)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {pack.price}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Crossmint Checkout */}
      {pageState === "checkout" && selectedPack && (
        <div>
          <h2
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "1rem",
              fontWeight: 600,
              color: "var(--color-text-primary)",
              margin: "0 0 16px",
              textAlign: "center",
            }}
          >
            Complete Payment — {selectedPack.label}
          </h2>

          {CROSSMINT_CLIENT_API_KEY.startsWith("ck") || CROSSMINT_CLIENT_API_KEY.startsWith("sk") ? (
            <CrossmintProvider apiKey={CROSSMINT_CLIENT_API_KEY}>
              <CrossmintEmbeddedCheckout
                lineItems={{
                  collectionLocator: `crossmint:${CROSSMINT_COLLECTION_ID}`,
                }}
                recipient={{
                  walletAddress: userAddress,
                }}
                payment={{
                  fiat: { enabled: true },
                  crypto: { enabled: false },
                }}
                appearance={{
                  variables: {
                    colors: {
                      backgroundPrimary: "var(--color-bg-surface)",
                      textPrimary: "var(--color-text-primary)",
                      textSecondary: "var(--color-text-muted)",
                      accent: "var(--color-gold-primary)",
                    },
                    borderRadius: "8px",
                  },
                  rules: {
                    DestinationInput: {
                      display: "hidden",
                    },
                  },
                }}
              />
            </CrossmintProvider>
          ) : (
            <div
              style={{
                background: "var(--color-bg-surface)",
                border: "1px solid var(--color-border-subtle)",
                borderRadius: 12,
                padding: "32px 20px",
                textAlign: "center",
              }}
            >
              <p
                style={{
                  fontSize: "1rem",
                  fontWeight: 600,
                  color: "var(--color-text-primary)",
                  fontFamily: "var(--font-display)",
                  margin: "0 0 8px",
                }}
              >
                Coming Soon
              </p>
              <p
                style={{
                  fontSize: "0.8125rem",
                  color: "var(--color-text-muted)",
                  fontFamily: "var(--font-body)",
                  margin: 0,
                }}
              >
                Token purchases are not yet available. Check back soon!
              </p>
            </div>
          )}

          <div style={{ marginTop: 20, textAlign: "center" }}>
            <button
              onClick={() => {
                setPageState("selecting");
                setSelectedPack(null);
              }}
              style={{
                background: "none",
                border: "none",
                color: "var(--color-text-muted)",
                fontSize: "0.8125rem",
                cursor: "pointer",
                fontFamily: "var(--font-body)",
                textDecoration: "underline",
              }}
            >
              Back to pack selection
            </button>
          </div>
        </div>
      )}

      {/* Owned NFT Packs — Redeem Section */}
      {ownedTokenIds.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <h2
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "1rem",
              fontWeight: 600,
              color: "var(--color-text-primary)",
              margin: "0 0 16px",
            }}
          >
            Your Token Packs
          </h2>
          <p
            style={{
              fontSize: "0.75rem",
              color: "var(--color-text-muted)",
              fontFamily: "var(--font-body)",
              margin: "0 0 12px",
            }}
          >
            Redeem your NFT packs to receive Gammon tokens for wagering.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {ownedTokenIds.map((tokenId) => {
              const amount = parsePackAmount(tokenId);
              return (
                <div
                  key={tokenId}
                  style={{
                    background: "var(--color-bg-surface)",
                    border: "1px solid var(--color-border-subtle)",
                    borderRadius: 10,
                    padding: "14px 18px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: "0.9375rem",
                        fontWeight: 600,
                        color: "var(--color-text-primary)",
                        fontFamily: "var(--font-body)",
                      }}
                    >
                      {amount > 0 ? `${amount.toLocaleString()} GAMMON` : tokenId}
                    </div>
                    <div
                      style={{
                        fontSize: "0.6875rem",
                        color: "var(--color-text-faint)",
                        fontFamily: "var(--font-mono)",
                        marginTop: 2,
                      }}
                    >
                      {tokenId}
                    </div>
                  </div>
                  <button
                    onClick={() => redeemPack(tokenId)}
                    disabled={isRedeeming}
                    style={{
                      background: isRedeeming
                        ? "var(--color-bg-subtle)"
                        : "var(--color-gold-primary)",
                      color: isRedeeming
                        ? "var(--color-text-faint)"
                        : "var(--color-accent-fg)",
                      border: "none",
                      borderRadius: 8,
                      padding: "8px 20px",
                      fontSize: "0.8125rem",
                      fontWeight: 700,
                      cursor: isRedeeming ? "not-allowed" : "pointer",
                      fontFamily: "var(--font-body)",
                      transition: "all 0.15s",
                    }}
                  >
                    {isRedeeming ? "Redeeming..." : "Redeem"}
                  </button>
                </div>
              );
            })}
          </div>

          {redeemError && (
            <div
              style={{
                marginTop: 12,
                padding: "10px 14px",
                background: "var(--color-bg-surface)",
                border: "1px solid var(--color-danger)",
                borderRadius: 8,
                fontSize: "0.75rem",
                color: "var(--color-danger)",
                fontFamily: "var(--font-body)",
              }}
            >
              {redeemError}
            </div>
          )}

          {redeemSuccess && (
            <div
              style={{
                marginTop: 12,
                padding: "10px 14px",
                background: "var(--color-bg-surface)",
                border: "1px solid var(--color-success, #22c55e)",
                borderRadius: 8,
                fontSize: "0.75rem",
                color: "var(--color-success, #22c55e)",
                fontFamily: "var(--font-body)",
              }}
            >
              Pack redeemed! Your Gammon tokens will arrive shortly.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
