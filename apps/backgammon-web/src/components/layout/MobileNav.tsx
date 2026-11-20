"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icons } from "./Sidebar";
import { useIsNativeApp } from "@/hooks/useIsNativeApp";

const tabs = [
  { href: "/", label: "Home", icon: Icons.home, native: true },
  { href: "/matchmaking", label: "Find opponent", icon: Icons.play, native: true },
  { href: "/social", label: "Social", icon: Icons.users, native: true },
  { href: "/wallet", label: "Balance", icon: Icons.wallet, native: false },
  { href: "/profile", label: "More", icon: Icons.settings, native: true },
] as const;

export function MobileNav() {
  const pathname = usePathname();
  const isNativeApp = useIsNativeApp();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <nav
      role="navigation"
      aria-label="Main navigation"
      className="fixed bottom-0 left-0 right-0 z-50 flex lg:hidden bg-bg-base border-t border-border-subtle"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {tabs.filter((tab) => tab.native || !isNativeApp).map(({ href, label, icon }) => {
        const active = isActive(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className="flex flex-1 flex-col items-center justify-center gap-1"
            style={{
              minHeight: 44,
              minWidth: 44,
              padding: "8px 0 4px",
              color: active
                ? "var(--color-gold-primary)"
                : "var(--color-text-muted)",
              textDecoration: "none",
              fontSize: "0.625rem",
              fontWeight: active ? 600 : 400,
              fontFamily: "var(--font-body)",
              transition: "color 0.12s ease",
            }}
          >
            <span style={{ display: "flex", opacity: active ? 1 : 0.6 }}>
              {icon(
                active
                  ? "var(--color-gold-primary)"
                  : "var(--color-text-muted)"
              )}
            </span>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
