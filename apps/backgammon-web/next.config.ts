import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@xion-beginner/ui",
    "@xion-beginner/backgammon-core",
    "@burnt-labs/abstraxion",
  ],
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
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "worker-src 'self' blob:",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data: https://*.crossmint.com https://dynamic-static-assets.com",
              "connect-src 'self' https://*.burnt.com https://*.vercel.com https://*.vercel-storage.com ws://localhost:* wss://*.railway.app wss://*.gammon.nyc wss://api.gammon.nyc https://*.gammon.nyc https://api.gammon.nyc https://*.crossmint.com https://dynamic-static-assets.com https://gammon-server.fly.dev wss://gammon-server.fly.dev https://*.plaid.com https://cdn.plaid.com https://rpc.xion-testnet-2.burnt.com",
              "frame-src 'self' https://*.burnt.com https://*.crossmint.com",
              "form-action 'self'",
              "base-uri 'self'",
              "object-src 'none'",
            ].join("; "),
          },
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
            key: "X-XSS-Protection",
            value: "1; mode=block",
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
