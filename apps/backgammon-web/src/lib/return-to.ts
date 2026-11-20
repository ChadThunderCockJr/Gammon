const INTERNAL_ORIGIN = "https://gammon.invalid";

/** Returns a path-and-query target that cannot navigate away from this origin. */
export function sanitizeReturnTo(value: string | null | undefined): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001F\u007F]/.test(value) ||
    /%(?![0-9A-Fa-f]{2})/.test(value)
  ) {
    return "/";
  }

  try {
    const destination = new URL(value, INTERNAL_ORIGIN);
    if (destination.origin !== INTERNAL_ORIGIN || !destination.pathname.startsWith("/") || destination.pathname.startsWith("//")) {
      return "/";
    }
    return `${destination.pathname}${destination.search}`;
  } catch {
    return "/";
  }
}

/** Adds a validated return target to an internal route when one was supplied. */
export function withReturnTo(pathname: string, returnTo: string | null | undefined): string {
  return returnTo ? `${pathname}?returnTo=${encodeURIComponent(sanitizeReturnTo(returnTo))}` : pathname;
}
