import { Hono, type Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { z } from "zod";
import { AwsAttempt, AwsRequestSchema, AwsSession } from "../cloud-work/aws-request.js";
import type { AwsService } from "../cloud-work/aws-service.js";
import type { CloudScope } from "../cloud-work/runtime-service.js";
import { publicCloudError } from "../cloud-work/public-error.js";

const Session = z.object({ session_id: AwsSession }).strict();
const Proposal = AwsRequestSchema.extend({ session_id: AwsSession });
const Start = Proposal.extend({ ownerApproved: z.literal(true), proposal: z.literal(true).optional() });
const Quality = Session.extend({ quality: z.enum(["accepted", "rejected"]) });

function isLocal(context: Context): boolean {
  try {
    const address = getConnInfo(context).remote.address?.replace(/^::ffff:/, "");
    return address === "127.0.0.1" || address === "::1";
  } catch { return false; }
}

export function cloudAwsRoutes(deps: {
  aws: AwsService;
  scope(id: string): Promise<CloudScope | null>;
  authorizeSubmit?: (id: string, scope: CloudScope) => Promise<void>;
  localRequest?: (context: Context) => boolean;
}): Hono {
  const app = new Hono();
  const localRequest = deps.localRequest ?? isLocal;
  app.onError((error, c) => c.json({ error: publicCloudError(error) }, 409));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.get("concordiaWebIdentity")) {
      if (c.req.method !== "GET" && c.req.header("sec-fetch-site") !== "same-origin") {
        return c.json({ error: "cloud_aws_owner_required" }, 403);
      }
    } else if (!localRequest(c) || ["origin", "sec-fetch-site", "forwarded", "x-forwarded-for", "x-forwarded-host",
      "cf-connecting-ip", "cf-access-jwt-assertion"].some(name => c.req.header(name) !== undefined)) {
      return c.json({ error: "cloud_aws_owner_required" }, 403);
    }
    await next();
  });

  for (const path of ["/targets", "/runs", "/runs/:id", "/proposals"] as const) {
    app.get(path, async c => {
      const sessionId = AwsSession.safeParse(c.req.query("session_id"));
      if (!sessionId.success) return c.json({ error: "invalid_cloud_request" }, 400);
      const scope = await deps.scope(sessionId.data);
      if (!scope) return c.json({ error: "cloud_active_session_required" }, 403);
      const owner = c.get("concordiaWebIdentity");
      const actor = { sessionId: sessionId.data, owner };
      if (path === "/targets") return c.json({ targets: await deps.aws.targets(scope, actor) });
      if (path === "/runs") return c.json({ runs: await deps.aws.list(scope, actor) });
      if (path === "/proposals") {
        if (!owner) return c.json({ error: "cloud_aws_owner_required" }, 403);
        return c.json({ proposals: await deps.aws.proposals(scope, { ...actor, owner }) });
      }
      const id = AwsAttempt.safeParse(c.req.param("id"));
      if (!id.success) return c.json({ error: "invalid_cloud_request" }, 400);
      return c.json(await deps.aws.status(scope, actor, id.data));
    });
  }

  app.post("/proposals", async c => {
    const parsed = Proposal.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_cloud_request" }, 400);
    const { session_id, ...input } = parsed.data;
    const scope = await deps.scope(session_id);
    if (!scope) return c.json({ error: "cloud_active_session_required" }, 403);
    return c.json(await deps.aws.propose(scope, session_id, input), 202);
  });

  app.post("/runs", async c => {
    const owner = c.get("concordiaWebIdentity");
    if (!owner) return c.json({ error: "cloud_aws_owner_required" }, 403);
    const parsed = Start.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_cloud_request" }, 400);
    const { session_id, ownerApproved: _confirmed, proposal, ...input } = parsed.data;
    const scope = await deps.scope(session_id);
    if (!scope) return c.json({ error: "cloud_active_session_required" }, 403);
    const authorize = async () => {
      const current = await deps.scope(session_id);
      if (!current || current.repositoryKey !== scope.repositoryKey || current.subsidiaryId !== scope.subsidiaryId) {
        throw new Error("cloud_active_session_required");
      }
      await deps.authorizeSubmit?.(session_id, scope);
    };
    return c.json(await deps.aws.start(scope, { sessionId: session_id, owner }, input, authorize, proposal), 202);
  });

  for (const action of ["stop", "collect", "quality"] as const) {
    app.post(`/runs/:id/${action}`, async c => {
      const id = AwsAttempt.safeParse(c.req.param("id"));
      const body: unknown = await c.req.json().catch(() => null);
      const parsed = (action === "quality" ? Quality : Session).safeParse(body);
      if (!id.success || !parsed.success) return c.json({ error: "invalid_cloud_request" }, 400);
      const scope = await deps.scope(parsed.data.session_id);
      if (!scope) return c.json({ error: "cloud_active_session_required" }, 403);
      const owner = c.get("concordiaWebIdentity"), sessionId = parsed.data.session_id;
      if (action === "stop") return c.json(await deps.aws.stop(scope, { sessionId, owner }, id.data));
      if (!owner) return c.json({ error: "cloud_aws_owner_required" }, 403);
      if (action === "collect") return c.json(await deps.aws.collect(scope, { sessionId, owner }, id.data));
      const quality = Quality.safeParse(body);
      if (!quality.success) return c.json({ error: "invalid_cloud_request" }, 400);
      return c.json(await deps.aws.quality(scope, { sessionId, owner }, id.data, quality.data.quality));
    });
  }
  return app;
}
