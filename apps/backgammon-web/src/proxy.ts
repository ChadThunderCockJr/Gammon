import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDevelopment = process.env.NODE_ENV === "development";
  const sandboxConnect = isDevelopment && process.env.NEXT_PUBLIC_E2E_SANDBOX === "1"
    ? " http://127.0.0.1:3422 ws://127.0.0.1:3422"
    : "";
  const policy = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval' blob: https://cdn.plaid.com${isDevelopment ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "worker-src 'self' blob:",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' http://localhost:* ws://localhost:* https://*.burnt.com https://*.vercel.com https://*.vercel-storage.com https://*.plaid.com https://cdn.plaid.com https://*.gammon.nyc wss://*.gammon.nyc https://gammon-server.fly.dev wss://gammon-server.fly.dev wss://*.railway.app${sandboxConnect}`,
    "frame-src 'self' https://*.burnt.com https://*.plaid.com",
    ...(isDevelopment ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("x-gammon-pathname", request.nextUrl.pathname);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|manifest.json|gnubg).*)"],
};
