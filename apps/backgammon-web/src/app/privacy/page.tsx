import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — Gammon",
};

export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px", color: "#1a1a2e", fontFamily: "system-ui, sans-serif", lineHeight: 1.7 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>Privacy Policy</h1>
      <p style={{ color: "#666", marginBottom: 32 }}>Last updated: March 17, 2026</p>

      <p>
        Gammon (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) operates the Gammon mobile application and website
        (gammon.nyc). This page informs you of our policies regarding the collection, use, and
        disclosure of personal information when you use our Service.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32, marginBottom: 8 }}>Information We Collect</h2>
      <p>
        <strong>Blockchain Address.</strong> When you use Gammon, you provide your XION blockchain
        wallet address. This is a public blockchain identifier and is not personally identifiable
        information on its own.
      </p>
      <p>
        <strong>Game Data.</strong> We store game states, moves, dice rolls, and match results on
        our servers for the duration of active games. Dice roll proofs are retained so players can
        independently verify fairness.
      </p>
      <p>
        <strong>Connection Data.</strong> We collect standard server logs (IP address, connection
        timestamps) for security and abuse prevention. These logs are automatically deleted after
        30 days.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32, marginBottom: 8 }}>Information We Do Not Collect</h2>
      <ul style={{ paddingLeft: 24 }}>
        <li>We do not collect your name, email address, or phone number.</li>
        <li>We do not use analytics or tracking SDKs.</li>
        <li>We do not use cookies for advertising or tracking purposes.</li>
        <li>We do not sell or share your information with third parties.</li>
      </ul>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32, marginBottom: 8 }}>How We Use Your Information</h2>
      <ul style={{ paddingLeft: 24 }}>
        <li>To provide and maintain the game service</li>
        <li>To match you with other players</li>
        <li>To verify dice roll fairness using drand distributed randomness</li>
        <li>To prevent abuse and enforce fair play</li>
      </ul>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32, marginBottom: 8 }}>Data Retention</h2>
      <p>
        Active game data is stored for the duration of the game session. Completed game results
        and dice proofs may be retained indefinitely to support fairness verification. Server logs
        are deleted after 30 days.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32, marginBottom: 8 }}>Third-Party Services</h2>
      <p>
        Gammon uses <strong>drand</strong> (League of Entropy) for verifiable random number
        generation. Drand is a decentralized randomness beacon and does not receive any user data
        from our application.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32, marginBottom: 8 }}>Children&apos;s Privacy</h2>
      <p>
        Our Service does not address anyone under the age of 13. We do not knowingly collect
        personal information from children under 13.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32, marginBottom: 8 }}>Changes to This Policy</h2>
      <p>
        We may update this Privacy Policy from time to time. We will notify you of any changes by
        posting the new Privacy Policy on this page and updating the &quot;Last updated&quot; date.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32, marginBottom: 8 }}>Contact Us</h2>
      <p>
        If you have any questions about this Privacy Policy, please contact us at{" "}
        <a href="mailto:support@burnt.com" style={{ color: "#7b2d3f" }}>support@burnt.com</a>.
      </p>
    </main>
  );
}
