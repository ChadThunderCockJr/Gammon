import Link from "next/link";
import { sanitizeReturnTo, withReturnTo } from "@/lib/return-to";

const section: React.CSSProperties = { color: "var(--color-text-primary)", fontSize: 20, fontWeight: 600, marginTop: 32, marginBottom: 8 };
const legalLink = "inline-flex min-h-11 items-center rounded px-2 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";

export default async function TermsPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const { returnTo: suppliedReturnTo } = await searchParams;
  const returnTo = sanitizeReturnTo(typeof suppliedReturnTo === "string" ? suppliedReturnTo : null);
  return <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px", color: "var(--color-text-primary)", fontFamily: "system-ui, sans-serif", lineHeight: 1.7 }}>
    <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>Terms of Service</h1>
    <nav aria-label="Legal navigation" className="mb-6 flex flex-wrap gap-1 text-sm">
      <Link className={legalLink} href={returnTo}>Return to Gammon</Link>
      <Link className={legalLink} href="/support">Support</Link>
      <Link className={legalLink} href="/responsible-play">Responsible Play</Link>
      <Link className={legalLink} href={withReturnTo("/privacy", typeof suppliedReturnTo === "string" ? suppliedReturnTo : null)}>Privacy Notice</Link>
    </nav>
    <p style={{ color: "var(--color-text-secondary)", marginBottom: 32 }}>Effective: March 17, 2026</p>
    <p>These terms govern Gammon&apos;s free backgammon service. Do not use the service if you do not agree to them.</p>
    <h2 style={section}>Free play</h2><p>Free matches do not create a wager, deposit, prize, or transfer of value. Features shown as free play must remain free even when a wallet is connected.</p>
    <h2 style={section}>Wallets and access</h2><p>A XION wallet is used to authenticate and sign actions. You are responsible for protecting your wallet and reviewing every wallet prompt. We cannot reverse a blockchain transaction solely because it was signed by your wallet.</p>
    <h2 style={section}>Cash-game availability</h2><p>verUSD cash games are disabled unless the service has enabled its required provider, operational, jurisdiction, eligibility, responsible-play, and escrow controls. Availability on one deployment does not mean it is available to you. Before a cash-game offer, we display its stake, maximum reserve, cube cap, rake, expiry, and exact quote hash. Each player must independently accept those terms and fund their own reserve.</p>
    <p>Cash-game participation may be restricted, suspended, reviewed, refunded, or settled according to the disclosed game rules, the escrow contract, provider requirements, and applicable law. A cash-game screen is not an offer where eligibility or required controls are unavailable.</p>
    <h2 style={section}>Responsible play</h2><p>Do not play with money you cannot afford to lose. Cash-game controls, when available, include cooling-off, self-exclusion, and spending-limit requests. See <Link href="/responsible-play">Responsible Play</Link> before participating.</p>
    <h2 style={section}>Fair play and game records</h2><p>Do not use automation, cheating tools, harassment, or abuse. We may restrict service access to protect players and the service. Game events and, when applicable, dice commitments and proofs are recorded so that a completed game can be reviewed.</p>
    <h2 style={section}>Service status and changes</h2><p>The service can be unavailable, and an operation remains pending until its recorded status is complete. We may change or discontinue free-play features. Material cash-game terms are accepted per offer rather than inferred from continued use.</p>
    <h2 style={section}>Contact</h2><p>For account, game, or cash-game support, contact <a href="mailto:support@burnt.com" style={{ color: "var(--color-gold-primary)", textDecoration: "underline" }}>support@burnt.com</a>.</p>
  </main>;
}
