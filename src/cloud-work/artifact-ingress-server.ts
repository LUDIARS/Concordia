import { createServer, type Server } from "node:http";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { findTailscaleAddress, isTailscaleAddress } from "../management/remote-config.js";
import { ArtifactReceiver } from "./artifact-receiver.js";
import { artifactIngress } from "./artifact-ingress.js";
import { Hono } from "hono";
import { ObservationStore } from "../cloud-observation/store.js";
import { observationIngress } from "../cloud-observation/ingress.js";

export function artifactIngressSettings(env: NodeJS.ProcessEnv, address: () => string | null = findTailscaleAddress): { root: string; host: string; port: number } {
  const root = env.CONCORDIA_ARTIFACT_ROOT;
  const rawPort = env.CONCORDIA_ARTIFACT_PORT ?? "";
  const host = address();
  if (!root || !isAbsolute(root) || !/^[0-9]{1,5}$/.test(rawPort) || Number(rawPort) < 1024 || Number(rawPort) > 65535
    || !host || !isTailscaleAddress(host)) throw new Error("artifact_ingress_configuration_incomplete");
  return { root, host, port: Number(rawPort) };
}

export async function startArtifactIngress(env: NodeJS.ProcessEnv): Promise<Server> {
  const settings = artifactIngressSettings(env);
  const info = await lstat(settings.root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("artifact_root_invalid");
  const receiver = new ArtifactReceiver(settings.root);
  const observations = new ObservationStore(settings.root);
  const authority = `${settings.host}:${settings.port}`;
  const app = new Hono();
  app.get("/health", c => {
    if (c.req.header("host") !== authority || c.req.header("origin")) return c.text("Forbidden", 403);
    return c.json({ service: "concordia-cloud-artifact", ok: true, observations: 1 });
  });
  app.route("/observations", observationIngress(receiver, observations, authority));
  app.route("/", artifactIngress(receiver, authority));
  const server = createServer(getRequestListener(app.fetch));
  server.requestTimeout = 130_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  try { await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(settings.port, settings.host, () => { server.off("error", reject); resolve(); });
  }); } catch (error) { observations.close(); throw error; }
  server.once("close", () => observations.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startArtifactIngress(process.env);
  let closing = false;
  const stop = (): void => {
    if (closing) return;
    closing = true;
    server.close();
    const timer = setTimeout(() => server.closeAllConnections(), 135_000);
    timer.unref();
    server.once("close", () => { clearTimeout(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop); });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
