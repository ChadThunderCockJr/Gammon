import { NextResponse } from "next/server";

const SERVER_URL = process.env.NEXT_PUBLIC_WS_URL
  ? process.env.NEXT_PUBLIC_WS_URL.trim().replace(/^ws(s?):/, "http$1:").replace(/\/ws\s*$/, "").replace(/\/+$/, "")
  : "http://localhost:3001";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const res = await fetch(`${SERVER_URL}/api/brale/plaid-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: "Server unreachable" }, { status: 502 });
  }
}
