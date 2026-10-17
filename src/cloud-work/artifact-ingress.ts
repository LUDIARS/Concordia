import { Hono } from "hono";
import type { ArtifactReceiver } from "./artifact-receiver.js";

/** Only artifact operations are exposed; grants are provisioned locally by Cc. */
export function artifactIngress(receiver: ArtifactReceiver, authority: string): Hono {
  const app = new Hono();
  let active = 0;
  app.all("*", async c => {
    if (c.req.header("host") !== authority || c.req.header("origin")) return c.text("Forbidden", 403);
    if (c.req.path === "/health" && c.req.method === "GET") return c.json({ service: "concordia-cloud-artifact", ok: true });
    const match = /^\/artifacts\/([A-Za-z0-9_-]{1,100})\/([A-Za-z0-9_-]{1,100})$/.exec(c.req.path);
    if (!match || !["GET", "PUT"].includes(c.req.method) || new URL(c.req.url).search) return c.text("Not found", 404);
    if (active >= 2) return c.text("Busy", 503);
    active++;
    c.header("Cache-Control", "no-store");
    try {
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "")?.[1];
      if (!token) return c.text("Unauthorized", 401);
      let grant;
      try { grant = await receiver.authorize(match[1]!, match[2]!, token); }
      catch { return c.text("Forbidden", 403); }
      if (c.req.method === "GET") return c.json(await receiver.status(grant));
      if (c.req.header("content-type") !== "application/octet-stream" || c.req.header("content-encoding")) return c.text("Unsupported content", 415);
      const length = c.req.header("content-length") ?? "";
      if (!/^[1-9][0-9]*$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > grant.maxBytes) return c.text("Invalid size", 413);
      const digest = c.req.header("x-artifact-sha256") ?? "";
      if (!/^[a-f0-9]{64}$/.test(digest) || !c.req.raw.body) return c.text("Missing digest or body", 400);
      const receipt = await receiver.receive(grant, token, Number(length), digest, c.req.raw.body);
      return c.json({ state: "received", receipt });
    } catch { return c.text("Receive incomplete; reconcile before retry", 409); }
    finally { active--; }
  });
  return app;
}
