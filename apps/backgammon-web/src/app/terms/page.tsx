import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service — Gammon",
};

export default function TermsPage() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px", color: "#1a1a2e", fontFamily: "system-ui, sans-serif", lineHeight: 1.7 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>Terms of Service</h1>
      <p style={{ color: "#666", marginBottom: 32 }}>Last updated: March 17, 2026</p>

      <p>
        By using Gammon (&quot;the Service&quot;), you agree to these Terms of Service. If you do
        not agree, do not use the Service.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32, marginBottom: 8 }}>Use of Service</h2>
      <p>
        Gammon is an online backgammon platform. You may use it to play backgammon against other
        players. You must not use the Service for any unlawful purpose or in any way that could
        damage, disable, or impair the Service.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32, marginBottom: 8 }}>Accounts</h2>
      <p>
        Access to Gammon requires a XION blockchain wallet address. You are responsible for
        maintaining the security of your wallet. We are not responsible for any loss resulting from
        unauthorized access to your wallet.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32, marginBottom: 8 }}>Fair Play</h2>
      <p>
        You agree not to use bots, automated scripts, or any form of cheating. We reserve the
        right to suspend or terminate access for any player engaged in unfair play or abuse.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32, marginBottom: 8 }}>Dice Fairness</h2>
      <p>
        All dice rolls are generated using drand (League of Entropy) distributed randomness and
        are independently verifiable. We do not control or manipulate dice outcomes.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32, marginBottom: 8 }}>Limitation of Liability</h2>
      <p>
        The Service is provided &quot;as is&quot; without warranties of any kind. Thames Brook
        Associates, LLC shall not be liable for any indirect, incidental, special, or
        consequential damages arising from your use of the Service.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32, marginBottom: 8 }}>Changes</h2>
      <p>
        We may modify these Terms at any time. Continued use of the Service after changes
        constitutes acceptance of the updated Terms.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32, marginBottom: 8 }}>Contact</h2>
      <p>
        Questions about these Terms? Contact us at{" "}
        <a href="mailto:support@burnt.com" style={{ color: "#7b2d3f" }}>support@burnt.com</a>.
      </p>
    </main>
  );
}
