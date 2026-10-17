import { Hono } from "hono";
import type { ArtifactReceiver } from "../cloud-work/artifact-receiver.js";
import type { ObservationStore } from "./store.js";

/** Same run-scoped grant as artifact upload; no Discord destination or answer-writing route. */
export function observationIngress(receiver: ArtifactReceiver, store: ObservationStore,
  authority: string, now: () => number = Date.now): Hono {
  const app = new Hono();
  let active = 0;
  app.all("*", async c => {
    if (c.req.header("host") !== authority || c.req.header("origin")) return c.text("Forbidden", 403);
    c.header("Cache-Control", "no-store");
    const match = /^\/observations\/([A-Za-z0-9_-]{1,100})\/([A-Za-z0-9_-]{1,100})(?:\/previews\/([A-Za-z0-9_-]{1,100}))?$/.exec(c.req.path);
    if (!match || new URL(c.req.url).search || !["GET", "PUT"].includes(c.req.method)) return c.text("Not found", 404);
    if (active >= 2) return c.text("Busy", 503);
    active++;
    try {
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "")?.[1];
      if (!token) return c.text("Unauthorized", 401);
      try { await receiver.authorize(match[1]!, match[2]!, token); }
      catch { return c.text("Forbidden", 403); }
      if (c.req.method === "GET") {
        if (match[3]) return c.text("Not found", 404);
        return c.json(store.get(match[1]!, match[2]!) ?? { state: "unobserved" });
      }
      const limit = match[3] ? 8 * 1024 * 1024 : 8192;
      const length = c.req.header("content-length") ?? "";
      if (!/^[1-9][0-9]*$/.test(length) || Number(length) > limit || c.req.header("content-encoding")) return c.text("Invalid size", 413);
      if (c.req.header("content-type") !== (match[3] ? "application/octet-stream" : "application/json")) return c.text("Unsupported content", 415);
      // Stream the bounded body; Content-Length alone does not constrain malicious clients.
      const reader = c.req.raw.body?.getReader();
      if (!reader) return c.text("Missing body", 400);
      const chunks: Buffer[] = []; let size = 0;
      const timer = setTimeout(() => { void reader.cancel().catch(() => { /* disconnected client */ }); }, 10000);
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.length; if (size > limit || size > Number(length)) throw new Error("body_too_large");
          chunks.push(Buffer.from(part.value));
        }
      } finally { clearTimeout(timer); await reader.cancel().catch(() => { /* consumed/disconnected body */ }); reader.releaseLock(); }
      if (size !== Number(length)) return c.text("Incomplete body", 400);
      const bytes = Buffer.concat(chunks);
      if (match[3]) { store.savePreview(match[1]!, match[2]!, match[3], bytes); return c.json({ received: true }); }
      return c.json(store.receive(match[1]!, match[2]!, JSON.parse(bytes.toString("utf8")), now()));
    } catch { return c.text("Observation rejected; reconcile state before retry", 409); }
    finally { active--; }
  });
  return app;
}
