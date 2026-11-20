import express, { type Request, type Response } from "express";
import { z } from "zod";
import { requireModerator } from "./moderation-auth.js";
import {
  claimModerationReport,
  listModerationReports,
  resolveModerationReport,
} from "./social-store-pg.js";
import { requireCsrf, requireSession, type AuthenticatedRequest } from "./session.js";

export const moderationRouter = express.Router();

const ListReports = z.object({
  state: z.enum(["open", "investigating", "resolved", "closed"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
const ResolveReport = z.object({
  resolutionCode: z.enum(["action_taken", "no_action", "duplicate", "insufficient_evidence"]),
}).strict();
const ReportId = z.string().uuid();

function sessionForModerator(request: Request): string {
  return requireModerator((request as AuthenticatedRequest).session);
}

function moderationError(response: Response, error: unknown): void {
  const code = error instanceof Error ? error.message : "moderation_unavailable";
  if (code === "MODERATION_AUTHORIZATION_REQUIRED") {
    response.status(403).json({ error: "moderation_authorization_required" });
    return;
  }
  if (code === "REPORT_NOT_FOUND") {
    response.status(404).json({ error: "report_not_found" });
    return;
  }
  if (code === "REPORT_NOT_CLAIMABLE" || code === "REPORT_NOT_RESOLVABLE") {
    response.status(409).json({ error: "report_state_conflict" });
    return;
  }
  if (error instanceof z.ZodError) {
    response.status(400).json({ error: "invalid_moderation_request" });
    return;
  }
  response.status(503).json({ error: "moderation_unavailable" });
}

moderationRouter.use(requireSession);

moderationRouter.get("/reports", async (request, response) => {
  try {
    sessionForModerator(request);
    const query = ListReports.parse(request.query);
    response.json({ reports: await listModerationReports(query) });
  } catch (error) {
    moderationError(response, error);
  }
});

moderationRouter.post("/reports/:reportId/claim", requireCsrf, async (request, response) => {
  try {
    const moderator = sessionForModerator(request);
    const report = await claimModerationReport(ReportId.parse(request.params.reportId), moderator);
    response.json({ report });
  } catch (error) {
    moderationError(response, error);
  }
});

moderationRouter.post("/reports/:reportId/resolve", requireCsrf, async (request, response) => {
  try {
    const moderator = sessionForModerator(request);
    const body = ResolveReport.parse(request.body);
    const report = await resolveModerationReport(
      ReportId.parse(request.params.reportId),
      moderator,
      body.resolutionCode,
    );
    response.json({ report });
  } catch (error) {
    moderationError(response, error);
  }
});
