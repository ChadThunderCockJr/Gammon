import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

const sandboxFixturesEnabled = process.env.NODE_ENV === "development"
  && process.env.NEXT_PUBLIC_E2E_SANDBOX === "1";
const sandboxAliases: Record<string, string> = {
  "@burnt-labs/abstraxion": fileURLToPath(new URL("./src/test-fixtures/abstraxion.tsx", import.meta.url)),
  "@/lib/plaid-link": fileURLToPath(new URL("./src/test-fixtures/plaid-link.ts", import.meta.url)),
};

const nextConfig: NextConfig = {
  turbopack: {
    root: workspaceRoot,
    ...(sandboxFixturesEnabled ? { resolveAlias: sandboxAliases } : {}),
  },
  transpilePackages: [
    "@xion-beginner/ui",
    "@xion-beginner/backgammon-core",
    "@burnt-labs/abstraxion",
  ],
  webpack(config) {
    if (!sandboxFixturesEnabled) return config;
    config.resolve ??= {};
    config.resolve.alias = {
      ...(config.resolve.alias as Record<string, string> | undefined),
      ...sandboxAliases,
      [fileURLToPath(new URL("./src/lib/plaid-link", import.meta.url))]: sandboxAliases["@/lib/plaid-link"],
      [fileURLToPath(new URL("./src/lib/plaid-link.ts", import.meta.url))]: sandboxAliases["@/lib/plaid-link"],
    };
    return config;
  },
  async headers() {
    return [
      {
        // Long cache for GNUBG WASM (versioned filename gbweb.1.wasm)
        source: "/gnubg/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "geolocation=(), camera=(), microphone=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
