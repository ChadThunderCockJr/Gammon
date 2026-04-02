"use client";

import { AbstraxionProvider } from "@burnt-labs/abstraxion";
import { Cinzel, Cormorant_Garamond, Josefin_Sans, JetBrains_Mono, Pinyon_Script } from "next/font/google";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { CHAIN_ID, USDC_DENOM, ESCROW_GRANT_AMOUNT, SITE_URL } from "@/lib/config";
import { ABSTRAXION_CLEANUP_KEY, ABSTRAXION_CLEANUP_VERSION, ABSTRAXION_STALE_KEYS } from "@/lib/constants";
import "./globals.css";

// One-time cleanup of stale Abstraxion state from failed auth attempts
if (typeof window !== "undefined" && window.localStorage.getItem(ABSTRAXION_CLEANUP_KEY) !== ABSTRAXION_CLEANUP_VERSION) {
  ABSTRAXION_STALE_KEYS.forEach((k) =>
    window.localStorage.removeItem(k),
  );
  // Remove any keypair data
  Object.keys(window.localStorage)
    .filter((k) => k.startsWith("xion-") || k.startsWith("abstraxion"))
    .forEach((k) => window.localStorage.removeItem(k));
  window.localStorage.setItem(ABSTRAXION_CLEANUP_KEY, ABSTRAXION_CLEANUP_VERSION);
}

const cinzel = Cinzel({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-cinzel",
  display: "swap",
});

const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-cormorant",
  display: "swap",
});

const josefinSans = Josefin_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-josefin",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jetbrains",
  display: "swap",
});

const pinyonScript = Pinyon_Script({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-pinyon",
  display: "swap",
});

const ESCROW_CONTRACT = process.env.NEXT_PUBLIC_ESCROW_CONTRACT || "";
const TREASURY_ADDRESS = process.env.NEXT_PUBLIC_TREASURY_ADDRESS || "";

const abstraxionConfig = {
  chainId: CHAIN_ID,
  treasury: TREASURY_ADDRESS || "xion1dlm2vellmpau54yd7vywvesvvhu6wnx4vtfzkk8jkzd6yrfvc0hq6l8lu7",
  // Explicit empty bank prevents SDK fallback bank config with broken "0.1" amount
  bank: [] as { denom: string; amount: string }[],
  ...(ESCROW_CONTRACT
    ? {
        contracts: [
          {
            address: ESCROW_CONTRACT,
            amounts: [{ denom: USDC_DENOM, amount: ESCROW_GRANT_AMOUNT }],
          },
        ],
      }
    : {}),
  authentication: {
    type: 'redirect' as const,
    callbackUrl: typeof window !== 'undefined' ? window.location.origin : undefined,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <title>Gammon</title>
        <meta name="description" content="The world's fairest backgammon platform. Provably fair dice on the blockchain." />
        <meta name="theme-color" content="#F5F1EB" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta property="og:title" content="Gammon" />
        <meta property="og:description" content="The world's fairest backgammon platform. Provably fair dice on the blockchain." />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={SITE_URL} />
        <meta property="og:image" content={`${SITE_URL}/logo.png`} />
        <meta property="og:image:width" content="512" />
        <meta property="og:image:height" content="512" />
        <meta property="og:image:alt" content="Gammon — The world's fairest backgammon platform" />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:image" content={`${SITE_URL}/logo.png`} />
        {/* GNUBG WASM is lazy-loaded on game pages only (via gnubg.ts ensureWorker) */}
        {/* Inline script to set theme class before first paint — prevents flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("gammon-theme");document.documentElement.className=t==="lux"?"lux":t==="dark"?"dark":"light"}catch(e){}})()`,
          }}
        />
      </head>
      <body
        className={`${cinzel.variable} ${cormorant.variable} ${josefinSans.variable} ${jetbrainsMono.variable} ${pinyonScript.variable} antialiased`}
      >
        <ThemeProvider>
          <AbstraxionProvider config={abstraxionConfig}>
            {children}
          </AbstraxionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
