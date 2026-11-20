const STATIC_ROUTE_NAMES: Readonly<Record<string, string>> = {
  "/": "Home",
  "/login": "Sign in",
  "/ai-match": "Free AI match",
  "/create-match": "Choose a match",
  "/matchmaking": "Free match queue",
  "/join": "Join a match",
  "/wallet": "Balance and payments",
  "/activity": "Account activity",
  "/responsible-play": "Responsible play",
  "/tournaments": "Tournaments",
  "/social": "Friends and challenges",
  "/leaderboard": "Leaderboard",
  "/profile": "Profile",
  "/settings": "Settings",
  "/verify-rolls": "Verify dice rolls",
  "/support": "Support and complaints",
  "/terms": "Terms of Service",
  "/privacy": "Privacy Notice",
};

export function routeName(pathname: string): string {
  if (/^\/match\/[^/]+\/analysis$/.test(pathname)) return "Match analysis";
  if (/^\/match\/[^/]+$/.test(pathname)) return "Live match";
  if (/^\/game\/[^/]+\/audit$/.test(pathname)) return "Game fairness audit";
  if (/^\/join\/[^/]+$/.test(pathname)) return "Invite review";
  if (/^\/profile\/[^/]+$/.test(pathname)) return "Player profile";
  return STATIC_ROUTE_NAMES[pathname] ?? "Page not found";
}

export function routeTitle(pathname: string): string {
  return `${routeName(pathname)} — Gammon`;
}
