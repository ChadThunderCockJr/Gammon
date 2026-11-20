import Link from "next/link";
import { sanitizeReturnTo, withReturnTo } from "@/lib/return-to";

const section: React.CSSProperties = { color: "var(--color-text-primary)", fontSize: 20, fontWeight: 600, marginTop: 32, marginBottom: 8 };
const legalLink = "inline-flex min-h-11 items-center rounded px-2 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";

export default async function PrivacyPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const { returnTo: suppliedReturnTo } = await searchParams;
  const returnTo = sanitizeReturnTo(typeof suppliedReturnTo === "string" ? suppliedReturnTo : null);
  return <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px", color: "var(--color-text-primary)", fontFamily: "system-ui, sans-serif", lineHeight: 1.7 }}>
    <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>Privacy Notice</h1>
    <nav aria-label="Legal navigation" className="mb-6 flex flex-wrap gap-1 text-sm">
      <Link className={legalLink} href={returnTo}>Return to Gammon</Link>
      <Link className={legalLink} href="/support">Support</Link>
      <Link className={legalLink} href="/responsible-play">Responsible Play</Link>
      <Link className={legalLink} href={withReturnTo("/terms", typeof suppliedReturnTo === "string" ? suppliedReturnTo : null)}>Terms of Service</Link>
    </nav>
    <p style={{ color: "var(--color-text-secondary)", marginBottom: 32 }}>Effective: March 17, 2026</p>
    <p>This notice describes information processed when you use Gammon&apos;s website or app.</p>
    <h2 style={section}>Information used for free play</h2><p>We process your public XION wallet address, authenticated session data, username, game states, moves, match results, connection metadata, and abuse-prevention signals needed to operate the service. Blockchain addresses and transactions are public by design.</p>
    <h2 style={section}>Information used only for enabled money features</h2><p>If verUSD money features are enabled and you choose to enroll, we collect the identity and contact details required by the regulated payment provider: name, date of birth, contact details, address, and identity-document details. Bank credentials are entered in the provider&apos;s Plaid flow; Gammon does not ask you to enter bank credentials directly.</p><p>We also record the consent versions and timestamps, eligibility outcomes, payment-operation status, payment-method labels, escrow and settlement references, and the minimum transaction metadata needed to reconcile a cash game. Payment payloads and provider responses are encrypted at rest by the money service.</p>
    <h2 style={section}>Recipients</h2><p>When money features are enabled, this data is processed with the configured payment provider and Plaid to verify identity, link a bank account, and execute or reconcile a requested transfer. We also use the XION network and the cash-game escrow contract for on-chain reserves and settlement. We disclose data when required by law or to prevent fraud, abuse, or security incidents.</p>
    <h2 style={section}>Cookies and sessions</h2><p>We use an HTTP-only session cookie to authenticate protected actions and a CSRF token to protect state-changing requests. These are security controls, not advertising cookies.</p>
    <h2 style={section}>Retention and choices</h2><p>We retain records for as long as necessary to run the service, resolve disputes, meet provider and legal obligations, and preserve required game and settlement evidence. You may request responsible-play restrictions through <Link href="/responsible-play">Responsible Play</Link>. To ask about your data, contact support with the wallet address associated with your request.</p>
    <h2 style={section}>Security and contact</h2><p>No system is risk-free. Use a unique wallet session and do not share credentials. For privacy requests, contact <a href="mailto:support@burnt.com" style={{ color: "var(--color-gold-primary)", textDecoration: "underline" }}>support@burnt.com</a>.</p>
  </main>;
}
