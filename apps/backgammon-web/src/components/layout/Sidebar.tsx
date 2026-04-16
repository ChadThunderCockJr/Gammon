"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useSocialContext } from "@/contexts/SocialContext";
import { useIsNativeApp } from "@/hooks/useIsNativeApp";

// ── Icons ──────────────────────────────────────────────────────

export const Icons = {
  home: (c: string) => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke={c} strokeWidth="1.5">
      <path d="M3 10l7-7 7 7M5 8.5V16a1 1 0 001 1h3v-4h2v4h3a1 1 0 001-1V8.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  play: (c: string) => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke={c} strokeWidth="1.5">
      <circle cx="10" cy="10" r="7" />
      <path d="M8.5 7.5l4 2.5-4 2.5V7.5z" fill={c} stroke="none" />
    </svg>
  ),
  trophy: (c: string) => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke={c} strokeWidth="1.5">
      <path d="M6 3h8v5a4 4 0 01-8 0V3zM6 5H4a1 1 0 00-1 1v1a3 3 0 003 3M14 5h2a1 1 0 011 1v1a3 3 0 01-3 3M8 13h4M10 13v3M7 16h6" strokeLinecap="round" />
    </svg>
  ),
  chart: (c: string) => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke={c} strokeWidth="1.5">
      <path d="M3 17V8l4 3 3-6 4 4 3-4v12H3z" strokeLinejoin="round" />
    </svg>
  ),
  brain: (c: string) => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke={c} strokeWidth="1.5">
      <circle cx="10" cy="10" r="7" />
      <path d="M7 10c0-1.5 1.3-3 3-3s3 1.5 3 3M8 12.5c.6.5 1.3.8 2 .8s1.4-.3 2-.8" strokeLinecap="round" />
    </svg>
  ),
  users: (c: string) => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke={c} strokeWidth="1.5">
      <circle cx="8" cy="7" r="2.5" /><path d="M3 16c0-2.8 2.2-5 5-5s5 2.2 5 5" />
      <circle cx="14" cy="7" r="2" /><path d="M14 12c2.2 0 4 1.8 4 4" strokeLinecap="round" />
    </svg>
  ),
  wallet: (c: string) => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke={c} strokeWidth="1.5">
      <rect x="2" y="5" width="16" height="11" rx="2" /><path d="M14 10.5a1 1 0 100 2 1 1 0 000-2z" fill={c} /><path d="M2 8h16" />
    </svg>
  ),
  settings: (c: string) => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke={c} strokeWidth="1.5">
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 3v2M10 15v2M17 10h-2M5 10H3M14.95 5.05l-1.41 1.41M6.46 13.54l-1.41 1.41M14.95 14.95l-1.41-1.41M6.46 6.46L5.05 5.05" strokeLinecap="round" />
    </svg>
  ),
};

// ── Nav Item ───────────────────────────────────────────────────

function NavItem({
  icon,
  label,
  href,
  active,
  badge,
}: {
  icon: (c: string) => React.ReactNode;
  label: string;
  href: string;
  active: boolean;
  badge?: string;
}) {
  const [h, setH] = useState(false);
  return (
    <Link
      href={href}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 16px",
        width: "100%",
        background: active
          ? "var(--color-gold-muted)"
          : h
            ? "var(--color-burgundy-faint)"
            : "transparent",
        border: "none",
        borderRadius: 6,
        cursor: "pointer",
        color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
        fontSize: "0.875rem",
        fontWeight: active ? 600 : 400,
        fontFamily: "var(--font-body)",
        transition: "all 0.12s ease",
        textAlign: "left",
        borderLeft: active
          ? "2px solid var(--color-gold-primary)"
          : "2px solid transparent",
        textDecoration: "none",
      }}
    >
      <span style={{ display: "flex", opacity: active ? 1 : 0.7 }}>
        {icon(active ? "var(--color-text-primary)" : "var(--color-text-secondary)")}
      </span>
      {label}
      {badge && (
        <span
          style={{
            marginLeft: "auto",
            background: "var(--color-bg-subtle)",
            color: "var(--color-burgundy-light)",
            borderRadius: 10,
            padding: "2px 8px",
            fontSize: "0.6875rem",
            fontWeight: 600,
          }}
        >
          {badge}
        </span>
      )}
    </Link>
  );
}

// ── Sidebar Avatar ─────────────────────────────────────────────

function SidebarAvatar({ size = 36, name }: { size?: number; name: string }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--color-bg-elevated)",
        border: "2px solid var(--color-gold-primary)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.38,
        fontWeight: 700,
        color: "var(--color-text-secondary)",
        fontFamily: "var(--font-display)",
        flexShrink: 0,
        position: "relative",
      }}
    >
      {name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          right: 0,
          width: size * 0.28,
          height: size * 0.28,
          borderRadius: "50%",
          background: "var(--color-success)",
          border: "2px solid var(--color-bg-surface)",
        }}
      />
    </div>
  );
}

// ── Main Sidebar ───────────────────────────────────────────────

export function Sidebar() {
  const pathname = usePathname();
  const { displayName, username } = useSocialContext();
  const userLabel = displayName || username || "Player";
  const isNativeApp = useIsNativeApp();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <aside
      className="hidden lg:flex"
      style={{
        width: 240,
        background: "var(--color-bg-base)",
        flexDirection: "column",
        padding: "20px 12px",
        flexShrink: 0,
        borderRight: "1px solid var(--color-border-subtle)",
        height: "100dvh",
        position: "sticky",
        top: 0,
      }}
    >
      {/* Brand */}
      <Link
        href="/"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "4px 16px 24px",
          textDecoration: "none",
          cursor: "pointer",
        }}
      >
        <img
          src="/logo-transparent.png"
          alt="Gammon"
          style={{
            width: 36,
            height: 36,
            objectFit: "contain",
          }}
        />
        <span
          className="font-brand"
          style={{
            color: "var(--color-text-primary)",
            fontSize: "1.3125rem",
            fontWeight: 700,
            fontFamily: "var(--font-display)",
            letterSpacing: "-0.02em",
          }}
        >
          Gammon
        </span>
      </Link>

      {/* Primary Navigation */}
      <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <NavItem icon={Icons.home} label="Home" href="/" active={isActive("/")} />
        <NavItem icon={Icons.play} label="Play" href="/matchmaking" active={isActive("/matchmaking")} />
        <NavItem icon={Icons.trophy} label="Tournaments" href="/tournaments" active={isActive("/tournaments")} />
        <NavItem icon={Icons.users} label="Social" href="/social" active={isActive("/social")} />
        {!isNativeApp && (
          <NavItem icon={Icons.wallet} label="Wallet" href="/wallet" active={isActive("/wallet")} />
        )}
      </nav>

      <div
        style={{
          height: 1,
          background: "var(--color-border-subtle)",
          margin: "16px 12px",
        }}
      />

      {/* Secondary Navigation */}
      <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <NavItem icon={Icons.settings} label="Settings" href="/settings" active={isActive("/settings")} />
      </nav>

      {/* User Card */}
      <div
        style={{
          marginTop: "auto",
          padding: "16px 16px 8px",
          borderTop: "1px solid var(--color-border-subtle)",
        }}
      >
        <Link
          href="/profile"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            textDecoration: "none",
          }}
        >
          <SidebarAvatar size={36} name={userLabel} />
          <div>
            <div
              style={{
                fontSize: "0.8125rem",
                fontWeight: 600,
                color: "var(--color-text-primary)",
              }}
            >
              {userLabel}
            </div>
            <div
              style={{
                fontSize: "0.75rem",
                color: "var(--color-text-muted)",
                fontFamily: "var(--font-mono)",
                fontWeight: 500,
              }}
            >
              1,847
            </div>
          </div>
        </Link>
      </div>
    </aside>
  );
}
