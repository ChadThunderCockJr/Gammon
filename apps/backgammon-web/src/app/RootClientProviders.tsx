"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AbstraxionProvider } from "@burnt-labs/abstraxion";
import { ThemeProvider } from "@/contexts/ThemeContext";
import {
  CHAIN_ID,
  CLIENT_FUNDS_CONFIGURED,
  FINANCE_AUTHORIZATION_CONTRACT,
  FINANCE_AUTHORIZATION_GRANT_AMOUNT_MICRO_USD,
  ESCROW_GRANT_AMOUNT_MICRO_USD,
  VERUSD_DENOM,
  VERUSD_ESCROW_CONTRACT,
} from "@/lib/config";
import {
  ABSTRAXION_CLEANUP_KEY,
  ABSTRAXION_CLEANUP_VERSION,
  ABSTRAXION_STALE_KEYS,
} from "@/lib/constants";
import { routeName } from "@/lib/route-metadata";

const TREASURY_ADDRESS = process.env.NEXT_PUBLIC_TREASURY_ADDRESS || "";
const DEFAULT_TREASURY = "xion1dlm2vellmpau54yd7vywvesvvhu6wnx4vtfzkk8jkzd6yrfvc0hq6l8lu7";


export function RootClientProviders({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const currentRouteName = routeName(pathname);
  const [routeAnnouncement, setRouteAnnouncement] = useState("");
  const abstraxionCallbackUrl = typeof window === "undefined"
    ? undefined
    : `${window.location.origin}/login`;
  const abstraxionConfig = useMemo(() => ({
    chainId: CHAIN_ID,
    treasury: TREASURY_ADDRESS || DEFAULT_TREASURY,
    bank: [] as { denom: string; amount: string }[],
    ...(CLIENT_FUNDS_CONFIGURED &&
      VERUSD_ESCROW_CONTRACT &&
      VERUSD_DENOM &&
      ESCROW_GRANT_AMOUNT_MICRO_USD &&
      FINANCE_AUTHORIZATION_CONTRACT &&
      FINANCE_AUTHORIZATION_GRANT_AMOUNT_MICRO_USD
      ? {
          contracts: [
            {
              address: VERUSD_ESCROW_CONTRACT,
              amounts: [{ denom: VERUSD_DENOM, amount: ESCROW_GRANT_AMOUNT_MICRO_USD }],
            },
            {
              address: FINANCE_AUTHORIZATION_CONTRACT,
              amounts: [{ denom: VERUSD_DENOM, amount: FINANCE_AUTHORIZATION_GRANT_AMOUNT_MICRO_USD }],
            },
          ],
        }
      : {}),
    authentication: {
      type: "redirect" as const,
      callbackUrl: abstraxionCallbackUrl,
    },
  }), [abstraxionCallbackUrl]);

  useEffect(() => {
    if (window.localStorage.getItem(ABSTRAXION_CLEANUP_KEY) === ABSTRAXION_CLEANUP_VERSION) return;
    ABSTRAXION_STALE_KEYS.forEach((key) => window.localStorage.removeItem(key));
    Object.keys(window.localStorage)
      .filter((key) => key.startsWith("xion-") || key.startsWith("abstraxion"))
      .forEach((key) => window.localStorage.removeItem(key));
    window.localStorage.setItem(ABSTRAXION_CLEANUP_KEY, ABSTRAXION_CLEANUP_VERSION);
  }, []);

  useEffect(() => {

    const focusRouteHeading = () => {
      const heading = document.querySelector<HTMLElement>("h1");
      if (!heading) return false;

      const announcement = heading.textContent?.replace(/\s+/g, " ").trim() || currentRouteName;
      setRouteAnnouncement(announcement);
      if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      return true;
    };

    let observer: MutationObserver | undefined;
    const frame = window.requestAnimationFrame(() => {
      if (focusRouteHeading()) return;

      observer = new MutationObserver(() => {
        if (focusRouteHeading()) observer?.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });

    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [currentRouteName]);

  return (
    <>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{routeAnnouncement}</div>
      <ThemeProvider>
        <AbstraxionProvider config={abstraxionConfig}>
          {children}
        </AbstraxionProvider>
      </ThemeProvider>
    </>
  );
}
