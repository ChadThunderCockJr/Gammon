import type { SessionRecord } from "./session.js";

const XION_ADDRESS = /^xion1[023456789acdefghjklmnpqrstuvwxyz]{38,64}$/;

/**
 * Moderation is an explicit production allowlist, never an implicit session
 * capability. Authz delegates cannot exercise an operator's moderation role.
 */
export function requireModerator(session: SessionRecord | undefined): string {
  const configured = process.env.MODERATION_OPERATOR_PRINCIPALS ?? "";
  const allowedPrincipals = new Set(
    configured
      .split(",")
      .map((principal) => principal.trim())
      .filter((principal) => XION_ADDRESS.test(principal)),
  );
  if (!session || session.principal !== session.signer || !allowedPrincipals.has(session.principal)) {
    throw new Error("MODERATION_AUTHORIZATION_REQUIRED");
  }
  return session.principal;
}
