import { createHash } from "node:crypto";
import { z } from "zod";
import { DESK_BODY_MAX_CHARS, webRequestKey } from "../desk/desk-request-policy.js";
import type { DeskService } from "../desk/service.js";

const RequestSchema = z.object({
  request_id: z.string().trim().min(1).max(100),
  project: z.string().trim().min(1).max(100).optional(),
  body: z.string().min(1).max(DESK_BODY_MAX_CHARS * 4),
  provider: z.enum(["claude", "codex"]).default("claude"),
  session_id: z.string().trim().min(1).max(200).optional(),
}).strict();

export function createDeskAgentIntake(service: DeskService, isControlSession: (id: string) => boolean) {
  return (body: unknown, publicRequest: boolean) => {
    const parsed = RequestSchema.safeParse(body);
    if (!parsed.success) return { status: 400 as const, body: { error: "invalid_desk_request" } };
    const { request_id, project, session_id, provider, body: text } = parsed.data;
    if (session_id && (publicRequest || !isControlSession(session_id))) {
      return { status: 403 as const, body: { error: "control_session_required" } };
    }
    const requester = session_id ?? "dots";
    const key = createHash("sha256").update(JSON.stringify(["desk-agent", requester, request_id])).digest("hex");
    const outcome = service.submit({ requestKey: webRequestKey(key)!, requester, provider, body: text,
      ...(project === undefined ? {} : { project }) });
    if (outcome.kind === "invalid") return { status: 400 as const, body: { error: outcome.problem } };
    if (outcome.kind === "disabled") return { status: 503 as const, body: { error: "desk_disabled" } };
    if (outcome.kind === "conflict") return { status: 409 as const, body: { error: "request_id_reused" } };
    return { status: outcome.kind === "created" ? 202 as const : 200 as const, body: { request_id: outcome.request.id } };
  };
}
