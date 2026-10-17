import { Hono } from "hono";
import type { CfAccessVerifier } from "../management/cf-access.js";
import type { GitRunGrants } from "./git-run-grant.js";
import type { CloudGitReceiver } from "./git-receiver.js";

export interface CloudGitIngressPorts {
  publicHost: string;
  access: Pick<CfAccessVerifier, "verify">;
  grants: GitRunGrants;
  receiver: CloudGitReceiver;
  now(): number;
}

/** Dedicated ingress: no Cc management/session endpoints are mounted here. */
export function cloudGitIngress(ports: CloudGitIngressPorts): Hono {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/i.test(ports.publicHost)) throw new Error("cloud_git_public_host_invalid");
  const app = new Hono();
  let active = 0;
  app.all("*", async c => {
    if (c.req.header("host")?.toLowerCase() !== ports.publicHost.toLowerCase()) return c.text("Forbidden", 403);
    if (active >= 2) return c.text("Busy", 503);
    active++;
    try {
      if (!await ports.access.verify(c.req.header("cf-access-jwt-assertion"))) return c.text("Forbidden", 403);
      const match = /^\/git\/([A-Za-z0-9_-]{1,100})\/([A-Za-z0-9_-]{1,100})\.git\/(info\/refs|git-receive-pack)$/.exec(c.req.path);
      if (!match) return c.text("Not found", 404);
      const [, target, attempt, operation] = match;
      const url = new URL(c.req.url);
      if (operation === "info/refs" ? c.req.method !== "GET" || url.search !== "?service=git-receive-pack"
        : c.req.method !== "POST" || url.search !== "") return c.text("Unsupported request", 400);
      const auth = c.req.header("authorization") ?? "";
      const encoded = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(auth)?.[1];
      const token = encoded ? /^run:([A-Za-z0-9_-]{43})$/.exec(Buffer.from(encoded, "base64").toString("utf8"))?.[1] : undefined;
      if (!token) { c.header("WWW-Authenticate", 'Basic realm="cloud-return"'); return c.text("Unauthorized", 401); }
      let grant;
      try { grant = await ports.grants.authorize(target!, attempt!, token, ports.now()); }
      catch { return c.text("Forbidden", 403); }
      const directory = ports.grants.directory(target!, attempt!);
      c.header("Cache-Control", "no-store");
      if (operation === "info/refs") {
        const bytes = await ports.receiver.advertise(directory, grant);
        return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/x-git-receive-pack-advertisement", "cache-control": "no-store" } });
      }
      if (c.req.header("content-type") !== "application/x-git-receive-pack-request"
        || c.req.header("content-encoding")) return c.text("Unsupported content", 415);
      const declared = c.req.header("content-length");
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > grant.maxPackBytes)) return c.text("Too large", 413);
      const reader = c.req.raw.body?.getReader();
      if (!reader) return c.text("Missing body", 400);
      const chunks: Buffer[] = [];
      let length = 0, expired = false;
      const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => { /* request already disconnected */ }); }, 60_000);
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > grant.maxPackBytes) { await reader.cancel(); return c.text("Too large", 413); }
          chunks.push(Buffer.from(part.value));
        }
      } finally { clearTimeout(timer); reader.releaseLock(); }
      if (expired) return c.text("Request timeout", 408);
      await ports.grants.authorize(target!, attempt!, token, ports.now());
      const bytes = await ports.receiver.receive(directory, grant, Buffer.concat(chunks));
      return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-store" } });
    } catch {
      // No exception detail (token, process arguments, local path) crosses this boundary.
      return c.text("Receive unavailable; reconcile before retry", 409);
    } finally { active--; }
  });
  return app;
}
