import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer, type Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { CfAccessVerifier, parseCfAccessConfig } from "../management/cf-access.js";
import { cloudGitIngress } from "./git-ingress.js";
import { GitRunGrants } from "./git-run-grant.js";
import { CloudGitReceiver } from "./git-receiver.js";

/** Deployment settings are required; no localhost bypass or unauthenticated fallback. */
export function cloudGitIngressSettings(env: NodeJS.ProcessEnv) {
  const root = env.CONCORDIA_CLOUD_GIT_ROOT;
  const host = env.CONCORDIA_CLOUD_GIT_PUBLIC_HOST;
  const portText = env.CONCORDIA_CLOUD_GIT_PORT ?? "";
  const access = parseCfAccessConfig(env.CONCORDIA_CLOUD_GIT_ACCESS_TEAM, env.CONCORDIA_CLOUD_GIT_ACCESS_AUD);
  if (!root || !isAbsolute(root) || !host || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/i.test(host)
    || !/^\d{1,5}$/.test(portText) || Number(portText) < 1024 || Number(portText) > 65535 || !access) {
    throw new Error("cloud_git_ingress_configuration_incomplete");
  }
  return { root, host, port: Number(portText), access };
}

export function startCloudGitIngress(env: NodeJS.ProcessEnv): Server {
  const settings = cloudGitIngressSettings(env);
  const app = cloudGitIngress({ publicHost: settings.host, access: new CfAccessVerifier(settings.access),
    grants: new GitRunGrants(settings.root), receiver: new CloudGitReceiver(), now: Date.now });
  // Only the local tunnel reaches this listener; forwarded identity is independently verified.
  const server = createServer(getRequestListener(app.fetch));
  server.requestTimeout = 65_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 40;
  server.listen(settings.port, "127.0.0.1");
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = startCloudGitIngress(process.env);
  let closing = false;
  const stop = (): void => {
    if (closing) return;
    closing = true;
    // Stop admitting requests; pending receive-pack processes have their own 60s bound.
    server.close();
    const timer = setTimeout(() => { server.closeAllConnections(); }, 70_000);
    timer.unref();
    server.once("close", () => {
      clearTimeout(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
